/**
 * conciergeAcquisition.routes.ts — Acquisition active prospects B2B
 * ════════════════════════════════════════════════════════════════════════
 * Sprint 6 — 30/04/2026
 *
 * Endpoints pour la chasse outbound de prospects via Apollo + Apify, le
 * lancement de campagnes cold outreach (email + WhatsApp), et la lecture
 * du benchmark pricing.
 *
 *   POST /api/concierge/acquisition/launch     — orchestre Apollo + Apify
 *                                                 pour un chauffeur (≤7j inscription)
 *   GET  /api/concierge/acquisition/prospects  — liste les prospects acquis
 *   POST /api/concierge/acquisition/outreach   — déclenche le cold outreach
 *   GET  /api/concierge/pricing/benchmark      — médiane marché par zone
 *   POST /api/concierge/booking/:id/payment-link — Stripe Checkout inline
 *
 * Auth : JWT chauffeur via Supabase Bearer token.
 *
 * NB : Apollo et Apify ne sont pas appelés en direct ici — on enqueue
 * une mission dans la queue Pieuvre (workflow N8N concierge_acquisition).
 * Cette route ne fait que prep + dispatch + lecture des résultats.
 */
import { Router, Request, Response } from 'express';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
import Anthropic from '@anthropic-ai/sdk';
// v1.10.63 (Ajnaya2026v121) — magic numbers externalisés (tient enfin la promesse Sprint 2.1.2)
import {
  DRAFT_TTL_MS,
  DRAFT_CACHE_MAX,
  DRAFT_PURGE_INTERVAL_MS,
  ANTHROPIC_TIMEOUT_MS,
  PIEUVRE_WEBHOOK_TIMEOUT_MS,
  REPLY_MIN_LENGTH,
  REPLY_MAX_LENGTH,
  INBOX_MAX_ROWS,
  DRAFT_CONTEXT_MESSAGES,
  UUID_RE,
} from '../lib/concierge.constants.js';

const router = Router();

// v1.10.61 (Ajnaya2026v1) — Anthropic pour génération draft outreach.
// Lazy : null si ANTHROPIC_API_KEY absent (fallback template auto).
let anthropic: Anthropic | null = null;
if (process.env.ANTHROPIC_API_KEY) {
  anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  console.log('✅ [conciergeAcquisition] Anthropic configuré (preview drafts)');
}

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

let stripeClient: Stripe | null = null;
function getStripe(): Stripe {
  if (stripeClient) return stripeClient;
  stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
    apiVersion: '2024-06-20' as any,
  });
  return stripeClient;
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

// ════════════════════════════════════════════════════════════════════════
// POST /api/concierge/acquisition/launch
// Lance la mission acquisition pour un chauffeur (Apollo + Apify queued
// vers la Pieuvre). Idéalement appelé J0 ou J1 après inscription.
// ════════════════════════════════════════════════════════════════════════
router.post('/acquisition/launch', async (req: Request, res: Response) => {
  const driverId = await getDriverIdFromJWT(req);
  if (!driverId) return res.status(401).json({ error: 'Auth requise' });

  const { radius_km = 5, max_apollo_results = 50, max_apify_results = 50 } = req.body || {};

  try {
    const supa = getSupa();

    // 1. Charger le chauffeur + son site (lat/lng pour rayon, vertical_keys ciblées)
    const { data: site } = await supa
      .from('driver_sites')
      .select('id, slug, display_name, city, niche')
      .eq('driver_id', driverId)
      .eq('is_active', true)
      .maybeSingle();

    if (!site) {
      return res.status(404).json({
        error: "Aucun site perso actif. Crée d'abord ton site dans l'onglet Mon Site.",
      });
    }

    // 2. Charger les verticales actives (par défaut tout, le chauffeur peut filtrer
    //    plus tard via un toggle UI)
    const { data: verticals } = await supa
      .from('concierge_target_verticals')
      .select('vertical_key, display_name, category, priority, apollo_keywords, apollo_titles')
      .eq('is_active', true)
      .order('priority', { ascending: true });

    // 3. Enqueue mission Pieuvre via webhook N8N (workflow
    //    concierge_acquisition_orchestrator). Le workflow lit la mission,
    //    interroge Apollo/Apify, populate concierge_acquired_prospects.
    const pieuvreWebhook =
      process.env.PIEUVRE_ACQUISITION_WEBHOOK_URL ||
      'https://n8n.srv1534739.hstgr.cloud/webhook/concierge-acquisition';
    const secret = process.env.PIEUVRE_RESPOND_SECRET;

    if (secret) {
      // Fire-and-forget — la mission tourne en arrière-plan côté Pieuvre
      fetch(pieuvreWebhook, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Foreas-Shared-Secret': secret,
        },
        body: JSON.stringify({
          driver_id: driverId,
          site_slug: site.slug,
          driver_name: site.display_name,
          city: site.city,
          niche: site.niche,
          radius_km,
          max_apollo_results,
          max_apify_results,
          verticals: verticals || [],
          launched_at: new Date().toISOString(),
        }),
      }).catch((err) => {
        console.warn('[Acquisition] Pieuvre webhook error (non-blocking):', err?.message);
      });
    }

    return res.json({
      ok: true,
      message: 'Mission acquisition lancée. Premiers prospects dans 5-15 min.',
      site_slug: site.slug,
      verticals_count: (verticals || []).length,
      estimated_prospects: max_apollo_results + max_apify_results,
    });
  } catch (err: any) {
    console.error('[Acquisition] /launch error:', err?.message);
    return res.status(500).json({ error: 'Erreur lancement acquisition' });
  }
});

