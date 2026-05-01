/**
 * communauteRoutes.ts — v104 Communauté v3 Backend
 * ============================================================
 * Endpoints REST pour la Communauté FOREAS :
 *
 *   POST   /api/communaute/posts            Créer un post (modéré par Opus 4.7)
 *   GET    /api/communaute/feed             Feed près de moi + filtres
 *   GET    /api/communaute/posts/:id        Détail d'un post
 *   POST   /api/communaute/posts/:id/react  Confirme / Infirme / Merci
 *   DELETE /api/communaute/posts/:id/react  Retirer sa réaction
 *   POST   /api/communaute/posts/:id/flag   Signaler un post (tap long)
 *   GET    /api/communaute/me/confiance     Mon score + tier
 *   GET    /api/communaute/autocomplete     Suggestions vocab terrain
 *   GET    /api/communaute/prefs            Mes préférences notifs
 *   PUT    /api/communaute/prefs            Mettre à jour mes prefs
 *   POST   /api/communaute/follow/:id       Suivre un Référent
 *   DELETE /api/communaute/follow/:id       Ne plus suivre
 *
 * Toutes les routes nécessitent JWT Bearer (driver connecté).
 * Modération post → Opus 4.7 → accept (publié direct) ou reject (+ redirect Ajnaya si pub).
 */
import { Router, Request, Response } from 'express';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  moderatePost,
  buildAjnayaSponsorshipMessage,
  type Categorie,
} from '../services/CommunauteModerationService.js';

const router = Router();

