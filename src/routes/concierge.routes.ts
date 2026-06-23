/**
 * concierge.routes.ts — Endpoints pour le widget Ajnaya côté sites perso
 * ════════════════════════════════════════════════════════════════════════
 * Sprint Activation Conciergerie 30/04/2026.
 *
 * Routes appelées par le widget JS embarqué dans driverSiteTemplate.ts :
 *
 *   POST /api/concierge/:slug/chat
 *     → reçoit le message visiteur, appelle Pieuvre avec
 *       tentacle = 'concierge_personnel', logge le tour dans
 *       concierge_funnel_events + pieuvre_conversations
 *
 *   POST /api/concierge/:slug/track-event
 *     → log un event funnel (widget_opened, payment_link_clicked, etc.)
 *
 * Le widget tourne dans le navigateur des visiteurs (PAS authentifiés).
 * On n'utilise donc pas de JWT — on identifie par site_slug et session_id.
 *
 * Conformité AJNAYA_CONTRACTS.md §8 (payload Pieuvre Responder) et
 * AJNAYA_NORTH_STAR.md §2.9 (« tentacule ≠ cerveau »).
 */
import { Router, Request, Response } from 'express';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  callPieuvreBrain,
  isPieuvreBrainEnabled,
  type PieuvreTentacle,
  type PieuvreCanal,
} from '../lib/pieuvre-client';

const router = Router();

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

// CORS permissif pour widget embarqué (les sites perso peuvent être sur des
// sous-domaines variés foreas.xyz/jean-dupont, ou plus tard sur des domaines
// custom). La sécurité passe par le slug + rate-limiting.
function setCors(res: Response): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
}

router.options('/:slug/chat', (_req, res) => {
  setCors(res);
  res.status(204).send();
});
router.options('/:slug/track-event', (_req, res) => {
  setCors(res);
  res.status(204).send();
});