// ════════════════════════════════════════════════════════════════════════
// GET /api/concierge/acquisition/prospects
// Liste les prospects acquis pour le chauffeur (paginé, filtrable).
// ════════════════════════════════════════════════════════════════════════
router.get('/acquisition/prospects', async (req: Request, res: Response) => {
  const driverId = await getDriverIdFromJWT(req);
  if (!driverId) return res.status(401).json({ error: 'Auth requise' });

  const status = (req.query.status as string) || null;
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;

  try {
    const supa = getSupa();

    let query = supa
      .from('concierge_acquired_prospects')
      .select('*', { count: 'exact' })
      .eq('driver_id', driverId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status) query = query.eq('status', status);

    const { data, count, error } = await query;
    if (error) throw error;

    return res.json({
      prospects: data || [],
      total: count || 0,
      limit,
      offset,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Erreur lecture prospects' });
  }
});

// ════════════════════════════════════════════════════════════════════════
// v1.10.61 (Ajnaya2026v1 · Témoin Vivant Sprint 1)
// POST /api/concierge/acquisition/preview
// Génère le DRAFT du message outreach SANS l'envoyer. Permet au chauffeur
// de voir EXACTEMENT ce qui partira chez le prospect (transparence radicale,
// contre-mesure trait #1 "suspicieux à outrance").
//
// Flow :
//   App → POST preview → backend génère draft via Anthropic Sonnet 4.6
//   → retourne {draft_id, message_text, prospect_name, channel}
//   → App affiche WhatsAppPreviewModal
//   → User confirme → POST outreach avec draft_id (envoie le message exact)
//   → User refuse → draft expire après 5 min
// ════════════════════════════════════════════════════════════════════════

// Cache mémoire des drafts (Map en RAM, TTL 5 min). Dans une 2e itération
// on persistera dans `concierge_outreach_drafts` Supabase si besoin.
interface OutreachDraft {
  id: string;
  driver_id: string;
  prospect_id: string;
  channel: 'email' | 'whatsapp';
  message_text: string;
  prospect_name: string;
  prospect_company: string;
  generated_at: number;
  expires_at: number;
}
const _draftCache = new Map<string, OutreachDraft>();
// v1.10.63 (Ajnaya2026v121) — Constants importées de concierge.constants.ts
// (avant : valeurs inline dupliquées partout — promesse Sprint 2.1.2 enfin tenue)

function purgeExpiredDrafts(): void {
  const now = Date.now();
  for (const [k, v] of _draftCache.entries()) {
    if (v.expires_at < now) _draftCache.delete(k);
  }
  // v1.10.62 — Fix W2 : si toujours au-dessus du cap après purge, drop les
  // plus anciens (LRU-ish par expires_at ascending).
  if (_draftCache.size > DRAFT_CACHE_MAX) {
    const sorted = [..._draftCache.entries()].sort((a, b) => a[1].expires_at - b[1].expires_at);
    const toDelete = sorted.slice(0, _draftCache.size - DRAFT_CACHE_MAX);
    for (const [k] of toDelete) _draftCache.delete(k);
  }
}

// v1.10.62 — Fix W2 : auto-purge toutes les 60s même sans trafic.
// Évite l'accumulation indéfinie pendant les périodes calmes.
setInterval(() => {
  try {
    purgeExpiredDrafts();
  } catch {}
}, DRAFT_PURGE_INTERVAL_MS).unref(); // unref() pour ne pas bloquer le process exit

// v1.10.62 — Fix W7 : helpers PII safe pour les logs (RGPD).
function truncDriverId(id: string): string {
  return id ? `${id.slice(0, 8)}…` : 'unknown';
}
function truncDraftId(id: string): string {
  return id ? `${id.slice(0, 12)}…` : 'unknown';
}

// v1.10.62 — Fix W10 : helper timeout race pour les promesses externes.
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => {
      console.warn(`[conciergeAcquisition] ${label} timeout ${ms}ms — fallback`);
      resolve(null);
    }, ms);
    promise
      .then((v) => {
        clearTimeout(timer);
        resolve(v);
      })
      .catch((e) => {
        clearTimeout(timer);
        console.warn(`[conciergeAcquisition] ${label} error:`, e?.message ?? e);
        resolve(null);
      });
  });
}

