/**
 * ClientFinderService — Cherche des clients pros per-driver
 * Ajnaya2026v86
 *
 * Flux:
 *   1. loadEligibleProspects()  — places_directory sans email envoyé récent
 *   2. generateOutreach()       — Claude Haiku génère email personnalisé
 *   3. sendEmail()              — Resend envoie l'email
 *   4. recordOutreach()         — log dans pieuvre_b2b_hunter_log + client_finder_performance
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type {
  PlaceDirectory,
  ClientFinderSettings,
  OutreachRequest,
  OutreachResult,
  FinderRunResult,
} from '../types/clientFinder.js';
import { checkWarmupStatus } from './EmailWarmupManager.js';
import { isEmailOptedOut, generateOptoutToken } from './OptoutService.js';
import { pickBestVariant, renderTemplate, incrementVariantSent } from './VariantSelectorService.js';

// ── Lazy Supabase (service role) ──────────────────────────────────
let _supa: SupabaseClient | null = null;
function getSupa(): SupabaseClient {
  if (_supa) return _supa;
  const url = process.env.SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  _supa = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  return _supa;
}

function getParisToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date()); // Format: YYYY-MM-DD
}

// ── v87.1 — Variant DB first (Thompson sampling) ─────────────────
async function generateFromVariant(
  req: OutreachRequest,
): Promise<(OutreachResult & { variantId?: string }) | null> {
  try {
    const variant = await pickBestVariant('INITIAL', 'fr');
    if (!variant) return null;

    const vars: Record<string, string> = {
      place_name: req.place.name,
      place_type: req.place.placeType,
      city: req.place.city,
      driver_name: req.driverName,
      contact_name: req.place.contactName ?? '',
    };

    const subject = renderTemplate(variant.subject_template, vars);
    const body = renderTemplate(variant.body_template, vars);
    return {
      subject,
      body,
      model: `variant:${variant.variant_name}`,
      variantId: variant.id,
    };
  } catch (err: any) {
    console.warn('[ClientFinder] generateFromVariant error:', err?.message);
    return null;
  }
}

// ── Enrichissement contexte chauffeur depuis drivers + user_profiles ─────
type EnrichedDriverCtx = {
  full_name: string;
  first_name: string;
  city: string;
  vehicle_category: string | null;
  rating: number | null;
  total_rides: number;
  years_active: number | null;
  vtc_card_verified: boolean;
  booking_url: string | null;
  plaquette_url: string | null;
};

const SITE_BASE = process.env.FOREAS_SITE_URL || 'https://foreas.xyz';

async function buildEnrichedDriverContext(
  driverName: string,
  driverIdHint?: string,
): Promise<EnrichedDriverCtx | null> {
  try {
    const supa = getSupa();
    let driver: any = null;
    if (driverIdHint) {
      const { data } = await supa
        .from('drivers')
        .select(
          'id, first_name, last_name, name, total_rides, average_rating, total_earnings, created_at, referral_code, vtc_card_verified, auth_user_id',
        )
        .eq('id', driverIdHint)
        .maybeSingle();
      driver = data;
    }
    if (!driver) {
      const { data } = await supa
        .from('drivers')
        .select(
          'id, first_name, last_name, name, total_rides, average_rating, total_earnings, created_at, referral_code, vtc_card_verified, auth_user_id',
        )
        .eq('name', driverName)
        .maybeSingle();
      driver = data;
    }
    if (!driver) return null;
    let profile: any = null;
    if (driver.auth_user_id) {
      const { data } = await supa
        .from('user_profiles')
        .select('first_name, city_slug, vehicle_category')
        .eq('user_id', driver.auth_user_id)
        .maybeSingle();
      profile = data;
    }
    const yearsActive = driver.created_at
      ? Math.max(
          1,
          Math.floor((Date.now() - new Date(driver.created_at).getTime()) / (365 * 86400000)),
        )
      : null;
    const slug = driver.referral_code || null;
    return {
      full_name:
        driver.name || `${driver.first_name || ''} ${driver.last_name || ''}`.trim() || driverName,
      first_name: driver.first_name || profile?.first_name || driverName.split(' ')[0],
      city: profile?.city_slug || 'paris',
      vehicle_category: profile?.vehicle_category || null,
      rating: driver.average_rating ? Number(driver.average_rating) : null,
      total_rides: driver.total_rides || 0,
      years_active: yearsActive,
      vtc_card_verified: !!driver.vtc_card_verified,
      booking_url: slug ? `${SITE_BASE}/c/${slug}` : null,
      plaquette_url: slug ? `${SITE_BASE}/c/${slug}/plaquette.pdf` : null,
    };
  } catch (err: any) {
    console.warn('[ClientFinder] buildEnrichedDriverContext error:', err?.message);
    return null;
  }
}

// ── Saison + pic d'activité par mois (FR uniquement, MVP) ─────────────────
function getSeasonContext() {
  const m = new Date().getMonth();
  const monthsLabels = [
    'janvier',
    'février',
    'mars',
    'avril',
    'mai',
    'juin',
    'juillet',
    'août',
    'septembre',
    'octobre',
    'novembre',
    'décembre',
  ];
  let season = 'automne';
  let peakHint = '';
  if (m === 11 || m === 0 || m === 1) {
    season = 'hiver';
    peakHint =
      "fêtes de fin d'année, Salon de l'Auto, Fashion Week haute couture, sapins, soirées corporate";
  } else if (m >= 2 && m <= 4) {
    season = 'printemps';
    peakHint =
      'salons professionnels, mariages premières dates, Roland-Garros (mai-juin), tour des ambassades';
  } else if (m >= 5 && m <= 7) {
    season = 'été';
    peakHint =
      'mariages, Tour de France, festivals (Cannes mai/Avignon juillet), arrivées familles aux résidences hôtelières';
  } else {
    season = 'automne';
    peakHint = "rentrée business, Mondial de l'Auto (oct), Fashion Week septembre, salons MICE";
  }
  return { season, month_label: monthsLabels[m], peak_hint: peakHint };
}

// ── Anthropic Opus 4.7 — outreach B2B premium (fallback si pas de variante) ─
async function generateOutreachEmail(
  req: OutreachRequest,
  driverIdHint?: string,
): Promise<OutreachResult> {
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const familyContext: Record<string, string> = {
    HOSPITALITY:
      'hôtels et résidences de prestige (clientèle internationale, transferts aéroport, demandes nominatives)',
    HIGH_INCOME:
      'golfs, clubs privés et banques privées (membres récurrents, ponctualité critique, discrétion absolue)',
    EVENT:
      'salles de congrès, concerts, mariages (pic ponctuel, invités VIP, image de marque exposée)',
  };

  const contactSalutation =
    req.place.contactTitle && req.place.contactName
      ? `${req.place.contactTitle} ${req.place.contactName}`
      : req.place.contactName
        ? req.place.contactName
        : 'Madame, Monsieur';

  // Enrichissement chauffeur depuis Supabase (vraies données)
  const enriched = await buildEnrichedDriverContext(req.driverName, driverIdHint);
  const season = getSeasonContext();

  const driverBlock = enriched
    ? `Nom complet : ${enriched.full_name}
Prénom : ${enriched.first_name}
Ville d'activité : ${enriched.city}
Véhicule : ${enriched.vehicle_category || 'berline standing'}
Expérience : ${enriched.years_active ? enriched.years_active + ' an' + (enriched.years_active > 1 ? 's' : '') : 'plusieurs années'} d'activité VTC
Carte VTC : ${enriched.vtc_card_verified ? 'vérifiée et à jour' : 'en cours de vérification'}
Bilan : ${enriched.total_rides} courses effectuées${enriched.rating ? ', note moyenne ' + enriched.rating.toFixed(1) + '/5' : ''}
${enriched.booking_url ? 'Page de réservation directe : ' + enriched.booking_url : ''}
${enriched.plaquette_url ? 'Plaquette PDF (à mentionner en pièce jointe ou lien) : ' + enriched.plaquette_url : ''}`
    : `Nom : ${req.driverName}
Présentation : ${req.driverPresentation || "chauffeur VTC professionnel parisien avec plusieurs années d'expérience"}`;

  const systemPrompt = `Tu es un assistant de rédaction premium pour un chauffeur VTC indépendant en France. Tu écris à des établissements haut de gamme (hôtels 4-5 étoiles, golfs privés, salles de congrès, banques privées) qui valorisent fiabilité, ponctualité et discrétion.

PRINCIPES :
- Ton : pro, direct, chaleureux, jamais commercial bas-de-gamme.
- Forme : 5-7 lignes max corps (pas plus). Pas de tirets, pas de bullet points, pas de majuscules excessives.
- Substance : proposer un partenariat de transport pour leurs clients / membres / invités.
- Différenciation FOREAS : chauffeur stable INDIVIDUEL (toujours le même chauffeur) qui mémorise les préférences clients, vs marketplace impersonnelle (Uber/Bolt). Service tracé via app FOREAS — chaque trajet enregistré, facturation automatique, garantie ponctualité, historique consultable côté client.
- CTA : un seul, simple. 15min de visio OU course-test gratuite OU lien direct vers la page de réservation. Pas de force, juste une porte ouverte.
- Si page de réservation fournie → l'inclure naturellement dans le corps (pas en signature seule).
- Si plaquette URL fournie → la mentionner ("plaquette détaillée jointe / dispo en lien").

INTERDITS STRICTS :
- Mots galvaudés : "révolutionnaire", "leader", "exclusif" en surdose, "à votre service" (cliché).
- Promesses non-tenables ("100% disponible", "tarif imbattable").
- Jargon corporate vide ("synergie", "win-win", "à 360°").
- Plus d'un point d'exclamation.
- Sujet "Service de transport" générique → toujours nommer le destinataire ou créer une accroche concrète.

ADAPTATION SAISONNIÈRE :
Tu prends en compte la saison courante pour rendre l'email pertinent au moment où il arrive (pic d'activité, événements régionaux, etc.).`;

  const userPrompt = `Rédige un email de démarchage B2B pour ce chauffeur VTC indépendant.

CHAUFFEUR :
${driverBlock}

DESTINATAIRE :
- Établissement : ${req.place.name}
- Type : ${req.place.placeType}
- Catégorie : ${familyContext[req.place.placeTypeFamily] || req.place.placeTypeFamily}
- Adresse : ${req.place.address}, ${req.place.city}
- Salutation à utiliser : ${contactSalutation}

CONTEXTE TEMPOREL :
- Saison : ${season.season} (${season.month_label})
- Pics d'activité typiques en cette période : ${season.peak_hint}

MISSION :
Rédige un email de premier contact, pertinent par rapport à la saison ET au type d'établissement.
Sujet (max 60 chars) : nominatif si possible (utilise le nom de l'établissement), pas générique.
Corps (5-7 lignes max) :
1. Accroche concrète (une observation pertinente sur leur activité ou la saison)
2. Présentation rapide du chauffeur (1 phrase chiffrée s'il y a des stats, ou expérience)
3. Proposition de valeur centrée sur leur bénéfice (pas le tien)
4. CTA simple : ${enriched?.booking_url ? 'lien direct vers ' + enriched.booking_url + ' OU 15min de visio' : '15min de visio OU course-test gratuite'}
5. Signature courte

Format de ta réponse (JSON strict uniquement) :
{
  "subject": "...",
  "body": "Corps avec salutation + corps + signature"
}`;

  const msg = await client.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 600,
    messages: [{ role: 'user', content: userPrompt }],
    system: systemPrompt,
  });

  const text = (msg.content[0] as any).text as string;
  try {
    const parsed = JSON.parse(text.replace(/```json\n?|```\n?/g, '').trim());
    return { subject: parsed.subject, body: parsed.body, model: 'claude-opus-4-7' };
  } catch {
    return {
      subject: `Partenariat transport — ${req.place.name}`,
      body: text,
      model: 'claude-opus-4-7',
    };
  }
}

// ── Resend email sender ───────────────────────────────────────────
async function sendEmailViaResend(
  logId: string,
  to: string,
  subject: string,
  body: string,
  _fromName: string,
): Promise<{ id: string; from: string }> {
  const { Resend } = await import('resend');
  const { buildFromHeader } = await import('./ThreadAddressing.js');
  const resend = new Resend(process.env.RESEND_API_KEY);

  const from = buildFromHeader(logId);

  const result = await resend.emails.send({
    from,
    to,
    subject,
    text: body,
    headers: {
      'X-FOREAS-Source': 'client-finder',
      'X-FOREAS-Log-Id': logId,
    },
  });

  if (result.error) {
    throw new Error(`Resend error: ${result.error.message}`);
  }
  return { id: result.data!.id, from };
}

// ── Charger les settings chauffeur ───────────────────────────────
async function loadDriverSettings(driverId: string): Promise<ClientFinderSettings | null> {
  const supa = getSupa();
  const { data } = await supa
    .from('client_finder_settings')
    .select('*')
    .eq('driver_id', driverId)
    .single();
  return data as ClientFinderSettings | null;
}

// ── Compter les envois du jour ────────────────────────────────────
async function countTodaySent(driverId: string): Promise<number> {
  const supa = getSupa();
  const { count } = await supa
    .from('pieuvre_b2b_hunter_log')
    .select('*', { count: 'exact', head: true })
    .eq('driver_id', driverId)
    .gte('outreach_sent_at', getParisToday());
  return count || 0;
}

// ── Charger prospects éligibles ───────────────────────────────────
async function loadEligibleProspects(
  driverId: string,
  settings: ClientFinderSettings,
  limit: number,
): Promise<PlaceDirectory[]> {
  const supa = getSupa();

  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const { data: alreadySent } = await supa
    .from('pieuvre_b2b_hunter_log')
    .select('place_directory_id')
    .eq('driver_id', driverId)
    .gte('outreach_sent_at', cutoff)
    .not('place_directory_id', 'is', null);

  const excludedIds = (alreadySent || []).map((r: any) => r.place_directory_id).filter(Boolean);

  let query = supa
    .from('places_directory')
    .select('*')
    .in('place_type_family', settings.target_families)
    .eq('city', settings.city_slug)
    .not('contact_email', 'is', null)
    .order('quality_score', { ascending: false })
    .limit(limit + 5);

  if (excludedIds.length > 0) {
    query = query.not('id', 'in', `(${excludedIds.join(',')})`);
  }

  const { data } = await query;
  return ((data || []) as PlaceDirectory[]).slice(0, limit);
}

// ── Créer log + thread (appelé AVANT l'envoi pour avoir un logId déterministe) ──
async function createLogAndThread(
  driverId: string,
  place: PlaceDirectory,
): Promise<{ logId: string; threadId: string }> {
  const supa = getSupa();
  const now = new Date().toISOString();

  // 1. Insérer le log — on laisse Postgres générer l'ID puis on le récupère
  //    (gen_random_uuid() côté DB → on lit le retour)
  const { data: logRow, error: logErr } = await supa
    .from('pieuvre_b2b_hunter_log')
    .insert({
      driver_id: driverId,
      business_name: place.name,
      business_type: place.place_type,
      business_address: place.address,
      target_name: place.name,
      contact_email: place.contact_email,
      contact_address: place.contact_email,
      detected_at: now,
      contacted_at: now,
      status: 'CONTACTED',
      place_directory_id: place.id,
    })
    .select('id')
    .single();

  if (logErr || !logRow) {
    throw new Error(`Failed to insert hunter_log: ${logErr?.message ?? 'no row returned'}`);
  }

  const logId = (logRow as any).id as string;

  // 2. Insérer le thread — un thread par log
  const { data: threadRow, error: threadErr } = await supa
    .from('finder_email_threads')
    .insert({
      log_id: logId,
      driver_id: driverId,
      place_id: place.id,
      thread_subject: '', // rempli juste après l'envoi
      status: 'OPEN',
      messages_count: 0,
      last_direction: 'OUT',
    })
    .select('id')
    .single();

  if (threadErr || !threadRow) {
    throw new Error(`Failed to insert thread: ${threadErr?.message ?? 'no row returned'}`);
  }

  return { logId, threadId: (threadRow as any).id };
}

// ── Enregistrer l'outreach (après envoi) ──────────────────────────
async function recordOutreach(
  driverId: string,
  threadId: string,
  place: PlaceDirectory,
  outreach: OutreachResult,
  fromHeader: string,
  resendEmailId: string,
): Promise<void> {
  const supa = getSupa();
  const now = new Date().toISOString();

  // Logger le message initial dans finder_email_messages
  await supa.from('finder_email_messages').insert({
    thread_id: threadId,
    direction: 'OUT',
    sequence_type: 'INITIAL',
    from_email: fromHeader,
    to_email: place.contact_email,
    subject: outreach.subject,
    body_text: outreach.body,
    resend_msg_id: resendEmailId, // Resend API id, pour référence
    sent_at: now,
  });

  // Mettre à jour le thread avec le subject + compteur
  await supa
    .from('finder_email_threads')
    .update({
      thread_subject: outreach.subject,
      messages_count: 1,
      last_message_at: now,
      last_direction: 'OUT',
    })
    .eq('id', threadId);

  // Stats finder
  await supa.from('client_finder_performance').insert({
    driver_id: driverId,
    place_id: place.id,
    place_type_family: place.place_type_family,
    outreach_sent_at: now,
    ai_model: outreach.model,
    outreach_subject: outreach.subject,
  });
}

// ── Point d'entrée principal ──────────────────────────────────────
export async function runFinderForDriver(
  driverId: string,
  driverName: string,
): Promise<FinderRunResult> {
  const start = Date.now();
  const result: FinderRunResult = {
    driverId,
    prospectsScanned: 0,
    emailsSent: 0,
    skipped: 0,
    errors: 0,
    durationMs: 0,
  };

  const settings = await loadDriverSettings(driverId);
  if (!settings || !settings.enabled) {
    console.log(`[ClientFinder] Driver ${driverId} — finder disabled or no settings`);
    result.durationMs = Date.now() - start;
    return result;
  }

  if (settings.pause_until && new Date(settings.pause_until) > new Date()) {
    console.log(`[ClientFinder] Driver ${driverId} — paused until ${settings.pause_until}`);
    result.durationMs = Date.now() - start;
    return result;
  }

  // v87.1 — Warmup domaine (cap global tous drivers confondus)
  const warmup = await checkWarmupStatus();
  if (!warmup.can_send) {
    console.log(
      `[ClientFinder] Warmup cap reached: ${warmup.sent_today}/${warmup.daily_cap} (days ${warmup.days_since_first_send})`,
    );
    result.durationMs = Date.now() - start;
    return result;
  }

  const todaySent = await countTodaySent(driverId);
  const driverRemaining = Math.max(0, settings.daily_limit - todaySent);
  const remaining = Math.min(driverRemaining, warmup.remaining_today);
  if (remaining === 0) {
    console.log(
      `[ClientFinder] Driver ${driverId} — no capacity (driver:${driverRemaining}, warmup:${warmup.remaining_today})`,
    );
    result.durationMs = Date.now() - start;
    return result;
  }

  const prospects = await loadEligibleProspects(driverId, settings, remaining);
  result.prospectsScanned = prospects.length;

  for (const place of prospects) {
    if (!place.contact_email) {
      result.skipped++;
      continue;
    }

    // v87.1 — Respect opt-out list
    if (await isEmailOptedOut(place.contact_email)) {
      console.log(`[ClientFinder] Skip opted-out: ${place.contact_email}`);
      result.skipped++;
      continue;
    }

    try {
      const outreachReq: OutreachRequest = {
        driverName,
        driverPresentation: settings.driver_presentation ?? undefined,
        customSignature: settings.custom_signature ?? undefined,
        place: {
          name: place.name,
          placeType: place.place_type,
          placeTypeFamily: place.place_type_family,
          address: place.address || '',
          city: place.city,
          contactName: place.contact_name ?? undefined,
          contactTitle: place.contact_title ?? undefined,
        },
      };

      // v87.1 — Essaie d'abord une variante A/B, sinon fallback Claude Opus 4.7
      // (avec driverIdHint pour enrichissement live depuis drivers + user_profiles)
      const fromVariant = await generateFromVariant(outreachReq);
      const outreach: OutreachResult & { variantId?: string } =
        fromVariant ?? (await generateOutreachEmail(outreachReq, driverId));

      // v87.1 — Opt-out link HMAC + footer RGPD
      const optoutToken = generateOptoutToken(place.contact_email);
      const optoutUrl = `https://foreas.xyz/optout/${optoutToken}`;
      const bodyWithFooter =
        outreach.body +
        `\n\n--\nAjnaya — Relations partenaires FOREAS\nforeas.xyz\n\n` +
        `Si vous ne souhaitez plus recevoir de messages : ${optoutUrl}`;

      // 1. Créer log + thread AVANT l'envoi pour avoir un logId déterministe
      const { logId, threadId } = await createLogAndThread(driverId, place);

      // 2. Envoyer avec from = log-{logId}@reply.foreas.xyz
      const sendResult = await sendEmailViaResend(
        logId,
        place.contact_email,
        outreach.subject,
        bodyWithFooter,
        driverName,
      );

      // 3. Enregistrer le message + mettre à jour le thread
      await recordOutreach(driverId, threadId, place, outreach, sendResult.from, sendResult.id);

      if (outreach.variantId) {
        await incrementVariantSent(outreach.variantId);
      }
      result.emailsSent++;

      console.log(`[ClientFinder] ✉️  Sent to ${place.name} <${place.contact_email}>`);

      await new Promise((r) => setTimeout(r, 500));
    } catch (err: any) {
      console.error(`[ClientFinder] ❌ Error for ${place.name}: ${err.message}`);
      result.errors++;
    }
  }

  result.durationMs = Date.now() - start;
  console.log(
    `[ClientFinder] ✅ Driver ${driverId}: ${result.emailsSent} sent, ${result.errors} errors, ${result.durationMs}ms`,
  );
  return result;
}

// ── Batch pour tous les chauffeurs ────────────────────────────────
export async function runClientFinderBatch(): Promise<FinderRunResult[]> {
  const supa = getSupa();
  const { data: settings } = await supa
    .from('client_finder_settings')
    .select('driver_id, enabled, pause_until')
    .eq('enabled', true);

  if (!settings || settings.length === 0) return [];

  const results: FinderRunResult[] = [];
  for (const row of settings as Array<{ driver_id: string; pause_until: string | null }>) {
    if (row.pause_until && new Date(row.pause_until) > new Date()) continue;

    // Charger nom chauffeur
    const { data: profile } = await supa
      .from('user_profiles')
      .select('full_name')
      .eq('user_id', row.driver_id)
      .single();

    const name = (profile as any)?.full_name || 'Chauffeur FOREAS';
    try {
      const r = await runFinderForDriver(row.driver_id, name);
      results.push(r);
    } catch (err: any) {
      console.error(`[ClientFinder] batch error ${row.driver_id}: ${err.message}`);
    }
  }
  return results;
}

// ── Stats live ────────────────────────────────────────────────────
export async function getFinderLiveStats(driverId: string) {
  const supa = getSupa();
  const { data } = await supa.rpc('get_finder_live_stats', { p_driver_id: driverId });
  return data;
}

export async function getClientImpactToday(driverId: string) {
  const supa = getSupa();
  const { data } = await supa.rpc('get_client_impact_today', { p_driver_id: driverId });
  return data;
}