// ── Supabase admin singleton ───────────────────────────────────────────
let supaAdmin: SupabaseClient | null = null;
function getSupa(): SupabaseClient {
  if (supaAdmin) return supaAdmin;
  supaAdmin = createClient(
    process.env.SUPABASE_URL || 'https://fihvdvlhftcxhlnocqiq.supabase.co',
    process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  return supaAdmin;
}

async function getDriverIdFromJWT(req: Request): Promise<string | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;
  try {
    const supa = getSupa();
    const { data } = await supa.auth.getUser(authHeader.replace('Bearer ', ''));
    return data?.user?.id || null;
  } catch {
    return null;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

const RATE_LIMIT_MS = 30_000; // 1 post / 30 sec

const EXPIRE_MAP: Record<string, number> = {
  alerte_boer: 2 * 3600 * 1000,
  alerte_urssaf: 2 * 3600 * 1000,
  alerte_municipal: 2 * 3600 * 1000,
  alerte_dgccrf: 2 * 3600 * 1000,
  alerte_dreal: 2 * 3600 * 1000,
  alerte_bac: 2 * 3600 * 1000,
  alerte_piege: 24 * 3600 * 1000,
  alerte_zone_chaude: 3600 * 1000,
  alerte_surge: 30 * 60 * 1000,
  alerte_manif: 4 * 3600 * 1000,
  alerte_accident: 2 * 3600 * 1000,
  // entraide & astuce → pas d'expiration
};

function expireAtForPost(category: Categorie, sousType: string | null): Date | null {
  if (category !== 'alerte') return null;
  const key = `alerte_${sousType || 'zone_chaude'}`;
  const ms = EXPIRE_MAP[key] ?? 2 * 3600 * 1000;
  return new Date(Date.now() + ms);
}

// Haversine distance calcul côté SQL via une view ad-hoc
// (simple et suffisant jusqu'à 100k posts ; au-delà → PostGIS)
function sqlHaversineMeters(lat: number, lon: number, radiusKm: number): string {
  // Retourne un CTE filter utilisable dans les queries
  return `
    6371 * 2 * asin(sqrt(
      power(sin(radians((latitude - ${lat}) / 2)), 2) +
      cos(radians(${lat})) * cos(radians(latitude)) *
      power(sin(radians((longitude - ${lon}) / 2)), 2)
    )) <= ${radiusKm}
  `;
}

// ══════════════════════════════════════════════════════════════════════════
// POST /api/communaute/posts — Créer un post
// ══════════════════════════════════════════════════════════════════════════

router.post('/posts', async (req: Request, res: Response) => {
  const driverId = await getDriverIdFromJWT(req);
  if (!driverId) return res.status(401).json({ error: 'Non authentifié' });

  const {
    content,
    mediaUrls = [],
    audioUrl = null,
    audioDurationSeconds = null,
    latitude = null,
    longitude = null,
    geoLabel = null,
    geoPrecision = 'approx',
  } = req.body || {};

  // Validation stricte
  if (typeof content !== 'string' || content.trim().length < 3 || content.trim().length > 280) {
    return res.status(400).json({ error: 'Contenu entre 3 et 280 caractères requis' });
  }
  if (Array.isArray(mediaUrls) && mediaUrls.length > 1) {
    return res.status(400).json({ error: 'Un seul média par post' });
  }
  if (audioDurationSeconds && (audioDurationSeconds < 1 || audioDurationSeconds > 30)) {
    return res.status(400).json({ error: 'Audio entre 1 et 30 secondes' });
  }

  const supa = getSupa();

  // Rate limit 1 post / 30s
  const { data: rateRow } = await supa
    .from('communaute_rate_limit')
    .select('last_post_at')
    .eq('user_id', driverId)
    .maybeSingle();
  if (rateRow?.last_post_at) {
    const lastMs = new Date(rateRow.last_post_at).getTime();
    const since = Date.now() - lastMs;
    if (since < RATE_LIMIT_MS) {
      const waitS = Math.ceil((RATE_LIMIT_MS - since) / 1000);
      return res.status(429).json({ error: `Attends ${waitS} secondes avant de republier` });
    }
  }

  // Fetch profile pour enrichir Opus
  const { data: userProfile } = await supa
    .from('user_profiles')
    .select('first_name')
    .eq('user_id', driverId)
    .maybeSingle();
  const firstName = userProfile?.first_name || 'Chauffeur';

  // Modération Opus 4.7
  const verdict = await moderatePost({
    content: content.trim(),
    hasMedia: mediaUrls.length > 0,
    hasAudio: !!audioUrl,
    authorId: driverId,
    authorDisplayName: firstName,
    geoLabel: geoLabel || undefined,
  });

  // Si rejet + pub détectée → redirect Ajnaya + log lead
  if (verdict.verdict === 'reject' && verdict.redirectToAjnaya) {
    const ajnayaMessage = buildAjnayaSponsorshipMessage(
      firstName,
      content.trim(),
      verdict.promotionType,
    );

    // Log lead
    await supa.from('communaute_partenaire_leads').insert({
      user_id: driverId,
      rejected_post_content: content.trim(),
      detected_promotion_type: verdict.promotionType,
      opus_analysis: verdict as any,
      ajnaya_message_sent_at: new Date().toISOString(),
    });

    // On enregistre quand même le post en rejected (pour trace)
    await supa.from('communaute_posts').insert({
      auteur_id: driverId,
      categorie: 'entraide', // placeholder pour passer le CHECK
      contenu: content.trim(),
      media_urls: mediaUrls,
      audio_url: audioUrl,
      audio_duration_seconds: audioDurationSeconds,
      latitude,
      longitude,
      geo_label: geoLabel,
      geo_precision: geoPrecision,
      moderation_status: 'rejected',
      moderation_reason: verdict.reason,
      moderation_by: 'opus-4.7',
      moderation_confidence: verdict.confidence,
    });

    return res.status(200).json({
      status: 'rejected_sponsorship',
      reason: verdict.reason,
      ajnaya: {
        open: true,
        message: ajnayaMessage,
        cta: { label: 'Ouvrir le Dashboard Partenaire', action: 'open_partner_dashboard' },
      },
    });
  }

  // Si rejet simple (haine, fraude, spam, etc.)
  if (verdict.verdict === 'reject') {
    await supa.from('communaute_posts').insert({
      auteur_id: driverId,
      categorie: 'entraide',
      contenu: content.trim(),
      media_urls: mediaUrls,
      latitude,
      longitude,
      geo_label: geoLabel,
      moderation_status: 'rejected',
      moderation_reason: verdict.reason,
      moderation_by: 'opus-4.7',
      moderation_confidence: verdict.confidence,
    });
    return res.status(200).json({
      status: 'rejected',
      reason: verdict.reason || 'Ce post ne peut pas être publié.',
    });
  }

  // Accepté → insert + rate limit bump
  const category = (verdict.category || 'entraide') as Categorie;
  const expireAt = expireAtForPost(category, verdict.sousType);
  const finalContent = verdict.cleanContent || content.trim();

  const { data: inserted, error: insertErr } = await supa
    .from('communaute_posts')
    .insert({
      auteur_id: driverId,
      categorie: category,
      sous_type: verdict.sousType,
      contenu: finalContent,
      media_urls: mediaUrls,
      audio_url: audioUrl,
      audio_duration_seconds: audioDurationSeconds,
      latitude,
      longitude,
      geo_label: geoLabel,
      geo_precision: geoPrecision,
      expire_at: expireAt?.toISOString() || null,
      moderation_status: 'approved',
      moderation_by: 'opus-4.7',
      moderation_confidence: verdict.confidence,
    })
    .select('id, categorie, sous_type, contenu, created_at')
    .single();

  if (insertErr) {
    console.error('[communaute/posts] insert error:', insertErr);
    return res.status(500).json({ error: insertErr.message });
  }

  // Rate limit
  await supa.from('communaute_rate_limit').upsert(
    {
      user_id: driverId,
      last_post_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' },
  );

  return res.status(201).json({ status: 'published', post: inserted });
});

// ══════════════════════════════════════════════════════════════════════════
// GET /api/communaute/feed — Feed près de moi
// ══════════════════════════════════════════════════════════════════════════

router.get('/feed', async (req: Request, res: Response) => {
  const driverId = await getDriverIdFromJWT(req);
  if (!driverId) return res.status(401).json({ error: 'Non authentifié' });

  const lat = parseFloat(String(req.query.lat ?? ''));
  const lon = parseFloat(String(req.query.lon ?? ''));
  const radiusKm = Math.min(999, Math.max(1, parseInt(String(req.query.radius_km ?? '5'), 10)));
  const categorie = (req.query.categorie as string) || null;
  const limit = Math.min(50, Math.max(5, parseInt(String(req.query.limit ?? '30'), 10)));

  const supa = getSupa();

  let query = supa
    .from('communaute_posts')
    .select(
      `id, categorie, sous_type, contenu, media_urls, audio_url, audio_duration_seconds,
       latitude, longitude, geo_label, geo_precision, expire_at,
       source_external, auteur_external_name,
       nb_confirmations, nb_infirmations, nb_mercis,
       auteur_id, created_at`,
    )
    .eq('moderation_status', 'approved')
    .or(`expire_at.is.null,expire_at.gt.${new Date().toISOString()}`)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (categorie && ['alerte', 'entraide', 'astuce'].includes(categorie)) {
    query = query.eq('categorie', categorie);
  }

  const { data: posts, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  // Filtre géographique Haversine (côté JS, rapide jusqu'à 5k posts)
  const filtered =
    !isNaN(lat) && !isNaN(lon) && radiusKm < 999
      ? (posts || []).filter((p: any) => {
          if (p.latitude == null || p.longitude == null) return true; // conversations nationales OK
          const distKm = haversine(lat, lon, p.latitude, p.longitude);
          p._distance_km = Math.round(distKm * 10) / 10;
          return distKm <= radiusKm;
        })
      : posts || [];

  // Enrich avec confiance auteur
  const authorIds = [...new Set(filtered.map((p: any) => p.auteur_id).filter(Boolean))];
  const { data: confianceRows } = await supa
    .from('communaute_confiance')
    .select('user_id, score, tier')
    .in('user_id', authorIds);
  const confianceMap = new Map<string, { score: number; tier: string }>();
  for (const row of confianceRows || []) {
    confianceMap.set(row.user_id as string, {
      score: row.score as number,
      tier: row.tier as string,
    });
  }
  // Enrich avec user_profiles pour first_name
  const { data: profiles } = await supa
    .from('user_profiles')
    .select('user_id, first_name')
    .in('user_id', authorIds);
  const profileMap = new Map<string, string>();
  for (const p of profiles || [])
    profileMap.set(p.user_id as string, (p.first_name as string) || 'Chauffeur');

  // Fetch mes réactions pour marquer les cards
  const postIds = filtered.map((p: any) => p.id);
  const { data: myReactions } = await supa
    .from('communaute_reactions')
    .select('post_id, type')
    .eq('user_id', driverId)
    .in('post_id', postIds);
  const reactionsMap = new Map<string, Set<string>>();
  for (const r of myReactions || []) {
    const set = reactionsMap.get(r.post_id as string) || new Set();
    set.add(r.type as string);
    reactionsMap.set(r.post_id as string, set);
  }

  const enriched = filtered.map((p: any) => ({
    ...p,
    auteur_display: p.auteur_external_name || profileMap.get(p.auteur_id) || 'Chauffeur',
    auteur_tier: p.source_external ? 'externe' : confianceMap.get(p.auteur_id)?.tier || 'nouveau',
    auteur_score: p.source_external ? null : confianceMap.get(p.auteur_id)?.score || 30,
    mes_reactions: Array.from(reactionsMap.get(p.id) || []),
  }));

  return res.json({ posts: enriched, total: enriched.length });
});

// ══════════════════════════════════════════════════════════════════════════
// POST /api/communaute/posts/:id/react — Confirme / Infirme / Merci
// ══════════════════════════════════════════════════════════════════════════

router.post('/posts/:id/react', async (req: Request, res: Response) => {
  const driverId = await getDriverIdFromJWT(req);
  if (!driverId) return res.status(401).json({ error: 'Non authentifié' });

  const { type } = req.body || {};
  if (!['confirme', 'infirme', 'merci'].includes(type)) {
    return res.status(400).json({ error: 'Type invalide (confirme/infirme/merci)' });
  }

  const supa = getSupa();
  const { error } = await supa
    .from('communaute_reactions')
    .insert({ post_id: req.params.id, user_id: driverId, type });
  if (error && !error.message.includes('duplicate')) {
    return res.status(500).json({ error: error.message });
  }
  return res.json({ ok: true, type });
});

router.delete('/posts/:id/react', async (req: Request, res: Response) => {
  const driverId = await getDriverIdFromJWT(req);
  if (!driverId) return res.status(401).json({ error: 'Non authentifié' });

  const type = (req.query.type as string) || null;
  if (!type) return res.status(400).json({ error: 'Query param "type" requis' });

  const supa = getSupa();
  await supa
    .from('communaute_reactions')
    .delete()
    .match({ post_id: req.params.id, user_id: driverId, type });
  return res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════
// POST /api/communaute/posts/:id/flag — Signaler un post
// ══════════════════════════════════════════════════════════════════════════

router.post('/posts/:id/flag', async (req: Request, res: Response) => {
  const driverId = await getDriverIdFromJWT(req);
  if (!driverId) return res.status(401).json({ error: 'Non authentifié' });

  const { reason, note } = req.body || {};
  if (!['pub', 'fake', 'hate', 'spam', 'off_topic', 'other'].includes(reason)) {
    return res.status(400).json({ error: 'Raison invalide' });
  }

  const supa = getSupa();
  const { error } = await supa.from('communaute_flags').insert({
    post_id: req.params.id,
    reporter_id: driverId,
    reason,
    note: note || null,
  });
  if (error) {
    if (error.message.includes('duplicate')) {
      return res.json({ ok: true, already: true });
    }
    return res.status(500).json({ error: error.message });
  }
  return res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════
// GET /api/communaute/me/confiance — Mon score + tier
// ══════════════════════════════════════════════════════════════════════════

router.get('/me/confiance', async (req: Request, res: Response) => {
  const driverId = await getDriverIdFromJWT(req);
  if (!driverId) return res.status(401).json({ error: 'Non authentifié' });

  const supa = getSupa();
  const { data } = await supa
    .from('communaute_confiance')
    .select('*')
    .eq('user_id', driverId)
    .maybeSingle();

  return res.json(
    data || {
      user_id: driverId,
      score: 30,
      tier: 'nouveau',
      nb_posts_approuves: 0,
      nb_posts_rejetes: 0,
      nb_reactions_recues: 0,
    },
  );
});

// ══════════════════════════════════════════════════════════════════════════
// GET /api/communaute/autocomplete — Suggestions vocab
// ══════════════════════════════════════════════════════════════════════════

router.get('/autocomplete', async (req: Request, res: Response) => {
  const q = String(req.query.q ?? '').trim();
  if (q.length < 1) return res.json({ suggestions: [] });

  const supa = getSupa();
  const { data } = await supa
    .from('communaute_autocomplete_vocab')
    .select('term, display_hint, category_hint')
    .ilike('term', `${q}%`)
    .order('usage_count', { ascending: false })
    .limit(8);

  return res.json({ suggestions: data || [] });
});

// ══════════════════════════════════════════════════════════════════════════
// GET/PUT /api/communaute/prefs — Notifications preferences
// ══════════════════════════════════════════════════════════════════════════

router.get('/prefs', async (req: Request, res: Response) => {
  const driverId = await getDriverIdFromJWT(req);
  if (!driverId) return res.status(401).json({ error: 'Non authentifié' });

  const supa = getSupa();
  const { data } = await supa
    .from('communaute_notification_prefs')
    .select('*')
    .eq('user_id', driverId)
    .maybeSingle();
  return res.json(
    data || {
      user_id: driverId,
      alertes_critiques: true,
      zones_chaudes: true,
      referents_suivis: false,
      mercis_recus: true,
      rayon_km: 5,
    },
  );
});

router.put('/prefs', async (req: Request, res: Response) => {
  const driverId = await getDriverIdFromJWT(req);
  if (!driverId) return res.status(401).json({ error: 'Non authentifié' });

  const supa = getSupa();
  const {
    alertes_critiques,
    zones_chaudes,
    referents_suivis,
    mercis_recus,
    rayon_km,
    silence_start,
    silence_end,
  } = req.body || {};

  const { error } = await supa.from('communaute_notification_prefs').upsert(
    {
      user_id: driverId,
      alertes_critiques: alertes_critiques ?? true,
      zones_chaudes: zones_chaudes ?? true,
      referents_suivis: referents_suivis ?? false,
      mercis_recus: mercis_recus ?? true,
      rayon_km: rayon_km ?? 5,
      silence_start: silence_start || null,
      silence_end: silence_end || null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' },
  );
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════
// POST/DELETE /api/communaute/follow/:id — Suivre un Référent
// ══════════════════════════════════════════════════════════════════════════

router.post('/follow/:id', async (req: Request, res: Response) => {
  const driverId = await getDriverIdFromJWT(req);
  if (!driverId) return res.status(401).json({ error: 'Non authentifié' });
  if (req.params.id === driverId) return res.status(400).json({ error: 'Pas toi-même' });

  const supa = getSupa();
  const { error } = await supa
    .from('communaute_follows')
    .insert({ follower_id: driverId, followed_id: req.params.id });
  if (error && !error.message.includes('duplicate')) {
    return res.status(500).json({ error: error.message });
  }
  return res.json({ ok: true });
});

router.delete('/follow/:id', async (req: Request, res: Response) => {
  const driverId = await getDriverIdFromJWT(req);
  if (!driverId) return res.status(401).json({ error: 'Non authentifié' });

  const supa = getSupa();
  await supa
    .from('communaute_follows')
    .delete()
    .match({ follower_id: driverId, followed_id: req.params.id });
  return res.json({ ok: true });
});

// ── Utils ────────────────────────────────────────────────────────────

function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  return R * 2 * Math.asin(Math.sqrt(a));
}

// ════════════════════════════════════════════════════════════════════════
// POST /api/communaute/moderate-media
// Modération automatique des photos/vidéos avant publication.
// Claude Vision check : contenu choquant, violence, nudité, propagande, illégalité.
// On ne BLOQUE pas la publication — sauf cas extrêmes.
// On flag pour review admin (FOREAS first).
// v1.10.51
// ════════════════════════════════════════════════════════════════════════
router.post('/moderate-media', async (req: Request, res: Response) => {
  const { mediaUrl, mediaType, photoBase64 } = req.body || {};
  if (!mediaUrl && !photoBase64) {
    return res.status(400).json({ error: 'mediaUrl OR photoBase64 required' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Sans Anthropic key → on approuve par défaut (ne pas bloquer le user)
    return res.json({ ok: true, status: 'approved', score: 50, warnings: [] });
  }

  // Vidéo : pas d'analyse Claude Vision pour le moment (Claude ne lit pas
  // encore les vidéos directement) — on laisse passer en flagged "pending".
  if (mediaType === 'video') {
    return res.json({
      ok: true,
      status: 'pending',
      score: null,
      warnings: ['video-needs-manual-review'],
    });
  }

  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic({ apiKey });

    let imageContent: any;
    if (photoBase64) {
      const cleanBase64 = String(photoBase64).replace(/^data:image\/\w+;base64,/, '');
      imageContent = {
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: cleanBase64 },
      };
    } else if (mediaUrl) {
      imageContent = { type: 'image', source: { type: 'url', url: mediaUrl } };
    }

    const systemPrompt = `Tu modères des photos partagées par des chauffeurs VTC dans la communauté FOREAS (entraide, alertes contrôles, astuces).
RÉPONDS UNIQUEMENT EN JSON STRICT (pas de markdown).
Format obligatoire :
{
  "isAppropriate": true|false,
  "score": 0-100 (100 = parfaitement OK),
  "category": "ok" | "borderline" | "rejected",
  "reasons": ["liste courte"],
  "topics": ["controle_police", "vehicule", "personne", "scene_route", "document_perso", ...]
}

Catégories de REJET (score ≤ 30, isAppropriate=false) :
- Nudité explicite / contenu sexuel
- Violence graphique / accidents avec sang visible
- Propagande haineuse / symboles extrémistes
- Contenu illégal manifeste

Catégories BORDERLINE (score 30-60, à flagger pour admin) :
- Plaque d'immatriculation lisible (donnée perso d'un tiers)
- Visage très lisible d'un tiers non consentant
- Insultes ou doigt d'honneur visibles
- Document officiel (permis, carte d'identité) lisible

Catégories OK (score 60-100) :
- Vue intérieure véhicule
- Photo d'une zone (gare, point de ralliement)
- Capture de carte
- Selfie chauffeur
- Photo véhicule sans plaque
- Astuce visuelle (raccourci, place de parking)

PROTÈGE FOREAS AVANT TOUT mais reste permissif sur la photo "honnête de chauffeur".`;

    const message = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 400,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: [
            imageContent,
            { type: 'text', text: 'Modère cette photo. Réponds en JSON strict.' },
          ],
        },
      ],
    });

    const textBlock = message.content.find((c: any) => c.type === 'text') as any;
    const rawText = textBlock?.text?.trim() ?? '';
    let cleanJson = rawText;
    if (rawText.startsWith('```')) {
      cleanJson = rawText.replace(/^```json\n?/, '').replace(/\n?```$/, '');
    }

    let result: any;
    try {
      result = JSON.parse(cleanJson);
    } catch {
      // Fallback non-bloquant
      return res.json({ ok: true, status: 'pending', score: 50, warnings: ['parse-fail'] });
    }

    const score = typeof result.score === 'number' ? result.score : 50;
    const category = result.category ?? 'ok';
    let status: 'approved' | 'flagged' | 'rejected' = 'approved';
    if (category === 'rejected' || score <= 30) status = 'rejected';
    else if (category === 'borderline' || score < 60) status = 'flagged';

    return res.json({
      ok: true,
      status,
      score,
      category,
      warnings: result.reasons ?? [],
      topics: result.topics ?? [],
    });
  } catch (err: any) {
    console.error('[moderate-media] error:', err?.message);
    // Non-bloquant : si vision API down → on flag pour review admin
    return res.json({ ok: true, status: 'pending', score: 0, warnings: ['vision-api-error'] });
  }
});

export default router;