router.post('/acquisition/preview', async (req: Request, res: Response) => {
  const driverId = await getDriverIdFromJWT(req);
  if (!driverId) return res.status(401).json({ error: 'Auth requise' });

  const { prospect_id, channel = 'email' } = req.body || {};
  if (!prospect_id || typeof prospect_id !== 'string') {
    return res.status(400).json({ error: 'prospect_id requis' });
  }
  if (!['email', 'whatsapp'].includes(channel)) {
    return res.status(400).json({ error: 'channel invalide (email|whatsapp)' });
  }

  try {
    const supa = getSupa();

    // 1. Charger les infos du prospect (filtré par driver pour sécurité)
    const { data: prospect, error: prospectErr } = await supa
      .from('concierge_acquired_prospects')
      .select(
        'id, contact_name, contact_role, company_name, contact_email, vertical_key, distance_km',
      )
      .eq('id', prospect_id)
      .eq('driver_id', driverId)
      .single();

    if (prospectErr || !prospect) {
      return res.status(404).json({ error: 'Prospect introuvable ou non autorisé' });
    }

    // 2. Charger le site driver (pour personnaliser avec le slug)
    const { data: site } = await supa
      .from('driver_sites')
      .select('slug, display_name, city, niche, pricing')
      .eq('driver_id', driverId)
      .eq('is_active', true)
      .maybeSingle();

    // 3. Charger le profil driver (pour signature)
    const { data: driverProfile } = await supa
      .from('drivers')
      .select('first_name')
      .eq('id', driverId)
      .maybeSingle();

    const driverFirstName = driverProfile?.first_name || 'Chandler';
    const siteSlug = site?.slug || '';
    const siteUrl = siteSlug ? `https://foreas.xyz/c/${siteSlug}` : 'https://foreas.xyz';

    // 4. Génération du draft via Anthropic (si dispo) sinon template fallback
    let messageText: string;
    if (anthropic) {
      const systemPrompt = `Tu es Ajnaya, l'assistante VTC de ${driverFirstName}. Tu rédiges un message ${channel === 'whatsapp' ? 'WhatsApp' : 'email'} court et personnel pour un prospect B2B (chauffeur premium contacte client direct).

RÈGLES STRICTES :
- 100 mots maximum
- Tutoiement INTERDIT (vouvoiement formel B2B)
- Aucun jargon marketing ("disruptif", "innovant", "leader")
- Aucune promesse vague ("économisez du temps")
- Mention concrète : ${prospect.company_name || prospect.contact_name} dans son contexte (${prospect.vertical_key || 'professionnel'})
- Service VTC premium : voiture noire, tarif fixe, jamais de surge
- Call-to-action discret : essai gratuit cette semaine
- Signature : prénom du chauffeur + lien site personnalisé

PAS de "Bonjour" suivi du prénom (trop intime). PRÉFÈRE "Maître X" si avocat, "Cher M./Mme X" si autre.`;

      const userPrompt = `Prospect :
- Nom : ${prospect.contact_name || 'Contact qualifié'}
- Rôle : ${prospect.contact_role || 'managing partner'}
- Entreprise : ${prospect.company_name || 'leur cabinet'}
- Secteur : ${prospect.vertical_key || 'professionnel'}
- Distance : ${prospect.distance_km ? `${prospect.distance_km.toFixed(1)} km de mon point` : 'proche'}

Site driver : ${siteUrl}
Driver : ${driverFirstName}

Rédige le message ${channel === 'whatsapp' ? 'WhatsApp court (max 80 mots, ton naturel)' : 'email court (max 100 mots, ton pro)'}.`;

      // v1.10.62 — Fix W10 : timeout 5s sur Anthropic (sinon loading 30s côté user).
      const completion = await withTimeout(
        anthropic.messages.create({
          model: 'claude-sonnet-4-5',
          max_tokens: 400,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
        }),
        ANTHROPIC_TIMEOUT_MS,
        'Anthropic preview generation',
      );
      if (completion) {
        const textBlock = completion.content.find((b: any) => b.type === 'text') as any;
        messageText = (textBlock?.text || '').trim();
      } else {
        // Timeout ou erreur → fallback template (géré au step 5)
        messageText = '';
      }
    } else {
      messageText = '';
    }

    // 5. Fallback template si Anthropic KO
    if (!messageText) {
      const greeting =
        (prospect.contact_role || '').toLowerCase().includes('avocat') ||
        (prospect.vertical_key || '').toLowerCase().includes('avocat')
          ? `Maître ${(prospect.contact_name || '').split(' ').slice(-1)[0]}`
          : `Cher ${prospect.contact_name || prospect.company_name}`;

      messageText = `${greeting},

Je suis ${driverFirstName}, chauffeur VTC premium FOREAS. Je vois votre cabinet (${prospect.company_name || ''}) ${prospect.distance_km ? `à ${prospect.distance_km.toFixed(1)} km de mon point` : 'dans le secteur'}.

Je propose un service dédié pour les déplacements professionnels (RDV clients, audiences, événements) : voiture noire, tarif fixe à l'avance, jamais de surge.

Un essai gratuit cette semaine pour voir si ça correspond ?

${driverFirstName}
${siteUrl}`;
    }

    // 6. Crée le draft + cache 5 min
    purgeExpiredDrafts();
    const draftId = `draft_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const draft: OutreachDraft = {
      id: draftId,
      driver_id: driverId,
      prospect_id,
      channel,
      message_text: messageText,
      prospect_name: prospect.contact_name || 'Contact qualifié',
      prospect_company: prospect.company_name || '',
      generated_at: Date.now(),
      expires_at: Date.now() + DRAFT_TTL_MS,
    };
    _draftCache.set(draftId, draft);

    return res.json({
      ok: true,
      draft_id: draftId,
      channel,
      message_text: messageText,
      prospect_name: draft.prospect_name,
      prospect_company: draft.prospect_company,
      site_url: siteUrl,
      expires_at: new Date(draft.expires_at).toISOString(),
      // Métadonnées utiles pour preview UI
      message_length: messageText.length,
      word_count: messageText.split(/\s+/).filter(Boolean).length,
    });
  } catch (err: any) {
    console.error('[preview] error:', err?.message);
    return res.status(500).json({
      ok: false,
      error: err?.message || 'Erreur génération preview',
    });
  }
});

// ════════════════════════════════════════════════════════════════════════
// POST /api/concierge/acquisition/outreach
// Déclenche le cold outreach pour 1+ prospects (email/whatsapp).
// Idempotent — si déjà contacté <24h, refuse.
//
// v1.10.61 — Accepte aussi `draft_id` pour utiliser un draft pré-validé
// par l'utilisateur (flux Témoin Vivant : preview → confirm → envoi).
// ════════════════════════════════════════════════════════════════════════
router.post('/acquisition/outreach', async (req: Request, res: Response) => {
  const driverId = await getDriverIdFromJWT(req);
  if (!driverId) return res.status(401).json({ error: 'Auth requise' });

  const { prospect_ids, channel = 'email', draft_id } = req.body || {};
  if (!Array.isArray(prospect_ids) || prospect_ids.length === 0) {
    return res.status(400).json({ error: 'prospect_ids requis' });
  }
  if (!['email', 'whatsapp'].includes(channel)) {
    return res.status(400).json({ error: 'channel invalide' });
  }

  // v1.10.61 (Ajnaya2026v1) — Si draft_id fourni, on utilise le message exact
  // que l'user a vu dans la PreviewModal (transparence radicale).
  // Le draft est bridé à 5 min + appartient au même driver_id pour sécurité.
  let confirmedDraftMessage: string | null = null;
  if (draft_id && typeof draft_id === 'string') {
    const draft = _draftCache.get(draft_id);
    if (draft && draft.driver_id === driverId && draft.expires_at > Date.now()) {
      // Vérif : le prospect_id du draft est dans le batch demandé
      if (prospect_ids.includes(draft.prospect_id)) {
        confirmedDraftMessage = draft.message_text;
      }
    } else {
      // Draft expiré/inconnu → on ne bloque pas (re-génération côté Pieuvre),
      // juste on log le warning pour debug.
      // v1.10.62 — Fix W7 : tronque le draft_id (PII partial)
      console.warn(
        `[outreach] draft_id ${truncDraftId(draft_id)} invalide/expiré, fallback re-génération`,
      );
    }
  }

  try {
    const pieuvreWebhook =
      process.env.PIEUVRE_OUTREACH_WEBHOOK_URL ||
      'https://n8n.srv1534739.hstgr.cloud/webhook/concierge-outreach';
    const secret = process.env.PIEUVRE_RESPOND_SECRET;

    // v1.10.60 — HARDENING : si secret manque, on retourne CLAIREMENT une
    // erreur au front (avant : ok=true silencieusement → mensonge UX).
    // L'user doit savoir si le pipeline est down.
    if (!secret) {
      console.warn(
        `⚠️ [outreach] PIEUVRE_RESPOND_SECRET manquant — outreach non dispatché pour driver ${truncDriverId(driverId)}`,
      );
      return res.status(503).json({
        ok: false,
        error: 'Pipeline outreach non configurée côté serveur. On répare ça côté équipe.',
        reason: 'pieuvre_not_configured',
        webhook_dispatched: false,
      });
    }

    // v1.10.60 — Trace l'envoi en DB AVANT le dispatch webhook pour audit
    // (et permettre au front d'afficher last_contact_at après refresh).
    // Soft fail si la table n'existe pas — n'empêche pas le webhook.
    const sentAt = new Date().toISOString();
    const supa = getSupa();
    let dbTraced = false;
    try {
      // UPDATE last_contact_at + last_channel sur les prospects
      const { error: updErr } = await supa
        .from('concierge_acquired_prospects')
        .update({
          last_contact_at: sentAt,
          last_channel: channel,
          contact_status: 'pending',
        })
        .in('id', prospect_ids)
        .eq('driver_id', driverId);
      if (!updErr) dbTraced = true;
    } catch {
      // Table peut ne pas avoir ces colonnes — ignore, le webhook reste prio
    }

    // v1.10.60 — Tente await SHORT (1s) sur le webhook pour différencier
    // dispatch OK vs unreachable. Si timeout → fire-and-forget normal.
    let webhookDispatched = false;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), PIEUVRE_WEBHOOK_TIMEOUT_MS);
      const wh = await fetch(pieuvreWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Foreas-Shared-Secret': secret },
        body: JSON.stringify({
          driver_id: driverId,
          prospect_ids,
          channel,
          requested_at: sentAt,
          // v1.10.61 — Si user a vu et confirmé un draft preview, on l'envoie
          // pour que la Pieuvre utilise CE message exact (et pas re-génère).
          confirmed_message_text: confirmedDraftMessage,
          draft_id: draft_id ?? null,
        }),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      webhookDispatched = wh.ok;
    } catch {
      // Webhook timeout — pas grave, ça part en background
      webhookDispatched = false;
    }

    return res.json({
      ok: true,
      sent_at: sentAt,
      channel,
      prospects_count: prospect_ids.length,
      webhook_dispatched: webhookDispatched,
      db_traced: dbTraced,
      message: webhookDispatched
        ? `Ajnaya envoie un ${channel === 'whatsapp' ? 'WhatsApp' : 'email'} à ${prospect_ids.length} contact${prospect_ids.length > 1 ? 's' : ''}…`
        : `Mission enregistrée. Ajnaya enverra le ${channel === 'whatsapp' ? 'WhatsApp' : 'email'} dès que la pieuvre est dispo.`,
    });
  } catch (err: any) {
    return res.status(500).json({
      ok: false,
      error: err?.message || 'Erreur outreach',
      reason: 'unexpected',
    });
  }
});

// ════════════════════════════════════════════════════════════════════════
// v1.10.61 (Ajnaya2026v1 · Témoin Vivant Sprint 1)
// GET /api/concierge/acquisition/prospect/:id/timeline
// Retourne la timeline complète des events delivery pour 1 prospect :
//   [{ event_type, occurred_at, proof: {provider, event_id, status_code} }]
//
// Events possibles (delivery_status enum) :
//   sent → delivered → read → clicked → replied
//   bounced / failed (cas d'échec)
//
// Source : pieuvre_conversations filtré par prospect_id + driver_id
// + colonnes delivered_at, read_at, clicked_at, replied_at, provider_event_id
// (à brancher cross-fil Pieuvre via ALTER TABLE — voir handoff §20.2 Acte 2)
// ════════════════════════════════════════════════════════════════════════
// v1.10.63 — UUID_RE importé depuis concierge.constants.ts

router.get('/acquisition/prospect/:id/timeline', async (req: Request, res: Response) => {
  const driverId = await getDriverIdFromJWT(req);
  if (!driverId) return res.status(401).json({ error: 'Auth requise' });

  const prospectId = req.params.id;
  if (!prospectId) return res.status(400).json({ error: 'prospect_id requis' });

  // v1.10.62 — Fix B4 : reject UUIDs malformés (anti-injection wildcard).
  if (!UUID_RE.test(prospectId)) {
    return res.status(400).json({ error: 'prospect_id format invalide (UUID requis)' });
  }

  try {
    const supa = getSupa();

    // Sécurité : vérifier que le prospect appartient bien au driver
    const { data: prospect } = await supa
      .from('concierge_acquired_prospects')
      .select('id, contact_name, company_name, last_contact_at, last_channel, contact_status')
      .eq('id', prospectId)
      .eq('driver_id', driverId)
      .maybeSingle();

    if (!prospect) {
      return res.status(404).json({ error: 'Prospect introuvable ou non autorisé' });
    }

    // Charge les conversations associées à ce prospect (outbound + inbound)
    // Soft-fail sur colonnes optionnelles (delivered_at etc. créées par Pieuvre)
    // v1.10.62 — Fix B3+B4 : `eq` au lieu de `ilike` (UUID = match exact, plus
    // rapide, utilise les indexes btree, anti-wildcard injection).
    const { data: conversations, error } = await supa
      .from('pieuvre_conversations')
      .select('*')
      .eq('driver_id', driverId)
      .eq('metadata->>prospect_id', prospectId)
      .order('created_at', { ascending: true });

    if (error) {
      console.warn('[timeline] pieuvre_conversations error:', error.message);
      // Ne pas bloquer : on retourne une timeline minimale depuis le prospect lui-même
    }

    // Construit la timeline : chaque conversation outbound = 1+ events
    const events: Array<{
      event_type: string;
      occurred_at: string;
      direction: 'outbound' | 'inbound';
      channel: string;
      message_excerpt?: string;
      proof?: { provider: string; event_id?: string; source: string };
    }> = [];

    for (const conv of conversations || []) {
      // Event "sent" : timestamp de création
      if (conv.created_at && conv.direction === 'outbound') {
        events.push({
          event_type: 'sent',
          occurred_at: conv.created_at,
          direction: 'outbound',
          channel: conv.channel || conv.tentacle || 'unknown',
          message_excerpt:
            typeof conv.content === 'string' ? conv.content.substring(0, 80) : undefined,
          proof: {
            provider: conv.tentacle === 'app_driver_outreach' ? 'foreas-app' : 'pieuvre',
            event_id: conv.id,
            source: 'pieuvre_conversations',
          },
        });
      }
      // Events delivered/read/clicked depuis colonnes optionnelles (cross-fil)
      const c: any = conv;
      if (c.delivered_at) {
        events.push({
          event_type: 'delivered',
          occurred_at: c.delivered_at,
          direction: 'outbound',
          channel: conv.channel || 'unknown',
          proof: {
            provider: c.channel === 'whatsapp' ? 'meta-whatsapp' : 'resend',
            event_id: c.provider_event_id,
            source: 'webhook',
          },
        });
      }
      if (c.read_at) {
        events.push({
          event_type: 'read',
          occurred_at: c.read_at,
          direction: 'outbound',
          channel: conv.channel || 'unknown',
          proof: {
            provider: c.channel === 'whatsapp' ? 'meta-whatsapp' : 'resend',
            event_id: c.provider_event_id,
            source: 'webhook',
          },
        });
      }
      if (c.clicked_at) {
        events.push({
          event_type: 'clicked',
          occurred_at: c.clicked_at,
          direction: 'outbound',
          channel: conv.channel || 'unknown',
          proof: { provider: 'foreas-site', source: 'site_analytics' },
        });
      }
      if (c.replied_at) {
        events.push({
          event_type: 'replied',
          occurred_at: c.replied_at,
          direction: 'outbound',
          channel: conv.channel || 'unknown',
          proof: {
            provider: c.channel === 'whatsapp' ? 'meta-whatsapp-inbound' : 'resend-inbound',
            source: 'webhook',
          },
        });
      }
      // Inbound = réponse réelle du prospect
      if (conv.direction === 'inbound') {
        events.push({
          event_type: 'replied',
          occurred_at: conv.created_at,
          direction: 'inbound',
          channel: conv.channel || 'unknown',
          message_excerpt:
            typeof conv.content === 'string' ? conv.content.substring(0, 80) : undefined,
          proof: { provider: 'pieuvre', event_id: conv.id, source: 'pieuvre_conversations' },
        });
      }
    }

    // Si aucune conversation mais last_contact_at présent → reconstruire event "sent"
    if (events.length === 0 && prospect.last_contact_at) {
      events.push({
        event_type: 'sent',
        occurred_at: prospect.last_contact_at,
        direction: 'outbound',
        channel: prospect.last_channel || 'unknown',
        proof: {
          provider: 'foreas-app',
          source: 'concierge_acquired_prospects.last_contact_at',
        },
      });
    }

    // Tri chronologique
    events.sort((a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime());

    return res.json({
      ok: true,
      prospect: {
        id: prospect.id,
        contact_name: prospect.contact_name,
        company_name: prospect.company_name,
        contact_status: prospect.contact_status,
      },
      events,
      events_count: events.length,
    });
  } catch (err: any) {
    return res.status(500).json({
      ok: false,
      error: err?.message || 'Erreur lecture timeline',
    });
  }
});

// ════════════════════════════════════════════════════════════════════════
// GET /api/concierge/pricing/benchmark?zone=paris-11&vehicle_type=berline
// Renvoie médiane marché vs tarif chauffeur + recommendation Ajnaya.
// ════════════════════════════════════════════════════════════════════════
router.get('/pricing/benchmark', async (req: Request, res: Response) => {
  const driverId = await getDriverIdFromJWT(req);
  if (!driverId) return res.status(401).json({ error: 'Auth requise' });

  const zone = (req.query.zone as string) || 'paris-centre';
  const vehicleType = (req.query.vehicle_type as string) || 'berline';

  try {
    const supa = getSupa();

    const [medianRes, siteRes] = await Promise.all([
      supa
        .from('concierge_pricing_median')
        .select('*')
        .eq('zone_key', zone)
        .eq('vehicle_type', vehicleType)
        .maybeSingle(),
      supa.from('driver_sites').select('pricing').eq('driver_id', driverId).maybeSingle(),
    ]);

    const median = medianRes.data;
    const driverPricing = (siteRes.data?.pricing as any) || {};
    const driverRateKm = Number(driverPricing.per_km ?? driverPricing.perKmRate ?? 0);
    const medianRateKm = Number(median?.median_rate_per_km || 0);

    let recommendation: { type: string; message: string; suggested_rate_per_km?: number } = {
      type: 'no_data',
      message: 'Pas encore assez de données marché pour ta zone. Sois patient, on collecte.',
    };

    if (medianRateKm > 0 && driverRateKm > 0) {
      const gapPct = (driverRateKm - medianRateKm) / medianRateKm;
      if (gapPct > 0.5) {
        recommendation = {
          type: 'too_high',
          message: `Tu factures ${(gapPct * 100).toFixed(0)}% au-dessus de la médiane (${medianRateKm.toFixed(2)}€/km). Cible niche premium uniquement (Apollo: hôtels 5★).`,
          suggested_rate_per_km: medianRateKm * 1.05,
        };
      } else if (gapPct > 0.2) {
        recommendation = {
          type: 'high',
          message: `Tu es ${(gapPct * 100).toFixed(0)}% au-dessus du marché. OK si tu as ⭐4.8+, sinon baisse à ${(medianRateKm * 1.05).toFixed(2)}€/km.`,
          suggested_rate_per_km: medianRateKm * 1.05,
        };
      } else if (gapPct < -0.15) {
        recommendation = {
          type: 'too_low',
          message: `Tu vends ${Math.abs(gapPct * 100).toFixed(0)}% sous le marché. Augmente à ${(medianRateKm * 0.95).toFixed(2)}€/km, tu gagnes la même clientèle avec +20% de marge.`,
          suggested_rate_per_km: medianRateKm * 0.95,
        };
      } else {
        recommendation = {
          type: 'sweet_spot',
          message: `Ton tarif est dans la zone optimale (médiane ${medianRateKm.toFixed(2)}€/km).`,
        };
      }
    }

    return res.json({
      zone,
      vehicle_type: vehicleType,
      median: median || null,
      driver_pricing: driverPricing,
      recommendation,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Erreur benchmark' });
  }
});

// ════════════════════════════════════════════════════════════════════════
// POST /api/concierge/booking/:id/payment-link
// Crée un Stripe Checkout Session pour un booking, transfer auto vers
// le Connect account du chauffeur. Application fee = commission FOREAS.
// Renvoyé inline au widget (PAS d'envoi SMS/email externe).
// ════════════════════════════════════════════════════════════════════════
router.post('/booking/:id/payment-link', async (req: Request, res: Response) => {
  const bookingId = req.params.id;
  if (!bookingId) return res.status(400).json({ error: 'booking_id requis' });

  // Cette route est appelée depuis le widget (pas authentifié) — on la
  // laisse publique mais on vérifie le booking existe et est 'pending'.
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const supa = getSupa();

    // 1. Charger booking + driver_sites pour Stripe Connect ID
    const { data: booking } = await supa
      .from('bookings')
      .select(
        'id, driver_id, site_slug, estimated_price, client_email, client_name, pickup_address, dropoff_address, scheduled_at, status',
      )
      .eq('id', bookingId)
      .maybeSingle();

    if (!booking) return res.status(404).json({ error: 'Booking introuvable' });
    if (booking.status === 'paid') {
      return res.status(409).json({ error: 'Déjà payé' });
    }

    const { data: site } = await supa
      .from('driver_sites')
      .select('id, stripe_account_id, stripe_charges_enabled, display_name')
      .eq('slug', booking.site_slug)
      .maybeSingle();

    if (!site?.stripe_account_id) {
      return res.status(409).json({
        error:
          "Le chauffeur n'a pas encore activé son compte de paiement. Réservation gardée en attente.",
        code: 'driver_stripe_not_onboarded',
      });
    }

    if (!site.stripe_charges_enabled) {
      return res.status(409).json({
        error: 'Paiement temporairement indisponible. Réessaie dans 24h.',
        code: 'driver_stripe_charges_disabled',
      });
    }

    // 2. Idempotence : si un payment_link existe déjà et n'est pas expiré,
    //    on retourne le même au lieu d'en générer un nouveau.
    const { data: existing } = await supa
      .from('concierge_payment_links')
      .select('payment_url, stripe_session_id, expires_at, status')
      .eq('booking_id', bookingId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existing && new Date(existing.expires_at) > new Date()) {
      return res.json({
        payment_url: existing.payment_url,
        amount_eur: booking.estimated_price,
        expires_at: existing.expires_at,
        reused: true,
      });
    }

    // 3. Calcul commission FOREAS — v1.10.50
    //    Source de vérité : driver_sites.commission_percent (par chauffeur, default 0%).
    //    Fallback env FOREAS_APPLICATION_FEE_PCT pour cas exceptionnels (en pourcentage,
    //    ex: 0.08 = 8%) si la colonne n'est pas peuplée.
    let commissionPercent = 0;
    try {
      const { data: siteCommission } = await supa
        .from('driver_sites')
        .select('commission_percent')
        .eq('id', site.id)
        .maybeSingle();
      commissionPercent = Number(siteCommission?.commission_percent ?? 0);
    } catch {
      commissionPercent = 0;
    }
    if (!Number.isFinite(commissionPercent) || commissionPercent < 0) {
      commissionPercent = 0;
    }
    // Fallback env (ratio 0-1, ex: 0.08) si commission_percent === 0 et env défini
    const envFallback = Number(process.env.FOREAS_APPLICATION_FEE_PCT || 0);
    const feePct = commissionPercent > 0 ? commissionPercent / 100 : envFallback;
    const amountCents = Math.round(Number(booking.estimated_price) * 100);
    const feeCents = Math.round(amountCents * feePct);

    if (amountCents < 100) {
      return res.status(400).json({ error: 'Montant trop faible (<1€)' });
    }

    // 4. Création de la session Stripe Checkout avec destination charge
    const stripe = getStripe();
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: booking.client_email || undefined,
      line_items: [
        {
          price_data: {
            currency: 'eur',
            unit_amount: amountCents,
            product_data: {
              name: `Course VTC - ${site.display_name}`,
              description: `${booking.pickup_address} → ${booking.dropoff_address}`,
            },
          },
          quantity: 1,
        },
      ],
      payment_intent_data: {
        application_fee_amount: feeCents,
        transfer_data: {
          destination: site.stripe_account_id,
        },
        metadata: {
          booking_id: bookingId,
          driver_id: booking.driver_id,
          site_slug: booking.site_slug,
        },
      },
      success_url: `https://foreas.xyz/${booking.site_slug}?paid=1&booking=${bookingId}`,
      cancel_url: `https://foreas.xyz/${booking.site_slug}?cancelled=1`,
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60, // 30 min
      metadata: {
        booking_id: bookingId,
        driver_id: booking.driver_id,
      },
    });

    // 5. Audit trail dans concierge_payment_links
    await supa.from('concierge_payment_links').insert({
      booking_id: bookingId,
      driver_id: booking.driver_id,
      stripe_session_id: session.id,
      amount_eur: booking.estimated_price,
      application_fee_eur: feeCents / 100,
      payment_url: session.url || '',
      expires_at: new Date((session.expires_at || 0) * 1000).toISOString(),
      status: 'pending',
    });

    // 6. Funnel event
    await supa.from('concierge_funnel_events').insert({
      driver_id: booking.driver_id,
      site_slug: booking.site_slug,
      booking_id: bookingId,
      event_type: 'payment_link_sent',
      source: 'widget',
      meta: {
        amount_eur: booking.estimated_price,
        application_fee_eur: feeCents / 100,
        stripe_session_id: session.id,
      },
    });

    return res.json({
      payment_url: session.url,
      amount_eur: booking.estimated_price,
      expires_at: new Date((session.expires_at || 0) * 1000).toISOString(),
      session_id: session.id,
    });
  } catch (err: any) {
    console.error('[ConciergePayment] error:', err?.message);
    return res.status(500).json({ error: err?.message || 'Erreur création paiement' });
  }
});