// ════════════════════════════════════════════════════════════════════════
// POST /api/concierge/:slug/chat
// ════════════════════════════════════════════════════════════════════════
router.post('/:slug/chat', async (req: Request, res: Response) => {
  setCors(res);
  const slug = (req.params.slug || '').replace(/[^a-z0-9-]/gi, '');
  const { message, session_id, history } = req.body || {};

  if (!slug) {
    return res.status(400).json({ error: 'site_slug invalide' });
  }
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message requis' });
  }
  if (!session_id) {
    return res.status(400).json({ error: 'session_id requis' });
  }

  const startTime = Date.now();

  try {
    const supa = getSupa();

    // 1. Charger le site + tarifs du chauffeur
    const { data: site } = await supa
      .from('driver_sites')
      .select('id, driver_id, display_name, slug, pricing, city, niche')
      .eq('slug', slug)
      .eq('is_active', true)
      .maybeSingle();

    if (!site) {
      return res.status(404).json({ error: 'Site chauffeur introuvable' });
    }

    // 2. Pieuvre Brain — tentacle 'concierge_personnel'
    if (!isPieuvreBrainEnabled()) {
      return res.status(503).json({
        error: 'Service indisponible. Réessaie dans quelques minutes.',
      });
    }

    const pieuvreReply = await callPieuvreBrain({
      tentacle: 'concierge_personnel' as PieuvreTentacle,
      canal: 'web' as PieuvreCanal,
      identity_id: null, // pas encore identifié — capture viendra plus tard
      session_id,
      message: { role: 'user', text: message.trim(), type: 'text' },
      context: {
        page_source: `https://foreas.xyz/${slug}`,
        history_last_10: (history || []).slice(-10),
        // Contexte chauffeur pour personnalisation prompt Pieuvre
        driver_first_name: (site.display_name || '').split(' ')[0] || 'le chauffeur',
        driver_full_name: site.display_name,
        driver_city: site.city,
        driver_niche: site.niche,
        driver_pricing: site.pricing,
        site_slug: slug,
      },
      meta: {
        device: 'mobile', // sera détecté côté UA si besoin
        user_agent: (req.headers['user-agent'] as string) || '',
      },
      client_version: 'concierge-widget-v1',
    });

    if (!pieuvreReply) {
      // Fallback si Pieuvre down — message générique
      return res.json({
        text: `Bonjour ! Je suis Ajnaya, l'assistante de ${site.display_name}. Je rencontre un petit souci de connexion. Tu peux retenter dans 30 secondes ?`,
        provider: 'fallback',
        response_time_ms: Date.now() - startTime,
      });
    }

    // 3. Logger le tour dans pieuvre_conversations (inbound + outbound)
    //    + concierge_funnel_events (premier message si applicable)
    const insertConvos = supa.from('pieuvre_conversations').insert([
      {
        driver_id: site.driver_id,
        tentacle: 'concierge_personnel',
        channel: 'web',
        direction: 'inbound',
        message_type: 'text',
        content: message.trim(),
        metadata: { site_slug: slug, session_id },
      },
      {
        driver_id: site.driver_id,
        tentacle: 'concierge_personnel',
        channel: 'web',
        direction: 'outbound',
        message_type: 'text',
        content: pieuvreReply.reply.text,
        llm_model: pieuvreReply.reply.llm_model,
        llm_cost_usd: pieuvreReply.metadata?.cost_usd,
        sentiment: pieuvreReply.sentiment,
        objection_detected: pieuvreReply.objection_detected || null,
        metadata: {
          site_slug: slug,
          session_id,
          intent_detected: pieuvreReply.intent_detected,
          latency_ms: pieuvreReply.metadata?.latency_ms,
        },
      },
    ]);

    // Funnel event : 'first_message_sent' si historique vide
    const funnelEvent =
      (history || []).length === 0
        ? supa.from('concierge_funnel_events').insert({
            driver_id: site.driver_id,
            site_slug: slug,
            event_type: 'first_message_sent',
            source: 'widget',
            meta: {
              session_id,
              first_message_length: message.length,
              intent_detected: pieuvreReply.intent_detected,
            },
          })
        : Promise.resolve();

    // Si Pieuvre détecte une objection → tracer dans concierge_objections
    const objectionInsert = pieuvreReply.objection_detected
      ? supa.from('concierge_objections').insert({
          driver_id: site.driver_id,
          conversation_id: null,
          objection_text: message.trim(),
          objection_code: pieuvreReply.objection_detected,
          ajnaya_response: pieuvreReply.reply.text,
          llm_model: pieuvreReply.reply.llm_model,
          outcome: 'pending',
        })
      : Promise.resolve();

    // Logging non-bloquant — on ne fait pas échouer la réponse user si la DB
    // est temporairement indisponible
    Promise.all([insertConvos, funnelEvent, objectionInsert]).catch((err) => {
      console.warn('[Concierge] DB log error (non-blocking):', err?.message);
    });

    // 4. Retour au widget — texte + signal éventuel pour booking
    return res.json({
      text: pieuvreReply.reply.text,
      content: pieuvreReply.reply.text,
      response: pieuvreReply.reply.text,
      provider: 'pieuvre-brain',
      llm_model: pieuvreReply.reply.llm_model,
      intent_detected: pieuvreReply.intent_detected,
      sentiment: pieuvreReply.sentiment,
      next_actions: pieuvreReply.next_actions,
      // Si Pieuvre signale une intention de booking dans next_actions, le
      // widget affichera la carte de paiement (Sprint 1.5 — à implémenter
      // côté workflow N8N concierge_personnel)
      booking: null,
      response_time_ms: Date.now() - startTime,
    });
  } catch (err: any) {
    console.error('[Concierge] /chat error:', err?.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ════════════════════════════════════════════════════════════════════════
// POST /api/concierge/:slug/track-event
// ════════════════════════════════════════════════════════════════════════
router.post('/:slug/track-event', async (req: Request, res: Response) => {
  setCors(res);
  const slug = (req.params.slug || '').replace(/[^a-z0-9-]/gi, '');
  const { event_type, session_id, meta, prospect_id, conversation_id, booking_id } = req.body || {};

  if (!slug || !event_type) {
    return res.status(400).json({ error: 'slug + event_type requis' });
  }

  // Whitelist des event_types acceptés (évite l'injection de valeurs arbitraires
  // qui violeraient la check constraint de concierge_funnel_events)
  const ALLOWED_EVENTS = [
    'widget_opened',
    'first_message_sent',
    'name_captured',
    'phone_captured',
    'email_captured',
    'destination_quoted',
    'price_quoted',
    'objection_raised',
    'booking_initiated',
    'booking_confirmed',
    'payment_link_sent',
    'payment_link_clicked',
    'payment_completed',
    'booking_cancelled',
    'booking_completed',
    'review_submitted',
    'churned',
  ];

  if (!ALLOWED_EVENTS.includes(event_type)) {
    return res.status(400).json({ error: 'event_type invalide' });
  }

  try {
    const supa = getSupa();

    // Résoudre driver_id depuis le slug (lookup léger)
    const { data: site } = await supa
      .from('driver_sites')
      .select('driver_id')
      .eq('slug', slug)
      .maybeSingle();

    if (!site) {
      return res.status(404).json({ error: 'Site introuvable' });
    }

    // payment_link_clicked n'existe pas dans la check constraint — on le mappe
    const dbEventType = event_type === 'payment_link_clicked' ? 'payment_link_sent' : event_type;

    await supa.from('concierge_funnel_events').insert({
      driver_id: site.driver_id,
      site_slug: slug,
      prospect_id: prospect_id || null,
      conversation_id: conversation_id || null,
      booking_id: booking_id || null,
      event_type: dbEventType,
      source: 'widget',
      meta: { ...(meta || {}), session_id, original_event_type: event_type },
    });

    return res.json({ ok: true });
  } catch (err: any) {
    console.warn('[Concierge] track-event error:', err?.message);
    return res.status(500).json({ error: 'Erreur tracking' });
  }
});

export default router;
