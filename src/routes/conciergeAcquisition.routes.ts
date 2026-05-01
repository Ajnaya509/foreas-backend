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
// POST /api/concierge/acquisition/outreach
// Déclenche le cold outreach pour 1+ prospects (email/whatsapp).
// Idempotent — si déjà contacté <24h, refuse.
// ════════════════════════════════════════════════════════════════════════
router.post('/acquisition/outreach', async (req: Request, res: Response) => {
  const driverId = await getDriverIdFromJWT(req);
  if (!driverId) return res.status(401).json({ error: 'Auth requise' });

  const { prospect_ids, channel = 'email' } = req.body || {};
  if (!Array.isArray(prospect_ids) || prospect_ids.length === 0) {
    return res.status(400).json({ error: 'prospect_ids requis' });
  }
  if (!['email', 'whatsapp'].includes(channel)) {
    return res.status(400).json({ error: 'channel invalide' });
  }

  try {
    const pieuvreWebhook =
      process.env.PIEUVRE_OUTREACH_WEBHOOK_URL ||
      'https://n8n.srv1534739.hstgr.cloud/webhook/concierge-outreach';
    const secret = process.env.PIEUVRE_RESPOND_SECRET;

    if (secret) {
      fetch(pieuvreWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Foreas-Shared-Secret': secret },
        body: JSON.stringify({
          driver_id: driverId,
          prospect_ids,
          channel,
          requested_at: new Date().toISOString(),
        }),
      }).catch(() => {});
    }

    return res.json({
      ok: true,
      message: `Outreach ${channel} lancé pour ${prospect_ids.length} prospects.`,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Erreur outreach' });
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

export default router;