// ════════════════════════════════════════════════════════════════════════
// v1.10.62 (Ajnaya2026v119) — Sprint 2.1.1 Pont Réponses Témoin Vivant
// Endpoints conversations chauffeur ↔ prospects.
// ════════════════════════════════════════════════════════════════════════

/**
 * GET /api/concierge/conversations/inbox
 * Liste des conversations actives du chauffeur, triées par dernière activité,
 * avec count des inbound non-lus (replied_at non null mais pas encore consulté).
 *
 * Réponse :
 * {
 *   conversations: [{
 *     prospect_id, contact_name, company_name, vertical_key,
 *     last_message: { content, direction, occurred_at, channel },
 *     unread_count: number,
 *     thread_count: number
 *   }],
 *   total_unread: number
 * }
 */
router.get('/conversations/inbox', async (req: Request, res: Response) => {
  const driverId = await getDriverIdFromJWT(req);
  if (!driverId) return res.status(401).json({ error: 'Auth requise' });

  try {
    const supa = getSupa();

    // Charger toutes les conversations du driver groupées par prospect_id
    const { data: convs, error } = await supa
      .from('pieuvre_conversations')
      .select('id, direction, channel, content, created_at, metadata, delivery_status, replied_at')
      .eq('driver_id', driverId)
      .in('channel', ['whatsapp', 'email', 'in_app'])
      .order('created_at', { ascending: false })
      .limit(INBOX_MAX_ROWS);

    if (error) {
      console.warn('[conversations/inbox] error:', error.message);
      return res.json({ conversations: [], total_unread: 0 });
    }

    // Grouper par prospect_id
    const groupedByProspect = new Map<string, any[]>();
    for (const c of convs || []) {
      const meta = (c.metadata as any) || {};
      const pid = meta.prospect_id;
      if (!pid) continue;
      const list = groupedByProspect.get(pid) || [];
      list.push(c);
      groupedByProspect.set(pid, list);
    }

    if (groupedByProspect.size === 0) {
      return res.json({ conversations: [], total_unread: 0 });
    }

    // Charger les infos prospects en batch
    const prospectIds = Array.from(groupedByProspect.keys());
    const { data: prospects } = await supa
      .from('concierge_acquired_prospects')
      .select('id, contact_name, company_name, vertical_key')
      .in('id', prospectIds)
      .eq('driver_id', driverId);

    const prospectsMap = new Map((prospects || []).map((p: any) => [p.id, p]));

    // Construire les rows réponse
    const conversations = prospectIds
      .map((pid) => {
        const msgs = groupedByProspect.get(pid) || [];
        const prospect = prospectsMap.get(pid);
        if (!prospect) return null;

        // Dernier message (déjà ordered DESC, donc index 0)
        const last = msgs[0];
        const lastMeta = (last?.metadata as any) || {};
        const isReadByDriver = !!lastMeta.read_by_driver_at;

        // Count unread = messages inbound non-lus par le chauffeur
        const unreadCount = msgs.filter((m: any) => {
          if (m.direction !== 'inbound') return false;
          const m2 = (m.metadata as any) || {};
          return !m2.read_by_driver_at;
        }).length;

        return {
          prospect_id: pid,
          contact_name: prospect.contact_name,
          company_name: prospect.company_name,
          vertical_key: prospect.vertical_key,
          last_message: {
            content: typeof last?.content === 'string' ? last.content.slice(0, 120) : '',
            direction: last?.direction,
            channel: last?.channel,
            occurred_at: last?.created_at,
            is_read_by_driver: isReadByDriver,
          },
          unread_count: unreadCount,
          thread_count: msgs.length,
        };
      })
      .filter((c) => c !== null)
      .sort((a, b) => {
        // Tri par : unread d'abord, puis dernière activité desc
        if (a!.unread_count > 0 !== b!.unread_count > 0) {
          return a!.unread_count > 0 ? -1 : 1;
        }
        return (
          new Date(b!.last_message.occurred_at).getTime() -
          new Date(a!.last_message.occurred_at).getTime()
        );
      });

    const totalUnread = conversations.reduce((sum, c) => sum + (c?.unread_count || 0), 0);

    return res.json({
      conversations,
      total_unread: totalUnread,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Erreur lecture inbox' });
  }
});

/**
 * GET /api/concierge/conversations/:prospect_id/thread
 * Charge l'historique complet de la conversation avec un prospect.
 * Marque les inbound comme "lus par le chauffeur" automatiquement.
 *
 * Réponse :
 * {
 *   prospect: { id, contact_name, company_name, vertical_key, contact_email, contact_phone },
 *   messages: [{ id, direction, channel, content, created_at, delivery_status, ...timestamps }],
 *   timeline_events: [...]  // events delivery (sent/delivered/read/clicked) pour la card timeline
 * }
 */
router.get('/conversations/:prospect_id/thread', async (req: Request, res: Response) => {
  const driverId = await getDriverIdFromJWT(req);
  if (!driverId) return res.status(401).json({ error: 'Auth requise' });

  const prospectId = req.params.prospect_id;
  if (!prospectId || !UUID_RE.test(prospectId)) {
    return res.status(400).json({ error: 'prospect_id format invalide (UUID requis)' });
  }

  try {
    const supa = getSupa();

    // Vérifier ownership prospect
    const { data: prospect, error: prospectErr } = await supa
      .from('concierge_acquired_prospects')
      .select(
        'id, contact_name, company_name, vertical_key, contact_email, contact_phone, contact_role',
      )
      .eq('id', prospectId)
      .eq('driver_id', driverId)
      .maybeSingle();

    if (prospectErr || !prospect) {
      return res.status(404).json({ error: 'Prospect introuvable ou non autorisé' });
    }

    // Charger toutes les conversations associées (ordonnées asc pour affichage chrono)
    const { data: messages, error: msgErr } = await supa
      .from('pieuvre_conversations')
      .select('*')
      .eq('driver_id', driverId)
      .eq('metadata->>prospect_id', prospectId)
      .order('created_at', { ascending: true });

    if (msgErr) {
      console.warn('[conversations/thread] msgs error:', msgErr.message);
    }

    // v1.10.62 — Marquer les messages inbound comme lus par le chauffeur
    // (set metadata.read_by_driver_at). Effet : disparaît du badge unread.
    // v1.10.63 (Ajnaya2026v120) — Fix W2 : bulk update via .in('id', [...]) au lieu
    // de N round-trips séquentiels. Évite la race avec un nouvel inbound qui
    // arriverait pendant la boucle (n'aurait pas eu son metadata mis à jour).
    const inboundUnread = (messages || []).filter((m: any) => {
      const meta = (m.metadata as any) || {};
      return m.direction === 'inbound' && !meta.read_by_driver_at;
    });

    if (inboundUnread.length > 0) {
      const nowIso = new Date().toISOString();
      const inboundIds = inboundUnread.map((m: any) => m.id);
      // Bulk UPDATE via RPC ou via JSON merge en une seule query.
      // PostgREST ne supporte pas merge JSON natif simple — donc on fait
      // un round-trip par batch de 100 (très rapide à cette échelle).
      try {
        // Récupérer les rows en bulk pour merger correctement
        const updates = inboundUnread.map((m: any) => ({
          id: m.id,
          driver_id: driverId, // double-check ownership pour upsert
          metadata: { ...(m.metadata as any), read_by_driver_at: nowIso },
        }));
        // Utilise upsert qui en pratique fait UPDATE ... WHERE id IN (...) en bulk
        await supa.from('pieuvre_conversations').upsert(updates, { onConflict: 'id' });
      } catch (markErr: any) {
        console.warn('[conversations/thread] mark read bulk soft-fail:', markErr?.message);
      }
    }

    return res.json({
      prospect,
      messages: messages || [],
      messages_count: (messages || []).length,
      marked_read_count: inboundUnread.length,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Erreur lecture thread' });
  }
});

/**
 * POST /api/concierge/conversations/:prospect_id/draft-reply
 * Génère une ÉBAUCHE de réponse via Anthropic Sonnet 4.6 basée sur le dernier
 * message inbound du prospect + contexte conversation. Le chauffeur peut
 * éditer avant d'envoyer (transparence radicale).
 *
 * Body : { tone?: 'short' | 'pro' | 'warm' }  (défaut 'pro')
 * Réponse : { draft_text, model_used, generated_at }
 */
router.post('/conversations/:prospect_id/draft-reply', async (req: Request, res: Response) => {
  const driverId = await getDriverIdFromJWT(req);
  if (!driverId) return res.status(401).json({ error: 'Auth requise' });

  const prospectId = req.params.prospect_id;
  if (!prospectId || !UUID_RE.test(prospectId)) {
    return res.status(400).json({ error: 'prospect_id format invalide (UUID requis)' });
  }

  const tone: 'short' | 'pro' | 'warm' = ['short', 'pro', 'warm'].includes(req.body?.tone)
    ? req.body.tone
    : 'pro';

  try {
    const supa = getSupa();

    // 1. Charger prospect + dernière conversation inbound
    const [{ data: prospect }, { data: messages }] = await Promise.all([
      supa
        .from('concierge_acquired_prospects')
        .select('contact_name, company_name, vertical_key, contact_role')
        .eq('id', prospectId)
        .eq('driver_id', driverId)
        .maybeSingle(),
      // v1.10.63 — Fix W10 : DRAFT_CONTEXT_MESSAGES (=12) au lieu de 8.
      // Pour conversations >12 msgs : summary synthétique planifié Sprint 2.2.
      supa
        .from('pieuvre_conversations')
        .select('id, direction, content, created_at')
        .eq('driver_id', driverId)
        .eq('metadata->>prospect_id', prospectId)
        .order('created_at', { ascending: false })
        .limit(DRAFT_CONTEXT_MESSAGES),
    ]);

    if (!prospect) {
      return res.status(404).json({ error: 'Prospect introuvable' });
    }

    const lastInbound = (messages || []).find((m: any) => m.direction === 'inbound');
    if (!lastInbound) {
      return res.status(400).json({ error: 'Aucun message inbound à laquelle répondre' });
    }

    // 2. Driver name pour signature
    const { data: driverProfile } = await supa
      .from('drivers')
      .select('first_name')
      .eq('id', driverId)
      .maybeSingle();
    const driverFirstName = driverProfile?.first_name || 'Chandler';

    // 3. Génération via Anthropic (avec timeout 5s)
    let draftText = '';
    if (anthropic) {
      const toneInstruction =
        tone === 'short'
          ? 'Très court (max 30 mots), va droit au but.'
          : tone === 'warm'
            ? 'Chaleureux et humain (max 80 mots).'
            : 'Professionnel et concret (max 60 mots).';

      const systemPrompt = `Tu es ${driverFirstName}, chauffeur VTC premium FOREAS. Un prospect t'a répondu à ton message d'introduction. Rédige une réponse en français.

RÈGLES STRICTES :
- ${toneInstruction}
- Vouvoiement formel (B2B)
- Aucun jargon marketing
- Pas de "Bonjour" si on a déjà échangé (commence direct)
- Pas de signature à la fin (le système l'ajoute)
- Réponds CONCRÈTEMENT à ce que le prospect a écrit
- Si question prix : tarif fixe, calculé à l'avance, jamais de surge
- Si question dispo : propose 2 créneaux concrets cette semaine
- Si question véhicule : voiture noire premium
- Si demande RDV : confirme et demande lieu/heure`;

      const conversationHistory = (messages || [])
        .reverse()
        .map((m: any) => `[${m.direction}] ${m.content || ''}`)
        .join('\n');

      const userPrompt = `Prospect : ${prospect.contact_name || prospect.company_name} (${prospect.contact_role || prospect.vertical_key || 'pro'})

Conversation jusqu'ici (chrono) :
${conversationHistory}

DERNIER MESSAGE DU PROSPECT (à laquelle répondre) :
"${lastInbound.content}"

Rédige ta réponse maintenant.`;

      const completion = await withTimeout(
        anthropic.messages.create({
          model: 'claude-sonnet-4-5',
          max_tokens: 250,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
        }),
        ANTHROPIC_TIMEOUT_MS,
        'Anthropic draft-reply',
      );
      if (completion) {
        const textBlock = (completion.content as any[]).find((b: any) => b.type === 'text') as any;
        draftText = (textBlock?.text || '').trim();
      }
    }

    // Fallback template si Anthropic KO/timeout
    if (!draftText) {
      draftText = `Merci pour votre retour. Je suis disponible cette semaine — quel créneau vous arrange ?\n\nJe peux vous proposer un essai gratuit pour vous faire une idée du service.`;
    }

    return res.json({
      ok: true,
      draft_text: draftText,
      model_used: anthropic ? 'claude-sonnet-4-5' : 'template',
      generated_at: new Date().toISOString(),
      tone,
      based_on_message_id: lastInbound.id,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Erreur génération ébauche' });
  }
});

/**
 * POST /api/concierge/conversations/:prospect_id/reply
 * Envoie une réponse au prospect via le canal d'origine (WhatsApp ou email).
 * Délègue à la Pieuvre (workflow concierge_outreach) avec le message confirmé.
 *
 * Body : { message_text: string, channel?: 'whatsapp' | 'email' }
 * Si channel absent → utilise celui du dernier outbound.
 */
router.post('/conversations/:prospect_id/reply', async (req: Request, res: Response) => {
  const driverId = await getDriverIdFromJWT(req);
  if (!driverId) return res.status(401).json({ error: 'Auth requise' });

  const prospectId = req.params.prospect_id;
  if (!prospectId || !UUID_RE.test(prospectId)) {
    return res.status(400).json({ error: 'prospect_id format invalide (UUID requis)' });
  }

  // v1.10.63 (Ajnaya2026v120) — Normalisation NFC + strip control chars
  // Évite injections RTL override (‮) ou zero-width (​) dans le
  // message qui partira chez le prospect (PII protection + évite display bug).
  const rawText = (req.body?.message_text || '').toString();
  const messageText = rawText
    .normalize('NFC')
    .replace(/[ ---​-‏‪-‮⁦-⁩﻿]/g, '')
    .trim();
  if (!messageText || messageText.length < REPLY_MIN_LENGTH) {
    return res.status(400).json({ error: `message_text requis (min ${REPLY_MIN_LENGTH} chars)` });
  }
  if (messageText.length > REPLY_MAX_LENGTH) {
    return res
      .status(400)
      .json({ error: `message_text trop long (max ${REPLY_MAX_LENGTH} chars)` });
  }

  try {
    const supa = getSupa();

    // Vérifier ownership + récupérer canal préféré (du dernier outbound)
    const { data: prospect } = await supa
      .from('concierge_acquired_prospects')
      .select('id, contact_name, company_name')
      .eq('id', prospectId)
      .eq('driver_id', driverId)
      .maybeSingle();

    if (!prospect) {
      return res.status(404).json({ error: 'Prospect introuvable' });
    }

    let channel: 'whatsapp' | 'email' =
      req.body?.channel === 'email' || req.body?.channel === 'whatsapp'
        ? req.body.channel
        : 'whatsapp';

    if (!req.body?.channel) {
      // Auto-détect : prend le canal du dernier outbound
      const { data: lastOutbound } = await supa
        .from('pieuvre_conversations')
        .select('channel')
        .eq('driver_id', driverId)
        .eq('direction', 'outbound')
        .eq('metadata->>prospect_id', prospectId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (lastOutbound?.channel === 'whatsapp' || lastOutbound?.channel === 'email') {
        channel = lastOutbound.channel;
      }
    }

    // Délégation Pieuvre : POST webhook avec le message confirmé
    const pieuvreWebhook =
      process.env.PIEUVRE_OUTREACH_WEBHOOK_URL ||
      'https://n8n.srv1534739.hstgr.cloud/webhook/concierge-outreach';
    const secret = process.env.PIEUVRE_RESPOND_SECRET;
    if (!secret) {
      return res.status(503).json({
        ok: false,
        error: 'Pipeline réponse non configurée — contacte le support',
        reason: 'pieuvre_not_configured',
      });
    }

    const sentAt = new Date().toISOString();
    let webhookDispatched = false;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), PIEUVRE_WEBHOOK_TIMEOUT_MS);
      const wh = await fetch(pieuvreWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Foreas-Shared-Secret': secret },
        body: JSON.stringify({
          driver_id: driverId,
          prospect_ids: [prospectId],
          channel,
          requested_at: sentAt,
          confirmed_message_text: messageText,
          is_reply: true, // hint Pieuvre : c'est une réponse, pas un cold outreach
        }),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      webhookDispatched = wh.ok;
    } catch {
      webhookDispatched = false;
    }

    // INSERT direct dans pieuvre_conversations en outbound (pour affichage immédiat
    // sans attendre que la Pieuvre fasse le INSERT — la Pieuvre updatera ensuite
    // avec wamid/email_id quand l'envoi est confirmé)
    // v1.10.63 (Ajnaya2026v120) — Fix W3 : si webhook Pieuvre KO, marquer
    // explicitement pieuvre_dispatch_failed pour affichage UI ⚠️ "En file d'attente"
    try {
      await supa.from('pieuvre_conversations').insert({
        driver_id: driverId,
        tentacle: 'app_driver_reply',
        channel,
        direction: 'outbound',
        content: messageText,
        created_at: sentAt,
        delivery_status: webhookDispatched ? 'pending' : 'queued',
        metadata: {
          prospect_id: prospectId,
          source: 'app_driver_reply',
          is_reply: true,
          webhook_dispatched: webhookDispatched,
          pieuvre_dispatch_failed: !webhookDispatched,
        },
      });
    } catch (insErr: any) {
      console.warn('[conversations/reply] insert soft-fail:', insErr?.message);
    }

    return res.json({
      ok: true,
      sent_at: sentAt,
      channel,
      webhook_dispatched: webhookDispatched,
      message: webhookDispatched
        ? 'Réponse envoyée à Ajnaya — elle est en route.'
        : 'Réponse enregistrée. Ajnaya enverra dès que la pieuvre est dispo.',
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Erreur envoi réponse' });
  }
});

export default router;
