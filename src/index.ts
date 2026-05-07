/**
 * FOREAS Backend - Production Entry Point
 * ========================================
 * RÈGLES DE BOOT:
 * 1. /health répond AVANT tout import lourd
 * 2. Stripe = lazy (premier usage)
 * 3. Supabase = lazy (via OTP routes)
 * 4. Version = SHA Git via env
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';

// ── Driver Site Template (v3.0) ──
import { renderDriverPage as renderDriverPageV3 } from './driverSiteTemplate.js';

// ── Real Supabase + Email imports for Stripe webhooks ──
import { upsertUserByEmail, setSubscriptionStatus, logEvent } from './services/supa.js';
import {
  sendSubscriptionActivated,
  sendPaymentSucceeded,
  sendPaymentFailed1,
  sendPaymentFailed2,
  sendPaymentFailedFinal,
  sendSubscriptionSuspended,
  sendSubscriptionCanceled,
  sendSubscriptionReactivated,
  sendPlanChanged,
} from './services/email.js';

// ============================================
// APP INIT - UN SEUL express()
// ============================================
const app = express();
app.use(cors());

// ============================================
// CONSTANTES BOOT
// ============================================
const START_TIME = Date.now();
const GIT_SHA = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_SHA || 'dev';
const VERSION = process.env.npm_package_version || '2.1.0';
const PORT = Number(process.env.PORT) || 8080;
const HOST = '0.0.0.0';

// ============================================
// HEALTH CHECK - PRIORITÉ ABSOLUE
// Répond IMMÉDIATEMENT, AVANT tout import lourd
// Railway healthcheck attend 200 + body non-vide
// ============================================
app.get('/health', (_req, res) => {
  // Texte simple pour Railway healthcheck (pas JSON)
  res.status(200).send(`OK v${VERSION} sha:${GIT_SHA.substring(0, 7)}`);
});

app.get('/version', (_req, res) => {
  res.status(200).json({
    version: VERSION,
    sha: GIT_SHA,
    env: process.env.NODE_ENV || 'production',
    node: process.version,
    uptime_ms: Date.now() - START_TIME,
    modules: {
      data_platform: 'v1',
      ai_service: 'v1',
      rbac: 'v1',
    },
  });
});

app.get('/', (_req, res) => {
  res.send(`FOREAS Backend v${VERSION} (${GIT_SHA.substring(0, 7)})`);
});

// ── CANARY ROUTE (debug Railway cache) ─────────────────────────────────
// Si celle-ci retourne 404 alors que root montre ce commit,
// Railway sert un vieux binaire malgré le SHA affiché.
app.get('/canary-abc123xyz', (_req, res) => {
  res.json({
    canary: 'abc123xyz',
    commit: GIT_SHA,
    ts: new Date().toISOString(),
    message: 'If you see this, Railway is running fresh code.',
  });
});

// ── ZONES LIVE : TOP-LEVEL MOUNT (zéro indirection Railway) ──
// Mount DIRECT à côté des autres routes statiques. Si ceci échoue, tout échoue.
let __zoneCache: any = null;
const __ZONE_CACHE_TTL = 30_000;
app.get('/api/zones/health', (_req, res) => {
  res.json({
    ok: true,
    mountMode: 'TOP_LEVEL',
    cacheAgeMs: __zoneCache ? Date.now() - __zoneCache.refreshedAt : null,
    lastSourcesUsed: __zoneCache?.sources || [],
    lastDataQuality: __zoneCache?.dataQuality || 'unknown',
  });
});
app.get('/api/zones/live', async (req, res) => {
  const now = Date.now();
  const bypassCache = req.query.nocache === '1';
  if (!bypassCache && __zoneCache && now - __zoneCache.refreshedAt < __ZONE_CACHE_TTL) {
    return res.json({
      zones: __zoneCache.zones,
      sourcesUsed: __zoneCache.sources,
      dataQuality: 'cached',
      refreshedAt: new Date(__zoneCache.refreshedAt).toISOString(),
      cacheAgeMs: now - __zoneCache.refreshedAt,
      alerts: __zoneCache.alerts || [],
      opportunities: __zoneCache.opportunities || [],
    });
  }
  try {
    const { fuse } = await import('./services/AjnayaFusionEngine.js');
    const ctx = await fuse('', (req.query.driverId as string) || undefined);
    const stl = (s: number) => (s >= 80 ? 'SURGE' : s >= 60 ? 'HIGH' : s >= 35 ? 'MEDIUM' : 'LOW');
    const stm = (s: number) =>
      s >= 85 ? 2.0 : s >= 70 ? 1.5 : s >= 55 ? 1.25 : s >= 40 ? 1.1 : 1.0;
    const ste = (s: number) =>
      s >= 85
        ? '€45-60/h'
        : s >= 70
          ? '€35-50/h'
          : s >= 55
            ? '€28-40/h'
            : s >= 40
              ? '€22-32/h'
              : '€18-25/h';
    const zones = ctx.demandZones.map((z: any) => ({
      name: z.zone,
      score: z.score,
      level: stl(z.score),
      surgeMultiplier: stm(z.score),
      estimatedEarnings: ste(z.score),
      reasons: z.reasons.slice(0, 3),
      sources: z.sources,
    }));
    const dataQuality = ctx.sourcesUsed.some((s: string) =>
      ['openweather', 'predicthq', 'sncf', 'tomtom', 'idfm', 'bolt'].includes(s),
    )
      ? 'live'
      : 'simulated';
    __zoneCache = {
      zones,
      sources: ctx.sourcesUsed,
      dataQuality,
      refreshedAt: now,
      alerts: ctx.alerts,
      opportunities: ctx.opportunities,
    };
    res.json({
      zones,
      sourcesUsed: ctx.sourcesUsed,
      dataQuality,
      refreshedAt: new Date(now).toISOString(),
      cacheAgeMs: 0,
      latencyMs: ctx.totalLatency,
      alerts: ctx.alerts,
      opportunities: ctx.opportunities,
    });
  } catch (err: any) {
    console.error('[zones.live] fuse() failed:', err?.message || err);
    if (__zoneCache) {
      return res.json({
        zones: __zoneCache.zones,
        sourcesUsed: __zoneCache.sources,
        dataQuality: 'cached',
        refreshedAt: new Date(__zoneCache.refreshedAt).toISOString(),
        cacheAgeMs: now - __zoneCache.refreshedAt,
        warning: 'stale cache — fusion engine failed',
      });
    }
    res.status(503).json({
      error: 'Fusion engine unavailable',
      zones: [],
      sourcesUsed: [],
      dataQuality: 'simulated',
      refreshedAt: new Date(now).toISOString(),
    });
  }
});
console.log('[FOREAS] /api/zones/live and /api/zones/health mounted at top-level');

// Legal pages served by Vercel (foreas.xyz) — /cgu, /confidentialite, /mentions-legales, /suppression-compte

// ============================================
// INTERNAL ROUTES - Protégées par SERVICE_ROLE_KEY
// Pour cron jobs, ingestion RAG, opérations internes
// ============================================
app.post('/api/internal/rag/ingest', express.json(), async (req, res) => {
  const authHeader = req.headers.authorization;
  const validKeys = [process.env.SUPABASE_SERVICE_ROLE_KEY, process.env.FOREAS_SERVICE_KEY].filter(
    Boolean,
  );

  if (
    validKeys.length === 0 ||
    !authHeader ||
    !validKeys.some((k) => authHeader === `Bearer ${k}`)
  ) {
    return res.status(401).json({ error: 'Invalid service key' });
  }

  try {
    const { ingestKnowledgeBase, reingestKnowledgeBase } =
      await import('./ai/rag/ingestKnowledgeBase.js');
    const force = req.body?.force === true;
    const sync = req.body?.sync === true;
    console.log(`[Internal] RAG ingestion triggered (force=${force}, sync=${sync})`);

    if (sync) {
      const result = force ? await reingestKnowledgeBase() : await ingestKnowledgeBase();
      res.json({ success: true, ...result });
    } else {
      // Async — retour immédiat, ingestion en background
      res.json({ success: true, status: 'started', message: 'Ingestion lancée en background' });
      (force ? reingestKnowledgeBase() : ingestKnowledgeBase())
        .then((r) => console.log(`[Internal] RAG ingestion done: ${r.documentsIndexed} docs`))
        .catch((e) => console.error(`[Internal] RAG ingestion failed: ${e.message}`));
    }
  } catch (err: any) {
    console.error('[Internal] RAG ingestion error:', err);
    res.status(500).json({ error: `Ingestion failed: ${err.message}` });
  }
});

// ============================================
// INTERNAL: Backfill embeddings for existing document_chunks
// (Pour chunks déjà insérés en SQL sans embedding — namespace ajnaya_product PHASE B)
// ============================================
app.post('/api/internal/rag/backfill-embeddings', express.json(), async (req, res) => {
  const authHeader = req.headers.authorization;
  const validKeys = [process.env.SUPABASE_SERVICE_ROLE_KEY, process.env.FOREAS_SERVICE_KEY].filter(
    Boolean,
  );
  if (
    validKeys.length === 0 ||
    !authHeader ||
    !validKeys.some((k) => authHeader === `Bearer ${k}`)
  ) {
    return res.status(401).json({ error: 'Invalid service key' });
  }

  const namespace = (req.body?.namespace as string) || 'ajnaya_product';
  const limit = Math.min(Math.max(Number(req.body?.limit) || 100, 1), 500);

  try {
    const { createClient } = await import('@supabase/supabase-js');
    const sb = createClient(
      process.env.SUPABASE_URL || process.env.URL_SUPABASE || '',
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '',
    );

    const { data: chunks, error: fetchErr } = await sb
      .from('document_chunks')
      .select('id, chunk_text')
      .eq('namespace', namespace)
      .is('embedding', null)
      .limit(limit);

    if (fetchErr) return res.status(500).json({ error: `Fetch failed: ${fetchErr.message}` });
    if (!chunks || chunks.length === 0)
      return res.json({ success: true, indexed: 0, message: 'No chunks to backfill' });

    const { getOpenAIClient } = await import('./ai/llm/providers/OpenAIClient.js');
    const openai = getOpenAIClient();
    if (!openai.isConfigured()) return res.status(500).json({ error: 'OpenAI not configured' });

    let indexed = 0;
    const errors: string[] = [];

    // Batch by 16 to stay under OpenAI rate limits
    for (let i = 0; i < chunks.length; i += 16) {
      const batch = chunks.slice(i, i + 16);
      try {
        const resp = await openai.embed({
          model: 'text-embedding-3-small',
          input: batch.map((c) => c.chunk_text || ''),
        });
        for (let j = 0; j < batch.length; j++) {
          const emb = resp.embeddings[j];
          if (emb && emb.length === 1536) {
            const { error: upErr } = await sb
              .from('document_chunks')
              .update({ embedding: `[${emb.join(',')}]` })
              .eq('id', batch[j].id);
            if (upErr) errors.push(`${batch[j].id}: ${upErr.message}`);
            else indexed++;
          }
        }
      } catch (e: any) {
        errors.push(`Batch ${i}: ${e.message}`);
      }
    }

    res.json({
      success: true,
      namespace,
      total: chunks.length,
      indexed,
      errors: errors.slice(0, 5),
    });
  } catch (err: any) {
    console.error('[Internal] Backfill error:', err);
    res.status(500).json({ error: `Backfill failed: ${err.message}` });
  }
});

// ============================================
// LAZY STRIPE - Chargé au premier usage
// ============================================
let stripeClient: import('stripe').default | null = null;

async function getStripe(): Promise<import('stripe').default> {
  if (!stripeClient) {
    const Stripe = (await import('stripe')).default;
    const key = process.env.STRIPE_SECRET_KEY as string;
    console.log(
      '[Stripe] Initializing with key:',
      key ? `${key.substring(0, 12)}...${key.substring(key.length - 4)}` : 'MISSING',
    );
    stripeClient = new Stripe(key, {
      maxNetworkRetries: 3,
      timeout: 30000,
    });
    console.log('[Stripe] Client initialized successfully');
  }
  return stripeClient;
}

// ============================================
// PIEUVRE MLM WEBHOOK — fire-and-forget
// ============================================
/**
 * Notifie Pieuvre N8N d'un événement MLM.
 * Jamais bloquant — l'absence de Pieuvre ne casse pas le flux Stripe.
 */
function notifyPieuvreMlmEvent(event: string, payload: Record<string, any>): void {
  const webhookUrl = process.env.PIEUVRE_MLM_WEBHOOK_URL;
  const secret = process.env.PIEUVRE_MLM_SECRET;
  if (!webhookUrl || !secret) return;
  fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Foreas-Shared-Secret': secret,
    },
    body: JSON.stringify({ event, ...payload }),
  }).catch((err) => {
    console.warn(`[Pieuvre] fire-and-forget failed for event "${event}":`, err?.message);
  });
  console.log(`[Pieuvre] Notified event="${event}"`);
}

// ============================================
// STRIPE WEBHOOK - AVANT express.json()
// ============================================
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'] as string | undefined;
  const whSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!sig || !whSecret) {
    return res.status(400).send('Missing signature or secret');
  }

  let event: import('stripe').Stripe.Event;
  try {
    const stripe = await getStripe();
    event = stripe.webhooks.constructEvent(req.body, sig, whSecret);
  } catch (err: any) {
    console.error(`[Stripe] Webhook signature error: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    // ── checkout.session.completed ──
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as any;
      console.log('✅ checkout.session.completed', session.id);
      if (session.customer_email) {
        const user = await upsertUserByEmail(session.customer_email);
        const planName = session.metadata?.plan_name || 'FOREAS Pro';
        await setSubscriptionStatus({
          userId: user.id,
          provider: 'stripe',
          status: 'active',
          currentPeriodEnd: null,
          productId: session.metadata?.price_id || null,
        });
        await logEvent(user.id, 'checkout.session.completed', session);
        await sendSubscriptionActivated(
          session.customer_email,
          session.metadata?.name || 'Chauffeur',
          planName,
        );
        console.log('✅ Subscription activée pour:', session.customer_email);
      }

      // ── MLM : attribution parrainage au checkout ──
      // Si client_reference_id = code parrainage, on lie le filleul à son sponsor
      if (session.client_reference_id && session.customer_email) {
        try {
          const supaAdmin = await getSupabaseAdmin();
          const referralCode = String(session.client_reference_id).toUpperCase().trim();

          // Trouver le nouveau chauffeur (créé par upsertUserByEmail ci-dessus)
          const { data: newDriver } = await supaAdmin
            .from('drivers')
            .select('id, referred_by, referred_by_partner')
            .eq('email', session.customer_email)
            .maybeSingle();

          if (newDriver && !newDriver.referred_by && !newDriver.referred_by_partner) {
            // 1) Chercher sponsor chauffeur par referral_code
            const { data: sponsorDriver } = await supaAdmin
              .from('drivers')
              .select('id')
              .eq('referral_code', referralCode)
              .maybeSingle();

            if (sponsorDriver) {
              await supaAdmin
                .from('drivers')
                .update({ referred_by: sponsorDriver.id })
                .eq('id', newDriver.id);
              // Créer le lien N1 dans la table referrals (idempotent via upsert)
              await supaAdmin.from('referrals').upsert(
                {
                  sponsor_id: sponsorDriver.id,
                  referred_id: newDriver.id,
                  level: 1,
                  status: 'active',
                },
                { onConflict: 'sponsor_id,referred_id' },
              );
              console.log(
                `[MLM] Driver ${newDriver.id} parrainé par driver ${sponsorDriver.id} (code=${referralCode})`,
              );
            } else {
              // 2) Chercher sponsor partner par referral_code
              const { data: sponsorPartner } = await supaAdmin
                .from('partners')
                .select('id')
                .eq('referral_code', referralCode)
                .maybeSingle();

              if (sponsorPartner) {
                await supaAdmin
                  .from('drivers')
                  .update({ referred_by_partner: sponsorPartner.id })
                  .eq('id', newDriver.id);
                // Créer le lien dans partner_referrals (idempotent via upsert)
                await supaAdmin.from('partner_referrals').upsert(
                  {
                    partner_id: sponsorPartner.id,
                    driver_id: newDriver.id,
                    signup_date: new Date().toISOString(),
                    subscription_status: 'active',
                  },
                  { onConflict: 'partner_id,driver_id' },
                );
                console.log(
                  `[MLM] Driver ${newDriver.id} parrainé par partner ${sponsorPartner.id} (code=${referralCode})`,
                );
              } else {
                console.log(
                  `[MLM] checkout: code_parrainage="${referralCode}" — aucun sponsor trouvé`,
                );
              }
            }
          }
        } catch (mlmInitErr: any) {
          console.warn(
            '[MLM] Attribution parrainage checkout failed (non-blocking):',
            mlmInitErr?.message,
          );
        }
      }

      markPremiumNow();
    }

    // ── invoice.payment_succeeded ──
    if (event.type === 'invoice.payment_succeeded') {
      const invoice = event.data.object as any;
      console.log('✅ invoice.payment_succeeded', invoice.id);
      if (invoice.customer_email) {
        const user = await upsertUserByEmail(invoice.customer_email);
        const periodEnd = invoice.lines?.data?.[0]?.period?.end
          ? new Date(invoice.lines.data[0].period.end * 1000).toISOString()
          : null;
        await setSubscriptionStatus({
          userId: user.id,
          provider: 'stripe',
          status: 'active',
          currentPeriodEnd: periodEnd,
          productId: invoice.lines?.data?.[0]?.price?.id || null,
        });
        await logEvent(user.id, 'invoice.payment_succeeded', invoice);
        const amountPaid = ((invoice.amount_paid || 0) / 100).toFixed(2) + ' €';
        const nextDate = periodEnd
          ? new Date(periodEnd).toLocaleDateString('fr-FR', {
              day: 'numeric',
              month: 'long',
              year: 'numeric',
            })
          : 'prochaine échéance';
        await sendPaymentSucceeded(
          invoice.customer_email,
          invoice.customer_name || 'Chauffeur',
          amountPaid,
          nextDate,
        );
      }
      markPremiumNow();

      // ── MLM : payments_counter + qualification + Pieuvre ──
      if (invoice.customer_email) {
        try {
          const supaAdmin = await getSupabaseAdmin();
          const { data: driver } = await supaAdmin
            .from('drivers')
            .select(
              'id, payments_counter, qualified_for_referral, first_name, referred_by, referred_by_partner',
            )
            .eq('email', invoice.customer_email)
            .single();

          if (driver) {
            // 1) Incrémenter le compteur de paiements hebdomadaires consécutifs
            const newCounter = (driver.payments_counter ?? 0) + 1;
            const alreadyQualified = driver.qualified_for_referral ?? false;
            const nowQualified = newCounter >= 4;

            await supaAdmin
              .from('drivers')
              .update({
                subscription_active: true,
                payments_counter: newCounter,
                ...(nowQualified && !alreadyQualified
                  ? {
                      qualified_for_referral: true,
                      first_qualified_at: new Date().toISOString(),
                    }
                  : {}),
              })
              .eq('id', driver.id);

            console.log(
              `[MLM] Driver ${driver.id}: payments_counter=${newCounter}, qualified=${nowQualified}`,
            );

            // 2) Si vient de se qualifier → notifier Pieuvre avec les sponsors
            if (nowQualified && !alreadyQualified) {
              // Chercher N1 (referred_by = driver sponsor OU referred_by_partner = partner sponsor)
              const sponsors: Array<{ type: string; id: string; level: number; amount: number }> =
                [];
              // N1 driver
              if (driver.referred_by) {
                sponsors.push({ type: 'driver', id: driver.referred_by, level: 1, amount: 10 });
              }
              // N1 partner
              if (driver.referred_by_partner) {
                sponsors.push({
                  type: 'partner',
                  id: driver.referred_by_partner,
                  level: 1,
                  amount: 10,
                });
              }
              notifyPieuvreMlmEvent('mlm_filleul_qualified', {
                driver_id: driver.id,
                sponsors,
              });
            }

            // 3) Appel legacy commissions immédiates (système N1 hebdo — coexiste avec le cron MLM mensuel)
            const amountEur = (invoice.amount_paid || 0) / 100;
            const commissionRes = await fetch(
              `http://localhost:${PORT}/api/referral/commission/process`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  driver_id: driver.id,
                  amount_paid: amountEur,
                  invoice_id: invoice.id,
                  subscription_id: invoice.subscription,
                }),
              },
            );
            const commResult = await commissionRes.json();
            console.log(
              `[Stripe] Commissions parrainage legacy : ${commResult.commissions_created || 0} creee(s)`,
            );
          }
        } catch (commErr: any) {
          console.warn('[Stripe] Erreur MLM/commissions:', commErr.message);
        }
      }
    }

    // ── invoice.payment_failed ──
    if (event.type === 'invoice.payment_failed') {
      const invoice = event.data.object as any;
      console.log('⚠️ invoice.payment_failed', invoice.id);
      if (invoice.customer_email) {
        const user = await upsertUserByEmail(invoice.customer_email);
        const attemptCount = invoice.attempt_count || 1;
        const name = invoice.customer_name || 'Chauffeur';
        await logEvent(user.id, 'invoice.payment_failed', { invoiceId: invoice.id, attemptCount });
        if (attemptCount === 1) {
          await setSubscriptionStatus({
            userId: user.id,
            provider: 'stripe',
            status: 'past_due',
            currentPeriodEnd: null,
          });
          await sendPaymentFailed1(invoice.customer_email, name);
        } else if (attemptCount === 2) {
          await sendPaymentFailed2(invoice.customer_email, name);
        } else if (attemptCount >= 3) {
          await setSubscriptionStatus({
            userId: user.id,
            provider: 'stripe',
            status: 'suspended',
            currentPeriodEnd: null,
          });
          await sendPaymentFailedFinal(invoice.customer_email, name);
          await sendSubscriptionSuspended(invoice.customer_email, name);
          // ── MLM : reset payments_counter sur échec final ──
          // Sans ce reset, un chauffeur qui a payé 3 fois puis rate 3 fois
          // pourrait se requalifier en 1 seul paiement à la réinscription.
          try {
            const supaAdmin = await getSupabaseAdmin();
            await supaAdmin
              .from('drivers')
              .update({ subscription_active: false, payments_counter: 0 })
              .eq('email', invoice.customer_email);
            console.log(
              `[MLM] payments_counter reset (final failure) for ${invoice.customer_email}`,
            );
          } catch (resetErr: any) {
            console.warn(
              '[MLM] reset payments_counter on final failure (non-blocking):',
              resetErr?.message,
            );
          }
        }
      }
    }

    // ── customer.subscription.updated ──
    if (event.type === 'customer.subscription.updated') {
      const subscription = event.data.object as any;
      const previousAttributes = (event.data as any).previous_attributes || {};
      const customerEmail = subscription.metadata?.customer_email || subscription.customer_email;
      if (customerEmail) {
        const user = await upsertUserByEmail(customerEmail);
        const name = subscription.metadata?.name || 'Chauffeur';
        const periodEnd = subscription.current_period_end
          ? new Date(subscription.current_period_end * 1000).toISOString()
          : null;
        await setSubscriptionStatus({
          userId: user.id,
          provider: 'stripe',
          status: subscription.status === 'active' ? 'active' : subscription.status,
          currentPeriodEnd: periodEnd,
          productId: subscription.items?.data?.[0]?.price?.id || null,
        });
        await logEvent(user.id, 'customer.subscription.updated', subscription);
        if (
          previousAttributes.status &&
          previousAttributes.status !== 'active' &&
          subscription.status === 'active'
        ) {
          await sendSubscriptionReactivated(
            customerEmail,
            name,
            subscription.items?.data?.[0]?.price?.nickname || 'FOREAS Pro',
          );
        }
        if (previousAttributes.items) {
          const oldPriceId = previousAttributes.items?.data?.[0]?.price?.id;
          const newPriceId = subscription.items?.data?.[0]?.price?.id;
          if (oldPriceId && newPriceId && oldPriceId !== newPriceId) {
            await sendPlanChanged(
              customerEmail,
              name,
              previousAttributes.items?.data?.[0]?.price?.nickname || oldPriceId,
              subscription.items?.data?.[0]?.price?.nickname || newPriceId,
            );
          }
        }
      }
    }

    // ── customer.subscription.deleted ──
    if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object as any;
      const customerEmail = subscription.metadata?.customer_email || subscription.customer_email;
      if (customerEmail) {
        const user = await upsertUserByEmail(customerEmail);
        await setSubscriptionStatus({
          userId: user.id,
          provider: 'stripe',
          status: 'canceled',
          currentPeriodEnd: null,
        });
        await logEvent(user.id, 'customer.subscription.deleted', subscription);
        await sendSubscriptionCanceled(customerEmail, subscription.metadata?.name || 'Chauffeur');

        // ── MLM : marquer filleul inactif + notifier sponsors (fire-and-forget) ──
        try {
          const supaAdmin = await getSupabaseAdmin();
          const { data: driver } = await supaAdmin
            .from('drivers')
            .select('id, referred_by, referred_by_partner')
            .eq('email', customerEmail)
            .single();

          if (driver) {
            // Reset subscription_active et payments_counter
            await supaAdmin
              .from('drivers')
              .update({ subscription_active: false, payments_counter: 0 })
              .eq('id', driver.id);

            // Remonter les 3 niveaux de sponsors affectés
            const sponsorsAffected: Array<{
              id: string;
              type: string;
              level: number;
              lost_monthly_amount: number;
            }> = [];

            if (driver.referred_by) {
              sponsorsAffected.push({
                id: driver.referred_by,
                type: 'driver',
                level: 1,
                lost_monthly_amount: 10,
              });
              // N2
              const { data: n1 } = await supaAdmin
                .from('drivers')
                .select('referred_by')
                .eq('id', driver.referred_by)
                .maybeSingle();
              if (n1?.referred_by) {
                sponsorsAffected.push({
                  id: n1.referred_by,
                  type: 'driver',
                  level: 2,
                  lost_monthly_amount: 4,
                });
                // N3
                const { data: n2 } = await supaAdmin
                  .from('drivers')
                  .select('referred_by')
                  .eq('id', n1.referred_by)
                  .maybeSingle();
                if (n2?.referred_by) {
                  sponsorsAffected.push({
                    id: n2.referred_by,
                    type: 'driver',
                    level: 3,
                    lost_monthly_amount: 2,
                  });
                }
              }
            } else if (driver.referred_by_partner) {
              // Filleul via partner : N1 uniquement (cascade identique mais pivot = partner)
              sponsorsAffected.push({
                id: driver.referred_by_partner,
                type: 'partner',
                level: 1,
                lost_monthly_amount: 10,
              });
            }

            if (sponsorsAffected.length > 0) {
              notifyPieuvreMlmEvent('mlm_filleul_lost', {
                driver_id_filleul: driver.id,
                sponsors_affected: sponsorsAffected,
              });
            }

            console.log(
              `[Stripe] MLM churn: driver=${driver.id}, sponsors_notified=${sponsorsAffected.length}`,
            );
          }
        } catch (mlmChurnErr: any) {
          console.warn('[Stripe] MLM churn notify error (non-blocking):', mlmChurnErr.message);
        }
      }
    }

    await logEvent(null, event.type, event.data.object);
  } catch (dbError: any) {
    console.error('❌ Database/Email error in webhook:', dbError.message);
  }

  return res.json({ received: true });
});

// ============================================
// JSON PARSER - APRÈS webhook Stripe
// ============================================
app.use(express.json({ limit: '10mb' })); // 10MB pour audio base64 (transcription Whisper)

// ============================================
// ÉTAT PREMIUM (démo in-memory)
// ============================================
let lastPremiumTimestamp = 0;

function markPremiumNow(): void {
  lastPremiumTimestamp = Date.now();
}

// ============================================
// OTP ROUTES - LAZY LOADED
// ============================================
let otpRoutesLoaded = false;

async function loadOtpRoutes(): Promise<void> {
  if (otpRoutesLoaded) return;
  try {
    const { otpRouter } = await import('./routes/otp.routes.js');
    app.use('/api/auth', otpRouter);
    otpRoutesLoaded = true;
    console.log('[OTP] Routes mounted at /api/auth');
  } catch (err: any) {
    console.error(`[OTP] Failed to load: ${err.message}`);
  }
}

// ============================================
// AI & ADMIN & ANALYTICS ROUTES - LAZY LOADED
// ============================================
let aiRoutesLoaded = false;
let adminRoutesLoaded = false;
let analyticsRoutesLoaded = false;

async function loadAIRoutes(): Promise<void> {
  if (aiRoutesLoaded) return;
  try {
    const { aiRouter } = await import('./routes/ai.routes.js');
    app.use('/api/ai', aiRouter);
    aiRoutesLoaded = true;
    console.log('[AI] Routes mounted at /api/ai');
  } catch (err: any) {
    console.error(`[AI] Failed to load: ${err.message}`);
  }
}

async function loadAdminRoutes(): Promise<void> {
  if (adminRoutesLoaded) return;
  try {
    const { adminRouter } = await import('./routes/admin.routes.js');
    app.use('/api/admin', adminRouter);
    adminRoutesLoaded = true;
    console.log('[Admin] Routes mounted at /api/admin');
  } catch (err: any) {
    console.error(`[Admin] Failed to load: ${err.message}`);
  }
}

async function loadAnalyticsRoutes(): Promise<void> {
  if (analyticsRoutesLoaded) return;
  try {
    const { analyticsRouter } = await import('./routes/analytics.routes.js');
    app.use('/api/analytics', analyticsRouter);
    // Alias for compatibility
    app.use('/api/events', analyticsRouter);
    analyticsRoutesLoaded = true;
    console.log('[Analytics] Routes mounted at /api/analytics + /api/events');
  } catch (err: any) {
    console.error(`[Analytics] Failed to load: ${err.message}`);
  }
}

let bookingRoutesLoaded = false;
async function loadBookingRoutes(): Promise<void> {
  if (bookingRoutesLoaded) return;
  try {
    const { bookingRouter, geocodeRouter } = await import('./routes/booking.routes.js');
    app.use('/api/bookings', bookingRouter);
    app.use('/api/geocode', geocodeRouter);
    bookingRoutesLoaded = true;
    console.log('[Booking] Routes mounted at /api/bookings + /api/geocode');
  } catch (err: any) {
    console.error(`[Booking] Failed to load: ${err.message}`);
  }
}

let ajnayaRoutesLoaded = false;
async function loadAjnayaRoutes(): Promise<void> {
  if (ajnayaRoutesLoaded) return;
  try {
    const ajnayaRouter = (await import('./routes/ajnaya.js')).default;
    app.use('/api/ajnaya', ajnayaRouter);
    ajnayaRoutesLoaded = true;
    console.log('[Ajnaya] Routes mounted at /api/ajnaya');
  } catch (err: any) {
    console.error(`[Ajnaya] Failed to load: ${err.message}`);
  }
}

// Sprint Activation Conciergerie 30/04 — widget sites perso chauffeurs
let conciergeRoutesLoaded = false;
async function loadConciergeRoutes(): Promise<void> {
  if (conciergeRoutesLoaded) return;
  try {
    const conciergeRouter = (await import('./routes/concierge.routes.js')).default;
    app.use('/api/concierge', conciergeRouter);
    // Sprint 6 — Acquisition active (Apollo + Apify + Stripe payment-link + RAG pricing)
    const conciergeAcquisitionRouter = (await import('./routes/conciergeAcquisition.routes.js'))
      .default;
    app.use('/api/concierge', conciergeAcquisitionRouter);
    conciergeRoutesLoaded = true;
    console.log('[Concierge] Routes mounted at /api/concierge (widget + acquisition + payment)');
  } catch (err: any) {
    console.error(`[Concierge] Failed to load: ${err.message}`);
  }
}

let referralRoutesLoaded = false;
async function loadReferralRoutes(): Promise<void> {
  if (referralRoutesLoaded) return;
  try {
    const referralRouter = (await import('./routes/referral.routes.js')).default;
    app.use('/api/referral', referralRouter);
    referralRoutesLoaded = true;
    console.log('[Referral] Routes mounted at /api/referral');
  } catch (err: any) {
    console.error(`[Referral] Failed to load: ${err.message}`);
  }
}

// ── Wallet Routes ──
let walletRoutesLoaded = false;
async function loadWalletRoutes(): Promise<void> {
  if (walletRoutesLoaded) return;
  try {
    const walletRouter = (await import('./routes/wallet.routes.js')).default;
    app.use('/api', walletRouter);
    walletRoutesLoaded = true;
    console.log(
      '[Wallet] Routes mounted at /api (wallet-summary, payout-request, stripe-onboarding)',
    );
  } catch (err: any) {
    console.error(`[Wallet] Failed to load: ${err.message}`);
  }
}

// ── Bolt Fleet Routes ──
let boltRoutesLoaded = false;
async function loadBoltRoutes(): Promise<void> {
  if (boltRoutesLoaded) return;
  try {
    const boltRouter = (await import('./routes/bolt.routes.js')).default;
    app.use('/api/bolt', boltRouter);
    boltRoutesLoaded = true;

    // Démarrer auto-refresh token Bolt
    const { boltFleet } = await import('./services/boltFleet.js');
    boltFleet.startAutoRefresh();

    console.log('[BoltFleet] Routes mounted at /api/bolt');
  } catch (err: any) {
    console.error(`[BoltFleet] Failed to load: ${err.message}`);
  }
}

// ── Stripe Connect Routes ──
let stripeConnectLoaded = false;
async function loadStripeConnectRoutes(): Promise<void> {
  if (stripeConnectLoaded) return;
  try {
    const stripeConnectRouter = (await import('./routes/stripeConnect.routes.js')).default;
    app.use('/stripe', stripeConnectRouter);
    stripeConnectLoaded = true;
    console.log('[StripeConnect] Routes mounted at /stripe/*');
  } catch (err: any) {
    console.error(`[StripeConnect] Failed to load: ${err.message}`);
  }
}

// ── Pieuvre Routes (Screen Reader + In-App Messages + Concierge Dashboard) ──
let pieuvreRoutesLoaded = false;
async function loadPieuvreRoutes(): Promise<void> {
  if (pieuvreRoutesLoaded) return;
  try {
    const pieuvreRouter = (await import('./routes/pieuvre.routes.js')).default;
    app.use('/api/pieuvre', pieuvreRouter);

    // v104 Clients Directs refonte — Dashboard Concierge aggregate endpoints
    //   GET /api/pieuvre/dashboard/:driverId (hero + pipeline + hot prospects + timeline)
    //   GET /api/pieuvre/prospects/:driverId (liste filtrable)
    //   GET /api/pieuvre/conversations/:driverId (threads actifs WhatsApp/SMS)
    try {
      const pieuvreDashboardRouter = (await import('./routes/pieuvreDashboard.js')).default;
      app.use('/api/pieuvre', pieuvreDashboardRouter);
      console.log('[Pieuvre] Concierge dashboard routes mounted (v104)');
    } catch (dashErr: any) {
      console.error(`[Pieuvre] Concierge dashboard failed to load: ${dashErr.message}`);
    }

    // v104 Sprint 2 — Concierge Commerciale (voice clone + WhatsApp + plaquette)
    //   POST   /api/pieuvre/voice/clone      (ElevenLabs IVC)
    //   GET    /api/pieuvre/voice/status
    //   DELETE /api/pieuvre/voice
    //   POST   /api/pieuvre/whatsapp/send    (Meta Cloud API)
    //   POST   /api/pieuvre/plaquette        (génération PDF queued)
    try {
      const pieuvreConciergeRouter = (await import('./routes/pieuvreConcierge.js')).default;
      app.use('/api/pieuvre', pieuvreConciergeRouter);
      console.log('[Pieuvre] Concierge action routes mounted (Sprint 2)');
    } catch (conciergeErr: any) {
      console.error(`[Pieuvre] Concierge actions failed to load: ${conciergeErr.message}`);
    }

    // v104 Communauté v3 — Feed, modération Opus 4.7, réactions, follows, notifs
    //   POST /api/communaute/posts           (modéré Opus)
    //   GET  /api/communaute/feed            (géo-localisé + filtres)
    //   POST /api/communaute/posts/:id/react (confirme / infirme / merci)
    //   POST /api/communaute/posts/:id/flag  (signaler)
    //   GET  /api/communaute/me/confiance
    //   GET  /api/communaute/autocomplete    (vocab terrain VTC)
    //   GET/PUT /api/communaute/prefs        (notifs)
    //   POST/DELETE /api/communaute/follow/:id
    try {
      const communauteRouter = (await import('./routes/communauteRoutes.js')).default;
      app.use('/api/communaute', communauteRouter);
      console.log('[Communauté] Routes mounted (Communauté v3, modération Opus 4.7)');
    } catch (communauteErr: any) {
      console.error(`[Communauté] Routes failed to load: ${communauteErr.message}`);
    }

    pieuvreRoutesLoaded = true;
    console.log('[Pieuvre] Routes mounted at /api/pieuvre');
  } catch (err: any) {
    console.error(`[Pieuvre] Failed to load: ${err.message}`);
  }
}

let signalsRoutesLoaded = false;
async function loadSignalsRoutes(): Promise<void> {
  if (signalsRoutesLoaded) return;
  try {
    const { signalsRouter } = await import('./routes/signals.routes.js');
    app.use('/api/signals', signalsRouter);
    signalsRoutesLoaded = true;
    console.log('[Signals] Routes mounted at /api/signals');
  } catch (err: any) {
    console.error(`[Signals] Failed to load: ${err.message}`);
  }
}

// ── Zones Live Routes (FusionEngine 10 sources → driver HomeScreen) ──
// B09.3: mount INLINE pour éviter tout problème de dynamic import sur Railway.
// Le lazy loader précédent échouait silencieusement (404 sur /api/zones/live
// malgré commit déployé). Inline = maximum visibilité d'erreur au startup.
async function loadZonesRoutes(): Promise<void> {
  try {
    console.log('[Zones] 🚀 Loading zones router (inline, top-level express)...');
    // Utilise express déjà importé au top du module (évite problème esModuleInterop)
    const fusionMod = await import('./services/AjnayaFusionEngine.js');
    const { fuse } = fusionMod;

    if (typeof fuse !== 'function') {
      console.error('[Zones] ❌ fuse is not a function:', typeof fuse);
      return;
    }

    const zonesRouter = express.Router();

    // Cache 30s in-memory
    let zoneCache: any = null;
    const CACHE_TTL_MS = 30_000;

    const scoreToLevel = (s: number) =>
      s >= 80 ? 'SURGE' : s >= 60 ? 'HIGH' : s >= 35 ? 'MEDIUM' : 'LOW';
    const scoreToMult = (s: number) =>
      s >= 85 ? 2.0 : s >= 70 ? 1.5 : s >= 55 ? 1.25 : s >= 40 ? 1.1 : 1.0;
    const scoreToEarn = (s: number) =>
      s >= 85
        ? '€45-60/h'
        : s >= 70
          ? '€35-50/h'
          : s >= 55
            ? '€28-40/h'
            : s >= 40
              ? '€22-32/h'
              : '€18-25/h';

    zonesRouter.get('/health', (_req: any, res: any) => {
      const now = Date.now();
      res.json({
        ok: true,
        cacheAgeMs: zoneCache ? now - zoneCache.refreshedAt : null,
        lastSourcesUsed: zoneCache?.sources || [],
        lastDataQuality: zoneCache?.dataQuality || 'unknown',
      });
    });

    zonesRouter.get('/live', async (req: any, res: any) => {
      const now = Date.now();
      const bypassCache = req.query.nocache === '1';
      if (!bypassCache && zoneCache && now - zoneCache.refreshedAt < CACHE_TTL_MS) {
        return res.json({
          zones: zoneCache.zones,
          sourcesUsed: zoneCache.sources,
          dataQuality: zoneCache.dataQuality === 'live' ? 'cached' : zoneCache.dataQuality,
          refreshedAt: new Date(zoneCache.refreshedAt).toISOString(),
          cacheAgeMs: now - zoneCache.refreshedAt,
          alerts: zoneCache.alerts || [],
          opportunities: zoneCache.opportunities || [],
        });
      }
      try {
        const ctx = await fuse('', (req.query.driverId as string) || undefined);
        const zones = ctx.demandZones.map((z: any) => ({
          name: z.zone,
          score: z.score,
          level: scoreToLevel(z.score),
          surgeMultiplier: scoreToMult(z.score),
          estimatedEarnings: scoreToEarn(z.score),
          reasons: z.reasons.slice(0, 3),
          sources: z.sources,
        }));
        const dataQuality = ctx.sourcesUsed.some((s: string) =>
          ['openweather', 'predicthq', 'sncf', 'tomtom', 'idfm', 'bolt'].includes(s),
        )
          ? 'live'
          : 'simulated';
        zoneCache = {
          zones,
          sources: ctx.sourcesUsed,
          dataQuality,
          refreshedAt: now,
          alerts: ctx.alerts,
          opportunities: ctx.opportunities,
        };
        res.json({
          zones,
          sourcesUsed: ctx.sourcesUsed,
          dataQuality,
          refreshedAt: new Date(now).toISOString(),
          cacheAgeMs: 0,
          latencyMs: ctx.totalLatency,
          alerts: ctx.alerts,
          opportunities: ctx.opportunities,
        });
      } catch (err: any) {
        console.error('[zones.live] fuse failed:', err?.message || err);
        if (zoneCache) {
          return res.json({
            zones: zoneCache.zones,
            sourcesUsed: zoneCache.sources,
            dataQuality: 'cached',
            refreshedAt: new Date(zoneCache.refreshedAt).toISOString(),
            cacheAgeMs: now - zoneCache.refreshedAt,
            warning: 'stale cache — fusion engine failed',
          });
        }
        res.status(503).json({
          error: 'Fusion engine unavailable',
          zones: [],
          sourcesUsed: [],
          dataQuality: 'simulated',
          refreshedAt: new Date(now).toISOString(),
        });
      }
    });

    app.use('/api/zones', zonesRouter);
    console.log('[Zones] ✅ Routes mounted at /api/zones (INLINE, FusionEngine → driver)');
  } catch (err: any) {
    console.error('[Zones] ❌ Failed to setup inline:', err?.message || err);
    if (err?.stack) console.error('[Zones] Stack:', err.stack);
  }
}

// ── Coach Réflexe Routes ──
let coachRoutesLoaded = false;
async function loadCoachRoutes(): Promise<void> {
  if (coachRoutesLoaded) return;
  try {
    const coachRouter = (await import('./routes/coachInstant.js')).default;
    app.use('/api/coach', coachRouter);
    coachRoutesLoaded = true;
    console.log('[Coach] Routes mounted at /api/coach');
  } catch (err: any) {
    console.error(`[Coach] Failed to load: ${err.message}`);
  }
}

// ── Clients Directs Routes ──
let clientsDirectsLoaded = false;
async function loadClientsDirectsRoutes(): Promise<void> {
  if (clientsDirectsLoaded) return;
  try {
    const cdRouter = (await import('./routes/clientsDirects.js')).default;
    app.use('/api/clients-directs', cdRouter);
    clientsDirectsLoaded = true;
    console.log('[ClientsDirects] Routes mounted at /api/clients-directs');
  } catch (err: any) {
    console.error(`[ClientsDirects] Failed to load: ${err.message}`);
  }
}

// ── Analytics Events Routes ──
let analyticsEventsLoaded = false;
async function loadAnalyticsEventsRoutes(): Promise<void> {
  if (analyticsEventsLoaded) return;
  try {
    const aeRouter = (await import('./routes/analyticsEvents.js')).default;
    app.use('/api/analytics-events', aeRouter);
    analyticsEventsLoaded = true;
    console.log('[AnalyticsEvents] Routes mounted at /api/analytics-events');
  } catch (err: any) {
    console.error(`[AnalyticsEvents] Failed to load: ${err.message}`);
  }
}

// ── Client Finder Routes ──
let clientFinderLoaded = false;
async function loadClientFinderRoutes(): Promise<void> {
  if (clientFinderLoaded) return;
  try {
    const cfRouter = (await import('./routes/clientFinder.js')).default;
    app.use('/api/client-finder', cfRouter);
    clientFinderLoaded = true;
    console.log('[ClientFinder] Routes mounted at /api/client-finder');
  } catch (err: any) {
    console.error(`[ClientFinder] Failed to load: ${err.message}`);
  }
}

// ── Vehicle Routes ── v1.10.47 (Claude Vision verify-photo)
let vehicleRoutesLoaded = false;
async function loadVehicleRoutes(): Promise<void> {
  if (vehicleRoutesLoaded) return;
  try {
    const vRouter = (await import('./routes/vehicle.routes.js')).default;
    app.use('/api/vehicle', vRouter);
    vehicleRoutesLoaded = true;
    console.log('[Vehicle] Routes mounted at /api/vehicle');
  } catch (err: any) {
    console.error(`[Vehicle] Failed to load: ${err.message}`);
  }
}

// ── Voice Routes ── v88
let voiceRoutesLoaded = false;
async function loadVoiceRoutes() {
  if (voiceRoutesLoaded) return;
  voiceRoutesLoaded = true;
  try {
    const { default: voiceRoutes } = await import('./routes/voiceRoutes.js');
    app.use('/api/voice', voiceRoutes);
    console.log('✅ Voice routes loaded');
  } catch (e) {
    console.error('❌ Voice routes failed:', e);
  }
}

// ── Resend Webhooks ──
let resendWebhooksLoaded = false;
async function loadResendWebhooks(): Promise<void> {
  if (resendWebhooksLoaded) return;
  try {
    const rwRouter = (await import('./routes/resendWebhooks.js')).default;
    // Raw body middleware pour HMAC verification
    app.use('/api/webhooks/resend', express.raw({ type: 'application/json' }), rwRouter);
    resendWebhooksLoaded = true;
    console.log('[ResendWebhooks] Mounted at /api/webhooks/resend');
  } catch (err: any) {
    console.error(`[ResendWebhooks] Failed to load: ${err.message}`);
  }
}

// ── Internal Cron Routes ── Ajnaya2026v87.2
let internalCronLoaded = false;
async function loadInternalCronRoutes(): Promise<void> {
  if (internalCronLoaded) return;
  try {
    const icRouter = (await import('./routes/internalCron.js')).default;
    app.use('/api/internal', icRouter);
    internalCronLoaded = true;
    console.log('[InternalCron] Routes mounted at /api/internal');
  } catch (err: any) {
    console.error(`[InternalCron] Failed to load: ${err.message}`);
  }
}

// ── MLM Routes (admin partners + public CAP) ── v1.10.55
let mlmRoutesLoaded = false;
async function loadMlmRoutes(): Promise<void> {
  if (mlmRoutesLoaded) return;
  try {
    const mlmRouter = (await import('./routes/mlm.routes.js')).default;
    // Monté à racine /api : routes commencent par /admin/* ou /public/*
    app.use('/api', mlmRouter);
    mlmRoutesLoaded = true;
    console.log('[MLM] Routes mounted at /api/admin/partners + /api/public/partners');
  } catch (err: any) {
    console.error(`[MLM] Failed to load: ${err.message}`);
  }
}

// ── Opt-out Routes (RGPD) ── Ajnaya2026v87.1
let optoutRoutesLoaded = false;
async function loadOptoutRoutes(): Promise<void> {
  if (optoutRoutesLoaded) return;
  try {
    const optRouter = (await import('./routes/optoutRoutes.js')).default;
    // Monté à la racine : GET /optout/:token
    app.use('/', optRouter);
    optoutRoutesLoaded = true;
    console.log('[Optout] Mounted at /optout/:token');
  } catch (err: any) {
    console.error(`[Optout] Failed to load: ${err.message}`);
  }
}

// ── Finder Inbound Webhook (Resend Inbound) ── Ajnaya2026v87
let finderInboundLoaded = false;
async function loadFinderInboundRoutes(): Promise<void> {
  if (finderInboundLoaded) return;
  try {
    const fiRouter = (await import('./routes/resendInbound.js')).default;
    // JSON parser avec verify callback pour exposer rawBody (Svix HMAC)
    const jsonWithRaw = express.json({
      limit: '2mb',
      verify: (req, _res, buf) => {
        (req as any).rawBody = buf.toString('utf8');
      },
    });
    app.use('/api/webhooks', jsonWithRaw, fiRouter);
    finderInboundLoaded = true;
    console.log('[FinderInbound] Mounted at /api/webhooks/resend-inbound');
  } catch (err: any) {
    console.error(`[FinderInbound] Failed to load: ${err.message}`);
  }
}

// Charger toutes les routes après le serveur prêt
setTimeout(() => {
  loadOtpRoutes();
  loadAIRoutes();
  loadAdminRoutes();
  loadAnalyticsRoutes();
  loadBookingRoutes();
  loadAjnayaRoutes();
  loadConciergeRoutes();
  loadReferralRoutes();
  loadWalletRoutes();
  loadBoltRoutes();
  loadStripeConnectRoutes();
  loadPieuvreRoutes();
  loadSignalsRoutes();
  loadZonesRoutes();
  loadCoachRoutes();
  loadClientsDirectsRoutes();
  loadAnalyticsEventsRoutes();
  loadClientFinderRoutes();
  loadVehicleRoutes();
  loadVoiceRoutes();
  loadResendWebhooks();
  loadOptoutRoutes();
  loadInternalCronRoutes();
  loadMlmRoutes();
  loadFinderInboundRoutes();
}, 0);

// ============================================
// STRIPE CHECKOUT — Anti-duplication chauffeur
// ============================================
app.use('/create-checkout-session', express.json());
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { email, phone, driverId, plan } = req.body as {
      email?: string;
      phone?: string;
      driverId?: string;
      plan?: 'weekly' | 'annual';
    };

    const priceId =
      plan === 'annual' ? process.env.STRIPE_PRICE_ID_ANNUAL : process.env.STRIPE_PRICE_ID;

    if (!priceId) {
      return res.status(400).json({ error: `Missing price for plan: ${plan || 'weekly'}` });
    }

    if (!email) {
      return res.status(400).json({ error: 'email requis pour créer un abonnement' });
    }

    const stripe = await getStripe();

    // ── 1. Chercher client existant par email ──────────────────────────
    const existingCustomers = await stripe.customers.list({ email, limit: 5 });

    let customerId: string | undefined;
    let alreadySubscribed = false;

    if (existingCustomers.data.length > 0) {
      // Prendre le plus récent avec metadata.driver_id si dispo
      const matched = driverId
        ? existingCustomers.data.find((c) => c.metadata?.driver_id === driverId)
        : existingCustomers.data[0];

      customerId = (matched ?? existingCustomers.data[0]).id;

      // ── 2. Vérifier abonnement actif ──────────────────────────────
      const subs = await stripe.subscriptions.list({
        customer: customerId,
        status: 'active',
        limit: 1,
      });

      if (subs.data.length > 0) {
        // Chauffeur déjà abonné — retourner portal au lieu d'un nouveau checkout
        alreadySubscribed = true;
        console.log(`[Checkout] Doublon bloqué — déjà abonné: ${email} (${customerId})`);

        const portalSession = await stripe.billingPortal.sessions.create({
          customer: customerId,
          return_url: 'https://foreas.app/dashboard',
        });

        return res.json({
          already_subscribed: true,
          portal_url: portalSession.url,
          message: 'Vous avez déjà un abonnement actif.',
        });
      }
    }

    // ── 3. Créer ou récupérer le customer Stripe ───────────────────
    if (!customerId) {
      const newCustomer = await stripe.customers.create({
        email,
        phone: phone ?? undefined,
        metadata: {
          driver_id: driverId ?? '',
          source: 'foreas_app',
          created_at: new Date().toISOString(),
        },
      });
      customerId = newCustomer.id;
      console.log(`[Checkout] Nouveau customer créé: ${customerId} (${email})`);
    }

    // ── 4. Créer la session checkout liée au customer ─────────────
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      customer_update: { address: 'auto' },
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: {
        metadata: {
          driver_id: driverId ?? '',
          source: 'foreas_app',
        },
      },
      // Empêche de changer d'email pendant le checkout
      customer_email: !customerId ? email : undefined,
      allow_promotion_codes: true,
      success_url: 'https://foreas.app/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://foreas.app/cancel',
    });

    console.log(`[Checkout] Session créée: ${session.id} pour ${email}`);
    res.json({ url: session.url, session_id: session.id });
  } catch (e: any) {
    console.error(`[Checkout] Error: ${e.message}`);
    res.status(400).json({ error: e.message });
  }
});

// ── Vérifier le statut d'abonnement par email ─────────────────────────────
app.post('/subscription/check', express.json(), async (req, res) => {
  try {
    const { email, driverId } = req.body as { email?: string; driverId?: string };
    if (!email) return res.status(400).json({ error: 'email requis' });

    const stripe = await getStripe();
    const customers = await stripe.customers.list({ email, limit: 5 });

    if (customers.data.length === 0) {
      return res.json({ subscribed: false, customer_exists: false });
    }

    const customerId = driverId
      ? (customers.data.find((c) => c.metadata?.driver_id === driverId) ?? customers.data[0]).id
      : customers.data[0].id;

    const subs = await stripe.subscriptions.list({
      customer: customerId,
      status: 'active',
      limit: 1,
    });

    const sub = subs.data[0] ?? null;
    return res.json({
      subscribed: !!sub,
      customer_exists: true,
      customer_id: customerId,
      subscription_id: sub?.id ?? null,
      current_period_end: sub ? new Date(sub.current_period_end * 1000).toISOString() : null,
    });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// ============================================
// SUBSCRIPTION STATUS
// ============================================
app.get('/subscription/status', (_req, res) => {
  const PREMIUM_DURATION_MS = 30 * 60 * 1000; // 30 min
  const active = Date.now() - lastPremiumTimestamp < PREMIUM_DURATION_MS;
  res.json({ active });
});

// ============================================
// TTS — AJNAYA VOICE (ElevenLabs proxy)
// ============================================
app.post('/api/tts', express.json(), async (req: any, res: any) => {
  const { text, voice_id } = req.body || {};
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return res.status(400).json({ error: 'Missing text' });
  }
  if (text.length > 500) {
    return res.status(400).json({ error: 'Text too long (max 500 chars)' });
  }

  const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY;
  const VOICE_ID = voice_id || process.env.ELEVENLABS_VOICE_ID || 'MNKK2Wl2wbbsEPQTHZGt'; // Koraly - French conversational

  if (!ELEVEN_KEY) {
    return res.status(503).json({ error: 'TTS not configured' });
  }

  try {
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`, {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVEN_KEY,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text: text.trim(),
        // 🎙️ ElevenLabs v3 — supporte audio tags non-verbaux ([laughs softly],
        // [sighs], [hmm], [confident], [matter of fact], [firmly]) injectés dans le
        // prompt système pour humaniser Koraly. NE PAS revenir sur multilingual_v2.
        // ⚠️ Vérifié via /v1/models : can_use_style=false, can_use_speaker_boost=false
        //    → on les omet (silencieusement ignorés par l'API v3).
        model_id: 'eleven_v3',
        voice_settings: {
          stability: 0.4,
          similarity_boost: 0.75,
          speed: 1.22,
        },
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('[TTS] ElevenLabs error:', response.status, err);
      return res.status(502).json({ error: 'ElevenLabs error', detail: response.status });
    }

    const audioBuffer = Buffer.from(await response.arrayBuffer());
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', audioBuffer.length);
    res.setHeader('Cache-Control', 'no-store');
    return res.send(audioBuffer);
  } catch (err: any) {
    console.error('[TTS] Fetch error:', err.message);
    return res.status(500).json({ error: 'TTS failed', message: err.message });
  }
});

// ============================================
// CONTEXT API — Ajnaya (OpenWeather + PredictHQ proxy sécurisé)
// Les clés API ne quittent jamais le backend
// ============================================
app.get('/api/context/weather', async (req: any, res: any) => {
  const { lat, lng } = req.query as { lat?: string; lng?: string };
  if (!lat || !lng) return res.status(400).json({ error: 'lat, lng required' });

  const key = process.env.OPENWEATHER_API_KEY;
  if (!key) {
    console.warn('[Context] OPENWEATHER_API_KEY not set — returning neutral');
    return res.json({
      weather: [{ main: 'Clear', description: 'clear sky' }],
      main: { temp: 15 },
    });
  }

  try {
    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&appid=${key}&units=metric&lang=fr`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) throw new Error(`OpenWeather ${resp.status}`);
    const data = await resp.json();
    res.json(data);
  } catch (err: any) {
    console.error('[Context] Weather fetch error:', err.message);
    // Mode dégradé — contexte neutre plutôt qu'erreur 502
    res.json({
      weather: [{ main: 'Clear', description: 'unknown' }],
      main: { temp: 15 },
    });
  }
});

app.get('/api/context/events', async (req: any, res: any) => {
  const { lat, lng } = req.query as { lat?: string; lng?: string };
  if (!lat || !lng) return res.status(400).json({ error: 'lat, lng required' });

  const key = process.env.PREDICTHQ_API_KEY;
  if (!key) {
    console.warn('[Context] PREDICTHQ_API_KEY not set — returning empty events');
    return res.json({ results: [], count: 0 });
  }

  try {
    const url = `https://api.predicthq.com/v1/events/?within=10km@${encodeURIComponent(lat)},${encodeURIComponent(lng)}&active.gte=now&limit=20&sort=predicted_event_spend`;
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(6000),
    });
    if (!resp.ok) throw new Error(`PredictHQ ${resp.status}`);
    const data = await resp.json();
    res.json(data);
  } catch (err: any) {
    console.error('[Context] Events fetch error:', err.message);
    res.json({ results: [], count: 0 });
  }
});

// ============================================================
// v1.10.46 — Cerveau Collectif Ajnaya
// Endpoints consommés par SmartZoneIntelligenceService + ThompsonBanditService
// ============================================================

/**
 * GET /api/context/transport-disruptions?lat=&lng=&radius=
 * Perturbations SNCF/RATP/aéroports = pic VTC immédiat dans la zone.
 * Pour l'instant : reuse AjnayaFusionEngine si présent (SNCF, IDFM déjà câblés)
 * sinon retourne tableau vide. Toujours JSON valide.
 */
app.get('/api/context/transport-disruptions', async (req: any, res: any) => {
  const { lat, lng, radius } = req.query as { lat?: string; lng?: string; radius?: string };
  if (!lat || !lng) return res.status(400).json({ error: 'lat, lng required' });

  try {
    // Tentative : passer par AjnayaFusionEngine si disponible (a déjà SNCF/IDFM)
    const fusionMod = await import('./services/AjnayaFusionEngine.js').catch(() => null as any);
    if (fusionMod?.fuse) {
      const result = await fusionMod
        .fuse({
          userLat: parseFloat(lat),
          userLng: parseFloat(lng),
          radiusKm: radius ? parseFloat(radius) : 10,
        })
        .catch(() => null);
      const disruptions = result?.disruptions ?? result?.transportDisruptions ?? [];
      return res.json({ disruptions });
    }
    return res.json({ disruptions: [] });
  } catch (err: any) {
    console.warn('[Context] transport-disruptions error:', err?.message);
    res.json({ disruptions: [] });
  }
});

/**
 * GET /api/context/traffic-incidents?lat=&lng=&radius=
 * Bouchons / accidents / fermetures voie. Source : TomTom/Waze déjà câblés.
 */
app.get('/api/context/traffic-incidents', async (req: any, res: any) => {
  const { lat, lng, radius } = req.query as { lat?: string; lng?: string; radius?: string };
  if (!lat || !lng) return res.status(400).json({ error: 'lat, lng required' });

  try {
    const fusionMod = await import('./services/AjnayaFusionEngine.js').catch(() => null as any);
    if (fusionMod?.fuse) {
      const result = await fusionMod
        .fuse({
          userLat: parseFloat(lat),
          userLng: parseFloat(lng),
          radiusKm: radius ? parseFloat(radius) : 10,
        })
        .catch(() => null);
      const incidents = result?.trafficIncidents ?? result?.incidents ?? [];
      return res.json({ incidents });
    }
    return res.json({ incidents: [] });
  } catch (err: any) {
    console.warn('[Context] traffic-incidents error:', err?.message);
    res.json({ incidents: [] });
  }
});

/**
 * GET /api/bandit/aggregated-arms
 * Bootstrap des bandit arms agrégés depuis bandit_arms_aggregated.
 * Lecture publique (pas de PII, juste zone × heure × jour × alpha/beta).
 * Consommé par ThompsonBanditService.bootstrapFromCollective() au login.
 */
app.get('/api/bandit/aggregated-arms', async (_req: any, res: any) => {
  try {
    const supa = await getSupabaseAdmin();
    const { data, error } = await supa
      .from('bandit_arms_aggregated')
      .select(
        'zone_name, hour, day, alpha, beta, total_reward, total_pulls, contributing_drivers, last_aggregated_at',
      )
      .gte('total_pulls', 5) // n'exposer que les arms avec au moins 5 pulls (stat fiable)
      .limit(2000);
    if (error) throw error;
    const arms = (data ?? []).map((r: any) => ({
      zoneName: r.zone_name,
      hour: r.hour,
      day: r.day,
      alpha: Number(r.alpha),
      beta: Number(r.beta),
      totalReward: Number(r.total_reward ?? 0),
      totalPulls: Number(r.total_pulls ?? 0),
      lastUpdatedMs: new Date(r.last_aggregated_at).getTime(),
    }));
    res.json({ arms, aggregatedFrom: arms.length });
  } catch (err: any) {
    console.warn('[Bandit] aggregated-arms error:', err?.message);
    res.json({ arms: [], aggregatedFrom: 0 });
  }
});

/**
 * POST /api/bandit/sync-personal-arms
 * Body: { driverId: uuid, arms: [{zoneName, hour, day, alpha, beta, totalReward, totalPulls}] }
 *
 * Le chauffeur opt-in (share_learning_data = TRUE) push ses arms perso pour
 * qu'un job CRON pieuvre les agrège (somme alpha/beta) dans bandit_arms_aggregated.
 *
 * Stockage temporaire : table `bandit_personal_pushes` (créée à la demande)
 * pour permettre l'agrégation périodique sans contention.
 */
app.post('/api/bandit/sync-personal-arms', async (req: any, res: any) => {
  const { driverId, arms } = req.body ?? {};
  if (!driverId || !Array.isArray(arms)) {
    return res.status(400).json({ error: 'driverId + arms[] required' });
  }
  try {
    const supa = await getSupabaseAdmin();
    // Vérifier opt-in du chauffeur
    const { data: prefs } = await supa
      .from('user_preferences')
      .select('share_learning_data')
      .eq('user_id', driverId)
      .maybeSingle();
    if (!prefs?.share_learning_data) {
      return res.json({ accepted: 0, reason: 'opt_out_or_unknown' });
    }
    // UPSERT direct sur bandit_arms_aggregated (somme cumulative simple V1)
    // V2 : utiliser une staging table + job d'agrégation côté pieuvre
    let accepted = 0;
    for (const arm of arms.slice(0, 500)) {
      if (!arm?.zoneName || typeof arm?.hour !== 'number' || typeof arm?.day !== 'number') continue;
      try {
        await supa
          .rpc('bandit_arm_increment', {
            p_zone: String(arm.zoneName).toLowerCase().trim(),
            p_hour: arm.hour,
            p_day: arm.day,
            p_alpha_delta: Number(arm.alpha ?? 1) - 1,
            p_beta_delta: Number(arm.beta ?? 1) - 1,
            p_reward_delta: Number(arm.totalReward ?? 0),
            p_pulls_delta: Number(arm.totalPulls ?? 0),
          })
          .catch(async () => {
            // Fallback si RPC pas créé : upsert direct (race possible mais OK V1)
            await supa.from('bandit_arms_aggregated').upsert(
              {
                zone_name: String(arm.zoneName).toLowerCase().trim(),
                hour: arm.hour,
                day: arm.day,
                alpha: Number(arm.alpha ?? 1),
                beta: Number(arm.beta ?? 1),
                total_reward: Number(arm.totalReward ?? 0),
                total_pulls: Number(arm.totalPulls ?? 0),
                contributing_drivers: 1,
                last_aggregated_at: new Date().toISOString(),
              },
              { onConflict: 'zone_name,hour,day' },
            );
          });
        accepted++;
      } catch {}
    }
    res.json({ accepted, total: arms.length });
  } catch (err: any) {
    console.warn('[Bandit] sync-personal-arms error:', err?.message);
    res.status(500).json({ error: err?.message ?? 'sync failed' });
  }
});

// ============================================================
// DRIVER SITE — Site personnel chauffeur haute conversion
// FOREAS prend 15% platform fee sur chaque pourboire
// ============================================================

// Lazy Supabase client (service role — bypass RLS pour pages publiques)
let supabaseAdmin: any = null;
async function getSupabaseAdmin() {
  if (!supabaseAdmin) {
    const { createClient } = await import('@supabase/supabase-js');
    supabaseAdmin = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
  }
  return supabaseAdmin;
}

// ── Helper : générer un slug unique à partir du nom ──────────
// v104 Sprint 3A — Format mémorable : `prenom-XX` (ex: karim-47, yasmine-02)
// Principe Krug "Don't Make Me Think" : le slug doit se lire, pas se déchiffrer.
// Principe Cialdini (liking) : entendre son prénom crée affinité instantanée.
//
// Collision : les 2 chiffres offrent 100 combinaisons par prénom.
// Le caller doit vérifier l'unicité dans driver_sites et re-générer si besoin.
function generateSlug(name: string): string {
  const firstName =
    (name.trim().split(/[\s-]+/)[0] || 'chauffeur')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // retire accents
      .replace(/[^a-zA-Z]/g, '') // retire tout sauf lettres
      .toLowerCase()
      .substring(0, 20) || // limite pour URL propre
    'chauffeur';
  const digits = Math.floor(Math.random() * 90 + 10); // 10-99
  return `${firstName}-${digits}`;
}

// Vérifie qu'un slug est dispo — sinon re-génère jusqu'à 8 tentatives
async function generateUniqueSlug(name: string): Promise<string> {
  const supa = await getSupabaseAdmin();
  for (let i = 0; i < 8; i++) {
    const candidate = generateSlug(name);
    const { data } = await supa
      .from('driver_sites')
      .select('id')
      .eq('slug', candidate)
      .maybeSingle();
    if (!data) return candidate;
  }
  // Fallback : ajout timestamp pour garantir unicité
  return `${generateSlug(name)}-${Date.now().toString(36).slice(-4)}`;
}

// Liste des segments URL qui NE sont PAS des slugs chauffeur (réservés)
// Utilisée par la route catch-all `app.get('/:slug')` pour ignorer
// les routes API, pages légales, webhooks, assets, etc.
const RESERVED_URL_SEGMENTS = new Set([
  'api',
  'webhooks',
  'c',
  'v1',
  'v2',
  'health',
  'healthz',
  'cgu',
  'confidentialite',
  'mentions-legales',
  'suppression-compte',
  'robots.txt',
  'favicon.ico',
  'sitemap.xml',
  'apple-touch-icon.png',
  'admin',
  'auth',
  'login',
  'logout',
  'signup',
  'public',
  'static',
  'assets',
  '_next',
]);

// ── Helper : générer un code promo unique (voucher-code-generator) ──
function generatePromoCode(name: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const voucher_codes = require('voucher-code-generator');

  // Prefix from driver name (3 first letters, uppercase, accents stripped)
  const prefix =
    name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z]/g, '')
      .substring(0, 3)
      .toUpperCase() || 'VTC';

  // Generate 1 code with pattern: PREFIX-XXXXX (no ambiguous chars I/O/0/1/L)
  const codes = voucher_codes.generate({
    length: 6,
    count: 1,
    charset: 'ABCDEFGHJKMNPQRSTUVWXYZ23456789', // no I/O/0/1/L for readability
    prefix: `${prefix}-`,
  });
  return codes[0]; // e.g. "CHA-7K9M4P"
}

// ── Helper : envoyer le code promo par email au chauffeur ──────
async function sendPromoCodeEmail(
  driverEmail: string,
  driverName: string,
  promoCode: string,
  promoPercent: number,
  siteUrl: string,
): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || !driverEmail) {
    console.warn('[PromoEmail] Skipping — no API key or no email');
    return false;
  }
  try {
    const { Resend } = await import('resend');
    const resend = new Resend(apiKey);
    const fromEmail = process.env.RESEND_FROM_EMAIL || 'noreply@foreas.xyz';
    await resend.emails.send({
      from: `FOREAS <${fromEmail}>`,
      to: driverEmail,
      subject: `🎁 Votre code promo FOREAS : ${promoCode}`,
      html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#0D0D0D;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<div style="max-width:520px;margin:0 auto;padding:32px 24px">
  <div style="text-align:center;margin-bottom:24px">
    <div style="font-size:28px;font-weight:800;color:#fff">FOREAS</div>
    <div style="font-size:13px;color:#888;margin-top:4px">Votre site chauffeur</div>
  </div>
  <div style="background:#1A1A2E;border-radius:16px;padding:32px 24px;text-align:center;border:1px solid #2A2A4A">
    <div style="font-size:16px;color:#ccc;margin-bottom:8px">Bonjour ${driverName.split(' ')[0]},</div>
    <div style="font-size:14px;color:#aaa;margin-bottom:24px;line-height:1.6">
      Votre code promo est prêt ! Partagez-le avec vos clients pour leur offrir
      <strong style="color:#F59E0B">-${promoPercent}%</strong> sur leur première course.
    </div>
    <div style="background:#111;border-radius:12px;padding:20px;margin-bottom:24px;border:2px dashed #F59E0B">
      <div style="font-size:36px;font-weight:900;color:#F59E0B;letter-spacing:6px;font-family:monospace">${promoCode}</div>
    </div>
    <div style="font-size:13px;color:#888;margin-bottom:20px">
      Ce code est unique et lié à votre profil. Il apparaît sur votre page publique.
    </div>
    <a href="${siteUrl}" style="display:inline-block;background:#8C52FF;color:#fff;padding:12px 32px;border-radius:8px;font-weight:700;text-decoration:none;font-size:14px">
      Voir ma page →
    </a>
  </div>
  <div style="text-align:center;margin-top:20px;font-size:11px;color:#555">
    © ${new Date().getFullYear()} FOREAS Labs — Ne pas répondre à cet email.
  </div>
</div>
</body></html>`,
    });
    console.log(`[PromoEmail] ✅ Sent to ${driverEmail} — code: ${promoCode}`);
    return true;
  } catch (err: any) {
    console.error(`[PromoEmail] ❌ Failed:`, err.message);
    return false;
  }
}

// ── Helper : générer la bio Ajnaya (PAS Framework — niche-aware) ───────────
function generateBio(
  name: string,
  city: string,
  rating: number,
  trips: number,
  languages: string[],
  niche?: string | null,
): string {
  const firstName = name.split(' ')[0];
  const langStr = languages.length > 1 ? languages.join(', ') : '';
  const tripsText =
    trips > 50
      ? `${trips}+ courses réalisées`
      : trips > 0
        ? `${trips} courses`
        : 'nouveau sur FOREAS';
  const ratingText =
    rating >= 4.5 ? `noté ${rating.toFixed(1)}/5 par ses passagers` : `note ${rating.toFixed(1)}/5`;

  // Niche-specific PAS bios — tailored to each specialization
  const nicheBios: Record<string, string> = {
    corporate: `Besoin d'un chauffeur pour vos déplacements professionnels à ${city} ? ${firstName} est spécialisé corporate : ponctualité absolue, discrétion et confort premium. ${ratingText}, ${tripsText}.${langStr ? ` Parle ${langStr}.` : ''} Réservez en 30 secondes.`,
    evenementiel: `Un événement à ${city} ? ${firstName} assure vos mariages, galas et soirées avec élégance et fiabilité. ${ratingText}, ${tripsText}.${langStr ? ` ${langStr}.` : ''} Réservez votre chauffeur dédié en quelques clics.`,
    medical: `Rendez-vous médical à ${city} ? ${firstName} est chauffeur spécialisé santé : accompagnement patient, aide à la montée et trajets adaptés. ${ratingText}, ${tripsText}.${langStr ? ` ${langStr}.` : ''} Réservez simplement.`,
    transfert: `Transfert aéroport ou gare à ${city} ? ${firstName} assure vos trajets longue distance avec suivi des vols et aide bagages. ${ratingText}, ${tripsText}.${langStr ? ` Parle ${langStr}.` : ''} Réservation rapide et gratuite.`,
    nuit: `Sortie nocturne à ${city} ? ${firstName} vous ramène en toute sécurité. Clubs, restaurants, after-work : disponible en soirée et la nuit. ${ratingText}, ${tripsText}.${langStr ? ` ${langStr}.` : ''} Réservez en 30 secondes.`,
    famille: `Trajet en famille à ${city} ? ${firstName} est équipé sièges enfants, patient et bienveillant. Trajets scolaires, sorties famille, courses. ${ratingText}, ${tripsText}.${langStr ? ` ${langStr}.` : ''} Réservez facilement.`,
    premium: `Service VTC haut de gamme à ${city}. ${firstName} offre véhicule premium, présentation impeccable et service sur-mesure. ${ratingText}, ${tripsText}.${langStr ? ` Parle ${langStr}.` : ''} Réservez votre chauffeur d'exception.`,
  };

  // If niche-specific bio exists, use it
  if (niche && nicheBios[niche]) return nicheBios[niche];

  // Generic PAS fallback — 3 templates with deterministic variation
  const variant = name.length % 3;

  if (variant === 0) {
    return `Besoin d'un trajet fiable à ${city} ? ${firstName} est chauffeur VTC professionnel, ${ratingText} avec ${tripsText}. Ponctualité, confort et discrétion garantis.${langStr ? ` Parle ${langStr}.` : ''} Réservez en 30 secondes, sans application à télécharger.`;
  } else if (variant === 1) {
    return `Vous cherchez un chauffeur de confiance à ${city} ? ${firstName}, ${ratingText}, assure vos trajets avec professionnalisme et ponctualité. ${tripsText} et des passagers satisfaits.${langStr ? ` Langues : ${langStr}.` : ''} Réservez directement — réponse rapide garantie.`;
  } else {
    return `${firstName}, chauffeur VTC à ${city}. ${tripsText}, ${ratingText}. Véhicule propre, trajet sans stress, arrivée à l'heure.${langStr ? ` ${langStr}.` : ''} Réservez votre course en quelques clics — c'est simple, rapide et gratuit.`;
  }
}

function getNicheServiceOptions(niche: string | null): string {
  const base = [
    { value: 'transfer', label: 'Transfert / Trajet' },
    { value: 'airport', label: 'Aéroport' },
    { value: 'hourly', label: 'Mise à disposition' },
    { value: 'event', label: 'Événement' },
  ];
  const nicheExtras: Record<string, { value: string; label: string }[]> = {
    corporate: [
      { value: 'business_meeting', label: 'Rendez-vous professionnel' },
      { value: 'seminar', label: 'Séminaire / Conférence' },
    ],
    evenementiel: [
      { value: 'wedding', label: 'Mariage' },
      { value: 'gala', label: 'Gala / Soirée' },
    ],
    medical: [
      { value: 'hospital', label: 'Rendez-vous médical' },
      { value: 'mobility', label: 'Mobilité réduite' },
    ],
    transfert: [
      { value: 'train_station', label: 'Gare' },
      { value: 'long_distance', label: 'Longue distance' },
    ],
    nuit: [
      { value: 'nightclub', label: 'Sortie nocturne' },
      { value: 'restaurant', label: 'Restaurant / After-work' },
    ],
    famille: [
      { value: 'school', label: 'Trajet scolaire' },
      { value: 'family_outing', label: 'Sortie en famille' },
    ],
    premium: [
      { value: 'vip', label: 'Service VIP' },
      { value: 'luxury_hotel', label: 'Hôtel de luxe' },
    ],
  };
  const extras = niche && nicheExtras[niche] ? nicheExtras[niche] : [];
  const allOptions = [...base, ...extras];
  return allOptions.map((o) => `<option value="${o.value}">${o.label}</option>`).join('\n        ');
}

// ── Page HTML publique passager (/c/:slug) — CRO OPTIMISÉ ────
function renderDriverPage(site: any, source: string): string {
  const rating = site.rating || 5;
  const stars = '★'.repeat(Math.round(rating)) + '☆'.repeat(5 - Math.round(rating));
  const backendUrl =
    process.env.BACKEND_URL || 'https://foreas-stripe-backend-production.up.railway.app';
  // Use BACKEND_URL for public pages — it's the actual server that serves /c/:slug
  // PUBLIC_SITE_URL (app.foreas.xyz) only used if custom domain is properly routed
  const publicUrl = backendUrl;
  const siteUrl = `${publicUrl}/c/${site.slug}`;
  const themeColor = site.theme_color || '#8C52FF';
  const displayName = site.display_name || 'Chauffeur';
  const firstName = displayName.split(' ')[0];
  const city = site.city || 'France';
  // Derive vehicle type from niche if not explicitly set
  const nicheLabels: Record<string, string> = {
    corporate: 'VTC Corporate',
    evenementiel: 'VTC Événementiel',
    medical: 'VTC Médical',
    transfert: 'VTC Transfert',
    nuit: 'VTC Nuit',
    famille: 'VTC Famille',
    premium: 'VTC Premium',
  };
  const vehicleType =
    site.vehicle_type ||
    site.niche_label ||
    (site.niche && nicheLabels[site.niche]) ||
    'Chauffeur VTC';
  const totalTrips = site.total_trips || 0;
  const totalTipCount = site.total_tip_count || 0;
  const languages = site.languages || ['Français'];
  const bio = site.bio || generateBio(displayName, city, rating, totalTrips, languages, site.niche);
  const metaDescription = bio.substring(0, 155).replace(/"/g, '&quot;');
  const pricing = site.pricing || null;
  const promoCode = site.promo_code || null;
  const promoPercent = site.promo_discount_percent || 0;

  // JSON-LD structured data
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    additionalType: 'https://schema.org/TaxiService',
    name: `${displayName} — ${vehicleType}`,
    description: bio.substring(0, 300),
    url: siteUrl,
    ...(site.photo_url ? { image: site.photo_url } : {}),
    address: {
      '@type': 'PostalAddress',
      addressLocality: city,
      addressCountry: 'FR',
    },
    ...(totalTipCount > 0
      ? {
          aggregateRating: {
            '@type': 'AggregateRating',
            ratingValue: rating.toFixed(1),
            bestRating: '5',
            ratingCount: String(totalTipCount),
          },
        }
      : {}),
    priceRange: '€€',
    knowsLanguage: languages,
    areaServed: {
      '@type': 'City',
      name: city,
    },
    potentialAction: [
      {
        '@type': 'ReserveAction',
        target: {
          '@type': 'EntryPoint',
          urlTemplate: siteUrl,
          actionPlatform: [
            'http://schema.org/DesktopWebPlatform',
            'http://schema.org/MobileWebPlatform',
          ],
        },
        name: 'Réserver une course',
      },
      {
        '@type': 'DonateAction',
        target: {
          '@type': 'EntryPoint',
          urlTemplate: siteUrl,
          actionPlatform: [
            'http://schema.org/DesktopWebPlatform',
            'http://schema.org/MobileWebPlatform',
          ],
        },
        name: 'Laisser un pourboire',
      },
    ],
  };

  // BreadcrumbList for SEO
  const breadcrumbLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'FOREAS', item: 'https://foreas.app' },
      {
        '@type': 'ListItem',
        position: 2,
        name: 'Chauffeurs',
        item: `${siteUrl.split('/c/')[0]}/c`,
      },
      { '@type': 'ListItem', position: 3, name: displayName, item: siteUrl },
    ],
  };

  // Pricing grid HTML
  let pricingHtml = '';
  if (pricing && typeof pricing === 'object') {
    const entries = Object.entries(pricing).filter(([, v]) => v && Number(v) > 0);
    if (entries.length > 0) {
      pricingHtml = `
<div class="card">
  <div class="section-title">Tarifs indicatifs</div>
  <div class="pricing-grid">
    ${entries.map(([label, price]) => `<div class="pricing-item"><span class="pricing-label">${label}</span><span class="pricing-price">${price}€</span></div>`).join('')}
  </div>
</div>`;
    }
  }

  // Trust badges
  const tripsLabel = totalTrips > 100 ? `${totalTrips}+` : totalTrips > 0 ? `${totalTrips}` : '—';

  return `<!DOCTYPE html>
<html lang="fr" prefix="og: https://ogp.me/ns#">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0">
<title>${displayName} — ${vehicleType} ${city} | FOREAS</title>

<!-- SEO Meta -->
<meta name="description" content="${metaDescription}">
<meta name="robots" content="index, follow, max-image-preview:large">
<link rel="canonical" href="${siteUrl}">
<meta name="theme-color" content="${themeColor}">
<meta name="author" content="${displayName}">

<!-- Open Graph -->
<meta property="og:type" content="profile">
<meta property="og:title" content="${displayName} — ${vehicleType} ${city}">
<meta property="og:description" content="${metaDescription}">
<meta property="og:url" content="${siteUrl}">
${
  site.photo_url
    ? `<meta property="og:image" content="${site.photo_url}">
<meta property="og:image:width" content="400">
<meta property="og:image:height" content="400">
<meta property="og:image:alt" content="Photo de ${displayName}">`
    : ''
}
<meta property="og:locale" content="fr_FR">
<meta property="og:site_name" content="FOREAS">
<meta property="profile:first_name" content="${displayName.split(' ')[0]}">
${displayName.split(' ').length > 1 ? `<meta property="profile:last_name" content="${displayName.split(' ').slice(1).join(' ')}">` : ''}

<!-- Twitter Card -->
<meta name="twitter:card" content="${site.photo_url ? 'summary_large_image' : 'summary'}">
<meta name="twitter:title" content="${displayName} — ${vehicleType}">
<meta name="twitter:description" content="${metaDescription}">
${site.photo_url ? `<meta name="twitter:image" content="${site.photo_url}">` : ''}

<!-- Enhanced SEO -->
<meta name="geo.region" content="FR">
<meta name="geo.placename" content="${city}">
<link rel="alternate" hreflang="fr" href="${siteUrl}">
<meta name="format-detection" content="telephone=yes">
<link rel="preload" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" as="style">

<!-- JSON-LD Structured Data -->
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<script type="application/ld+json">${JSON.stringify(breadcrumbLd)}</script>

<!-- Google Fonts -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">

<style>
  :root{--c-primary:${themeColor};--c-bg:#0a0a0f;--c-card:#111118;--c-border:rgba(255,255,255,0.07);--c-text:#fff;--c-muted:#aaa;--c-subtle:#ccc;--radius:20px;--font:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:var(--c-bg);color:var(--c-text);font-family:var(--font);min-height:100vh;-webkit-font-smoothing:antialiased}
  .wrap{max-width:480px;margin:0 auto;padding-bottom:80px}

  /* ── HERO (compact, CTA above fold) ── */
  .hero{background:linear-gradient(160deg,#0d0d1a 0%,#1a0d2e 50%,#0d0d1a 100%);padding:36px 20px 28px;text-align:center;position:relative;overflow:hidden}
  .hero::before{content:'';position:absolute;inset:0;background:radial-gradient(circle at 50% 0%,var(--c-primary)22 0%,transparent 70%)}
  .avatar{width:100px;height:100px;border-radius:50%;object-fit:cover;border:3px solid var(--c-primary);margin:0 auto 12px;display:block;background:#1a1a2e;position:relative}
  .avatar-placeholder{width:100px;height:100px;border-radius:50%;background:linear-gradient(135deg,var(--c-primary),#4a90e2);margin:0 auto 12px;display:flex;align-items:center;justify-content:center;font-size:36px;font-weight:800;color:#fff;position:relative}
  h1{font-size:26px;font-weight:800;margin-bottom:4px;position:relative;letter-spacing:-0.3px}
  .vehicle{color:var(--c-muted);font-size:14px;margin-bottom:8px;position:relative}
  .stars{color:#FFD700;font-size:20px;margin-bottom:2px;position:relative;letter-spacing:2px}
  .rating-text{color:var(--c-muted);font-size:13px;margin-bottom:16px;position:relative}

  /* ── PRIMARY CTA (above fold) ── */
  .hero-cta{display:block;width:calc(100% - 16px);margin:0 auto;background:linear-gradient(135deg,var(--c-primary),#4a90e2);border:none;border-radius:16px;padding:18px;font-size:17px;font-weight:700;color:#fff;cursor:pointer;transition:all .2s;text-align:center;text-decoration:none;font-family:var(--font);min-height:56px;position:relative;letter-spacing:0.2px}
  .hero-cta:hover{opacity:.92;transform:scale(1.01)}
  .hero-cta:active{transform:scale(0.98)}

  /* ── TRUST BADGES ── */
  .trust-row{display:flex;gap:8px;justify-content:center;padding:16px 16px 0}
  .trust-badge{flex:1;background:var(--c-card);border:1px solid var(--c-border);border-radius:14px;padding:14px 8px;text-align:center}
  .trust-icon{font-size:20px;margin-bottom:4px}
  .trust-val{font-size:16px;font-weight:700;color:var(--c-text)}
  .trust-label{font-size:10px;color:var(--c-muted);text-transform:uppercase;letter-spacing:0.5px;margin-top:2px}

  /* ── BOOKING MODULE ── */
  .booking{background:var(--c-card);border:1px solid var(--c-border);border-radius:var(--radius);margin:16px;padding:22px;position:relative}
  .booking-title{font-size:18px;font-weight:700;color:var(--c-text);margin-bottom:4px}
  .booking-sub{font-size:13px;color:var(--c-muted);margin-bottom:18px}
  .booking-progress{display:flex;gap:6px;margin-bottom:20px}
  .booking-step-dot{flex:1;height:4px;border-radius:2px;background:rgba(255,255,255,0.1);transition:background .3s}
  .booking-step-dot.active{background:var(--c-primary)}
  .booking-step{display:none}
  .booking-step.visible{display:block}
  .field-label{font-size:12px;font-weight:600;color:var(--c-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px}
  .field-row{display:flex;gap:10px}
  .field-row > *{flex:1}
  .field-group{margin-bottom:14px}
  .b-input{width:100%;background:#1a1a2e;border:1px solid rgba(255,255,255,0.12);border-radius:12px;padding:14px;font-size:15px;color:#fff;font-family:var(--font);min-height:48px;transition:border-color .2s}
  .b-input:focus{outline:none;border-color:var(--c-primary)}
  .b-input::placeholder{color:#555}
  select.b-input{appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23888' d='M6 8L1 3h10z'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 14px center;padding-right:36px}
  select.b-input option{background:#1a1a2e;color:#fff}
  .booking-next{width:100%;background:linear-gradient(135deg,var(--c-primary),#4a90e2);border:none;border-radius:14px;padding:16px;font-size:16px;font-weight:700;color:#fff;cursor:pointer;transition:all .2s;font-family:var(--font);min-height:52px;margin-top:4px}
  .booking-next:hover{opacity:.92}
  .booking-next:active{transform:scale(0.98)}
  .booking-next:disabled{opacity:.5;cursor:not-allowed}
  .booking-back{background:none;border:none;color:var(--c-muted);font-size:13px;cursor:pointer;padding:10px;margin-top:8px;font-family:var(--font);text-decoration:underline}
  .booking-confirm{background:#0d2b1a;border:1px solid #2ecc71;border-radius:16px;padding:20px;text-align:center;display:none}
  .booking-confirm h3{color:#2ecc71;font-size:18px;margin-bottom:6px}
  .booking-confirm p{color:var(--c-muted);font-size:14px}
  .required-star{color:#e74c3c;margin-left:2px}

  /* ── CARD / BIO ── */
  .card{background:var(--c-card);border:1px solid var(--c-border);border-radius:var(--radius);margin:16px;padding:22px}
  .bio{color:var(--c-subtle);font-size:15px;line-height:1.7}
  .section-title{font-size:13px;font-weight:600;color:var(--c-primary);text-transform:uppercase;letter-spacing:1px;margin-bottom:14px}

  /* ── PRICING ── */
  .pricing-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  .pricing-item{background:rgba(255,255,255,0.04);border:1px solid var(--c-border);border-radius:12px;padding:14px;display:flex;flex-direction:column;align-items:center;gap:4px}
  .pricing-label{font-size:12px;color:var(--c-muted);text-transform:uppercase;letter-spacing:0.5px}
  .pricing-price{font-size:20px;font-weight:700;color:var(--c-primary)}

  /* ── SECONDARY CTA ── */
  .cta-secondary{display:block;width:calc(100% - 32px);margin:8px auto 16px;background:transparent;border:2px solid var(--c-primary);border-radius:16px;padding:16px;font-size:16px;font-weight:700;color:var(--c-primary);cursor:pointer;transition:all .2s;text-align:center;text-decoration:none;font-family:var(--font);min-height:52px}
  .cta-secondary:hover{background:var(--c-primary);color:#fff}
  .cta-sub{display:block;text-align:center;font-size:12px;color:var(--c-muted);margin-bottom:16px}

  /* ── TIP ── */
  .tip-amounts{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:14px}
  .tip-btn{background:#1a1a2e;border:2px solid rgba(255,255,255,0.1);border-radius:12px;padding:12px 0;text-align:center;font-size:16px;font-weight:700;color:#fff;cursor:pointer;transition:all .2s;min-height:48px}
  .tip-btn.selected,.tip-btn:hover{border-color:var(--c-primary);background:var(--c-primary)22;color:var(--c-primary)}
  .pay-btn{width:100%;background:linear-gradient(135deg,var(--c-primary),#4a90e2);border:none;border-radius:16px;padding:18px;font-size:17px;font-weight:700;color:#fff;cursor:pointer;transition:opacity .2s;font-family:var(--font);min-height:56px}
  .pay-btn:hover{opacity:.9}
  .pay-btn:disabled{opacity:.5;cursor:not-allowed}

  /* ── REVIEW ── */
  .review-stars{display:flex;gap:10px;justify-content:center;margin-bottom:16px}
  .review-star{font-size:34px;cursor:pointer;color:#333;transition:color .15s}
  .review-star.lit{color:#FFD700}
  textarea{width:100%;background:#1a1a2e;border:1px solid rgba(255,255,255,0.12);border-radius:12px;padding:14px;font-size:15px;color:#fff;resize:none;min-height:90px;margin-bottom:12px;font-family:var(--font)}
  input[type=text],input[type=email],input[type=tel],input[type=date],input[type=time]{width:100%;background:#1a1a2e;border:1px solid rgba(255,255,255,0.12);border-radius:12px;padding:14px;font-size:15px;color:#fff;margin-bottom:10px;font-family:var(--font);min-height:48px}
  .submit-btn{width:100%;background:#1a1a2e;border:2px solid var(--c-primary);border-radius:16px;padding:16px;font-size:16px;font-weight:700;color:var(--c-primary);cursor:pointer;transition:all .2s;font-family:var(--font);min-height:52px}
  .submit-btn:hover{background:var(--c-primary);color:#fff}

  /* ── FOOTER ── */
  .foreas-badge{text-align:center;padding:32px 16px 48px;color:#444;font-size:12px}
  .foreas-badge a{color:var(--c-primary);text-decoration:none;font-weight:600}
  .foreas-badge .legal{margin-top:8px;font-size:10px;color:#333}

  /* ── MESSAGES ── */
  .success-msg{background:#0d2b1a;border:1px solid #2ecc71;border-radius:12px;padding:16px;color:#2ecc71;text-align:center;margin-top:12px;display:none}
  .error-msg{background:#2b0d0d;border:1px solid #e74c3c;border-radius:12px;padding:16px;color:#e74c3c;text-align:center;margin-top:12px;display:none}
  .stripe-secure{font-size:12px;color:#555;text-align:center;margin-top:8px}

  /* ── STICKY BAR ── */
  .sticky-bar{position:fixed;bottom:0;left:0;right:0;z-index:999;transform:translateY(100%);transition:transform .3s ease;background:linear-gradient(0deg,var(--c-bg) 0%,rgba(10,10,15,0.97) 100%);border-top:1px solid var(--c-border);padding:12px 16px;display:flex;align-items:center;justify-content:center}
  .sticky-bar.visible{transform:translateY(0)}
  .sticky-bar-btn{width:100%;max-width:480px;background:linear-gradient(135deg,var(--c-primary),#4a90e2);border:none;border-radius:14px;padding:16px;font-size:16px;font-weight:700;color:#fff;cursor:pointer;font-family:var(--font);min-height:52px;transition:all .2s}
  .sticky-bar-btn:hover{opacity:.92}
  .sticky-bar-btn:active{transform:scale(0.98)}

  /* ── ADDRESS AUTOCOMPLETE ── */
  .addr-wrap{position:relative}
  .addr-suggestions{position:absolute;top:100%;left:0;right:0;background:#1a1a2e;border:1px solid rgba(255,255,255,0.15);border-top:none;border-radius:0 0 12px 12px;max-height:220px;overflow-y:auto;z-index:100;display:none}
  .addr-suggestions.open{display:block}
  .addr-item{padding:12px 14px;font-size:14px;color:#ddd;cursor:pointer;border-bottom:1px solid rgba(255,255,255,0.05);font-family:var(--font);transition:background .15s}
  .addr-item:hover,.addr-item:focus{background:rgba(140,82,255,0.15);color:#fff}
  .addr-item:last-child{border-bottom:none;border-radius:0 0 12px 12px}
  .addr-item .addr-city{color:var(--c-muted);font-size:12px;margin-top:2px}

  @media(max-width:400px){.tip-amounts{grid-template-columns:repeat(2,1fr)}.pricing-grid{grid-template-columns:1fr}.field-row{flex-direction:column;gap:0}}
</style>
</head>
<body>
<div class="wrap">

<!-- ═══ 1. HERO COMPACT (Attention — above fold) ═══ -->
<header class="hero">
  ${
    site.photo_url
      ? `<img class="avatar" src="${site.photo_url}" alt="Photo de ${displayName}, ${vehicleType} ${city}" width="100" height="100">`
      : `<div class="avatar-placeholder">${displayName[0].toUpperCase()}</div>`
  }
  <h1>${displayName}</h1>
  <div class="vehicle">${vehicleType} · ${city}</div>
  <div class="stars" aria-label="Note ${rating.toFixed(1)} sur 5">${stars}</div>
  <div class="rating-text">${rating.toFixed(1)}/5 · ${totalTipCount > 0 ? totalTipCount + ' avis' : 'Nouveau sur FOREAS'}</div>
  <button class="hero-cta" id="heroCTA" onclick="document.getElementById('bookingSection').scrollIntoView({behavior:'smooth'})">
    Réserver ${firstName} maintenant
  </button>
</header>

<!-- ═══ 2. TRUST BADGES (Desire) ═══ -->
<div class="trust-row">
  <div class="trust-badge">
    <div class="trust-icon">✅</div>
    <div class="trust-val">Vérifié</div>
    <div class="trust-label">Profil</div>
  </div>
  <div class="trust-badge">
    <div class="trust-icon">🚗</div>
    <div class="trust-val">${tripsLabel}</div>
    <div class="trust-label">Courses</div>
  </div>
  <div class="trust-badge">
    <div class="trust-icon">⭐</div>
    <div class="trust-val">${rating.toFixed(1)}</div>
    <div class="trust-label">Note</div>
  </div>
</div>

<!-- ═══ 3. BOOKING MODULE — 2 ÉTAPES (Action) ═══ -->
<div class="booking" id="bookingSection">
  <div class="booking-title">Réserver votre trajet</div>
  <div class="booking-sub">Gratuit, sans engagement · Réponse rapide</div>

  <!-- Progress dots -->
  <div class="booking-progress">
    <div class="booking-step-dot active" id="dot1"></div>
    <div class="booking-step-dot" id="dot2"></div>
  </div>

  <!-- STEP 1: Trajet -->
  <div class="booking-step visible" id="step1">
    <div class="field-group">
      <div class="field-label">Type de service</div>
      <select class="b-input" id="bService">
        ${getNicheServiceOptions(site.niche)}
      </select>
    </div>
    <div class="field-group">
      <div class="field-label">Adresse de prise en charge</div>
      <div class="addr-wrap">
        <input type="text" class="b-input" id="bAddress" placeholder="Ex: 10 rue de Rivoli, Paris" autocomplete="off">
        <div class="addr-suggestions" id="addrSuggest1"></div>
      </div>
    </div>
    <div class="field-group">
      <div class="field-label">Destination</div>
      <div class="addr-wrap">
        <input type="text" class="b-input" id="bDest" placeholder="Ex: Aéroport CDG, Terminal 2" autocomplete="off">
        <div class="addr-suggestions" id="addrSuggest2"></div>
      </div>
    </div>
    <div id="priceEstimate" style="display:none;background:rgba(140,82,255,0.1);border:1px solid rgba(140,82,255,0.3);border-radius:14px;padding:16px;margin-bottom:14px;text-align:center">
      <div style="font-size:12px;color:var(--c-muted);text-transform:uppercase;letter-spacing:0.8px;margin-bottom:6px">Tarif estimé · Prix fixe</div>
      <div id="priceValue" style="font-size:32px;font-weight:800;color:var(--c-primary);margin-bottom:4px"></div>
      <div id="priceDetail" style="font-size:12px;color:var(--c-muted)"></div>
    </div>
    <div class="field-row">
      <div class="field-group">
        <div class="field-label">Date</div>
        <input type="date" class="b-input" id="bDate">
      </div>
      <div class="field-group">
        <div class="field-label">Heure</div>
        <input type="time" class="b-input" id="bTime">
      </div>
    </div>
    <button class="booking-next" onclick="goStep2()">Continuer →</button>
  </div>

  <!-- STEP 2: Coordonnées -->
  <div class="booking-step" id="step2">
    <div class="field-group">
      <div class="field-label">Votre nom<span class="required-star">*</span></div>
      <input type="text" class="b-input" id="bName" placeholder="Prénom Nom" required>
    </div>
    <div class="field-group">
      <div class="field-label">Téléphone<span class="required-star">*</span></div>
      <input type="tel" class="b-input" id="bPhone" placeholder="06 12 34 56 78" required>
    </div>
    <div class="field-group">
      <div class="field-label">Email (optionnel)</div>
      <input type="email" class="b-input" id="bEmail" placeholder="votre@email.com">
    </div>
    <div class="field-group">
      <div class="field-label">Notes (optionnel)</div>
      <input type="text" class="b-input" id="bNotes" placeholder="Nombre de bagages, destination...">
    </div>
    <button class="booking-next" id="bookSubmitBtn" onclick="submitBooking()">Confirmer la réservation</button>
    <button class="booking-back" onclick="goStep1()">← Modifier le trajet</button>
  </div>

  <!-- Confirmation -->
  <div class="booking-confirm" id="bookingConfirm">
    <h3>Réservation envoyée !</h3>
    <p>${firstName} vous recontactera très rapidement pour confirmer votre trajet.</p>
  </div>
  <div class="error-msg" id="bookingError"></div>
</div>

<!-- ═══ 4. BIO (Interest — PAS Framework) ═══ -->
<div class="card">
  <div class="bio">${bio}</div>
</div>

<!-- ═══ 5. TARIFS ═══ -->
${pricingHtml}

<!-- ═══ 5b. CODE PROMO ═══ -->
${
  promoCode && promoPercent > 0
    ? `
<div class="card" style="border-color:rgba(245,158,11,0.3);background:rgba(245,158,11,0.06)">
  <div style="text-align:center">
    <div style="font-size:13px;font-weight:600;color:#F59E0B;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">🎁 Offre 1ère réservation</div>
    <div style="font-size:36px;font-weight:800;color:#F59E0B;margin-bottom:4px">-${promoPercent}%</div>
    <div style="display:inline-block;background:rgba(0,0,0,0.3);border:2px dashed rgba(245,158,11,0.5);border-radius:10px;padding:10px 24px;margin:8px 0">
      <span style="font-size:20px;font-weight:800;color:#fff;letter-spacing:3px;font-family:monospace">${promoCode}</span>
    </div>
    <div style="font-size:12px;color:var(--c-muted);margin-top:8px">Mentionnez ce code lors de votre réservation · Valable 1 fois</div>
  </div>
</div>
`
    : ''
}

<!-- ═══ 6. CTA SECONDAIRE ═══ -->
<button class="cta-secondary" onclick="document.getElementById('bookingSection').scrollIntoView({behavior:'smooth'})">
  Réserver ${firstName} maintenant
</button>
<span class="cta-sub">Gratuit · Sans application · Réponse rapide</span>

<!-- ═══ 7. POURBOIRE ═══ -->
<div class="card">
  <div class="section-title">💳 Laisser un pourboire</div>
  <div class="tip-amounts">
    <div class="tip-btn" onclick="selectTip(2)" data-amount="2">2€</div>
    <div class="tip-btn" onclick="selectTip(5)" data-amount="5">5€</div>
    <div class="tip-btn" onclick="selectTip(10)" data-amount="10">10€</div>
    <div class="tip-btn" onclick="selectTip(0)" data-amount="0">Autre</div>
  </div>
  <input type="text" id="customTip" placeholder="Montant personnalisé (€)" style="display:none" oninput="updateCustom(this.value)">
  <input type="email" id="passengerEmail" placeholder="Votre email (reçu)" autocomplete="email">
  <button class="pay-btn" id="payBtn" onclick="processTip()" disabled>Payer en sécurité</button>
  <div class="stripe-secure">🔒 Paiement sécurisé par Stripe</div>
  <div class="success-msg" id="tipSuccess">Merci ! Votre pourboire a bien été envoyé.</div>
  <div class="error-msg" id="tipError"></div>
</div>

<!-- ═══ 8. AVIS ═══ -->
<div class="card">
  <div class="section-title">⭐ Laisser un avis</div>
  <div class="review-stars">
    <span class="review-star" onclick="setRating(1)" aria-label="1 étoile">★</span>
    <span class="review-star" onclick="setRating(2)" aria-label="2 étoiles">★</span>
    <span class="review-star" onclick="setRating(3)" aria-label="3 étoiles">★</span>
    <span class="review-star" onclick="setRating(4)" aria-label="4 étoiles">★</span>
    <span class="review-star" onclick="setRating(5)" aria-label="5 étoiles">★</span>
  </div>
  <textarea id="reviewText" placeholder="Dites-nous comment s'est passé votre trajet..."></textarea>
  <input type="text" id="reviewName" placeholder="Votre prénom (optionnel)">
  <button class="submit-btn" onclick="submitReview()">Publier l'avis</button>
  <div class="success-msg" id="reviewSuccess">Merci pour votre avis !</div>
  <div class="error-msg" id="reviewError"></div>
</div>

<!-- ═══ 9. FOOTER ═══ -->
<footer class="foreas-badge">
  Site propulsé par <a href="https://foreas.app" target="_blank" rel="noopener">FOREAS</a> · Copilote IA pour chauffeurs VTC<br>
  <div class="legal">&copy; ${new Date().getFullYear()} FOREAS Labs &middot; CGU &middot; Confidentialit&eacute;</div>
</footer>

</div><!-- /wrap -->

<!-- ═══ 10. STICKY BOTTOM BAR ═══ -->
<div class="sticky-bar" id="stickyBar">
  <button class="sticky-bar-btn" onclick="document.getElementById('bookingSection').scrollIntoView({behavior:'smooth'})">
    Réserver ${firstName} →
  </button>
</div>

<script>
  var BACKEND = '${backendUrl}';
  var SLUG = '${site.slug}';
  var selectedAmount = 0;
  var selectedRating = 0;

  // ── PRICE CALCULATOR ──
  var PRICING = ${pricing ? JSON.stringify(pricing) : 'null'};
  var PROMO_PERCENT = ${promoPercent};
  var calcTimeout = null;

  function debounce(fn, ms) { return function() { clearTimeout(calcTimeout); calcTimeout = setTimeout(fn, ms); }; }

  var tryCalcPrice = debounce(function() {
    var from = document.getElementById('bAddress').value.trim();
    var to = document.getElementById('bDest') ? document.getElementById('bDest').value.trim() : '';
    if (!from || !to || !PRICING) { document.getElementById('priceEstimate').style.display = 'none'; return; }
    Promise.all([geocode(from), geocode(to)]).then(function(coords) {
      if (!coords[0] || !coords[1]) { document.getElementById('priceEstimate').style.display = 'none'; return; }
      var dist = haversine(coords[0][0], coords[0][1], coords[1][0], coords[1][1]);
      var roadDist = dist * 1.3; // route factor
      var fare = Math.max(PRICING.minimumFare || 15, PRICING.baseRate + PRICING.perKmRate * roadDist);
      var el = document.getElementById('priceEstimate');
      var valEl = document.getElementById('priceValue');
      var detEl = document.getElementById('priceDetail');
      valEl.textContent = Math.round(fare) + ' \u20AC';
      detEl.textContent = roadDist.toFixed(1) + ' km \u00B7 Prix fixe garanti';
      if (PROMO_PERCENT > 0) {
        var discounted = Math.round(fare * (1 - PROMO_PERCENT / 100));
        valEl.innerHTML = '<span style="text-decoration:line-through;color:var(--c-muted);font-size:18px;margin-right:8px">' + Math.round(fare) + '\u20AC</span>' + discounted + ' \u20AC';
        detEl.textContent = roadDist.toFixed(1) + ' km \u00B7 -' + PROMO_PERCENT + '% 1\u00E8re course';
      }
      el.style.display = 'block';
    }).catch(function() { document.getElementById('priceEstimate').style.display = 'none'; });
  }, 600);

  function geocode(addr) {
    return fetch('https://api-adresse.data.gouv.fr/search/?q=' + encodeURIComponent(addr) + '&limit=1')
      .then(function(r) { return r.json(); })
      .then(function(d) { return d.features && d.features.length ? [d.features[0].geometry.coordinates[1], d.features[0].geometry.coordinates[0]] : null; })
      .catch(function() { return null; });
  }

  function haversine(lat1, lon1, lat2, lon2) {
    var R = 6371;
    var dLat = (lat2 - lat1) * Math.PI / 180;
    var dLon = (lon2 - lon1) * Math.PI / 180;
    var a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2) * Math.sin(dLon/2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }

  // Bind input events for price calculator
  if (document.getElementById('bAddress')) {
    document.getElementById('bAddress').addEventListener('input', tryCalcPrice);
    if (document.getElementById('bDest')) document.getElementById('bDest').addEventListener('input', tryCalcPrice);
  }

  // ── ADDRESS AUTOCOMPLETE (API Adresse gouv.fr — 100% gratuit, sans clé) ──
  function setupAddrAutocomplete(inputId, suggestId) {
    var input = document.getElementById(inputId);
    var list = document.getElementById(suggestId);
    if (!input || !list) return;
    var timer = null;

    input.addEventListener('input', function() {
      clearTimeout(timer);
      var q = input.value.trim();
      if (q.length < 3) { list.classList.remove('open'); list.innerHTML = ''; return; }
      timer = setTimeout(function() {
        fetch('https://api-adresse.data.gouv.fr/search/?q=' + encodeURIComponent(q) + '&limit=5&type=housenumber&type=street')
          .then(function(r) { return r.json(); })
          .then(function(data) {
            list.innerHTML = '';
            if (!data.features || data.features.length === 0) { list.classList.remove('open'); return; }
            data.features.forEach(function(f) {
              var p = f.properties;
              var div = document.createElement('div');
              div.className = 'addr-item';
              div.innerHTML = p.name + '<div class="addr-city">' + p.postcode + ' ' + p.city + '</div>';
              div.addEventListener('click', function() {
                input.value = p.label;
                list.classList.remove('open');
                list.innerHTML = '';
                tryCalcPrice();
              });
              list.appendChild(div);
            });
            list.classList.add('open');
          })
          .catch(function() { list.classList.remove('open'); });
      }, 280);
    });

    // Close dropdown on outside click
    document.addEventListener('click', function(e) {
      if (!e.target.closest('.addr-wrap')) { list.classList.remove('open'); list.innerHTML = ''; }
    });

    // Keyboard navigation
    input.addEventListener('keydown', function(e) {
      var items = list.querySelectorAll('.addr-item');
      if (!items.length) return;
      var active = list.querySelector('.addr-item:focus');
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (!active) items[0].focus();
        else if (active.nextElementSibling) active.nextElementSibling.focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (active && active.previousElementSibling) active.previousElementSibling.focus();
        else input.focus();
      } else if (e.key === 'Enter' && active) {
        e.preventDefault();
        active.click();
      } else if (e.key === 'Escape') {
        list.classList.remove('open');
        list.innerHTML = '';
      }
    });
  }

  // Init autocomplete on both address fields
  setupAddrAutocomplete('bAddress', 'addrSuggest1');
  setupAddrAutocomplete('bDest', 'addrSuggest2');

  // Track view
  fetch(BACKEND + '/api/driver-site/view/' + SLUG, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source:'${source}'})}).catch(function(){});

  // ── BOOKING 2-STEP ──
  function goStep2() {
    document.getElementById('step1').classList.remove('visible');
    document.getElementById('step2').classList.add('visible');
    document.getElementById('dot1').classList.remove('active');
    document.getElementById('dot2').classList.add('active');
    document.getElementById('step2').scrollIntoView({behavior:'smooth',block:'nearest'});
  }

  function goStep1() {
    document.getElementById('step2').classList.remove('visible');
    document.getElementById('step1').classList.add('visible');
    document.getElementById('dot2').classList.remove('active');
    document.getElementById('dot1').classList.add('active');
  }

  function submitBooking() {
    var name = document.getElementById('bName').value.trim();
    var phone = document.getElementById('bPhone').value.trim();
    if (!name || !phone) {
      alert('Nom et téléphone sont obligatoires');
      return;
    }
    var btn = document.getElementById('bookSubmitBtn');
    btn.disabled = true;
    btn.textContent = 'Envoi en cours...';
    document.getElementById('bookingError').style.display = 'none';

    fetch(BACKEND + '/api/driver-site/booking', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        slug: SLUG,
        service_type: document.getElementById('bService').value,
        pickup_address: document.getElementById('bAddress').value,
        booking_date: document.getElementById('bDate').value,
        booking_time: document.getElementById('bTime').value,
        passenger_name: name,
        passenger_phone: phone,
        passenger_email: document.getElementById('bEmail').value,
        notes: document.getElementById('bNotes').value,
        destination: document.getElementById('bDest') ? document.getElementById('bDest').value : '',
        source: '${source}'
      })
    }).then(function(r){return r.json()}).then(function(data) {
      if (data.success) {
        document.getElementById('step2').classList.remove('visible');
        document.querySelector('.booking-progress').style.display = 'none';
        document.querySelector('.booking-sub').style.display = 'none';
        document.getElementById('bookingConfirm').style.display = 'block';
      } else {
        throw new Error(data.error || 'Erreur');
      }
    }).catch(function(e) {
      document.getElementById('bookingError').textContent = 'Erreur: ' + e.message;
      document.getElementById('bookingError').style.display = 'block';
      btn.disabled = false;
      btn.textContent = 'Confirmer la réservation';
    });
  }

  // ── STICKY BAR (IntersectionObserver) ──
  var stickyBar = document.getElementById('stickyBar');
  var heroCTA = document.getElementById('heroCTA');
  if (heroCTA && stickyBar && 'IntersectionObserver' in window) {
    var observer = new IntersectionObserver(function(entries) {
      entries.forEach(function(entry) {
        if (entry.isIntersecting) {
          stickyBar.classList.remove('visible');
        } else {
          stickyBar.classList.add('visible');
        }
      });
    }, {threshold: 0});
    observer.observe(heroCTA);
  }

  // ── TIP (preserved) ──
  function selectTip(amount) {
    document.querySelectorAll('.tip-btn').forEach(function(b){b.classList.remove('selected')});
    document.getElementById('customTip').style.display = amount === 0 ? 'block' : 'none';
    if (amount > 0) {
      document.querySelector('[data-amount="'+amount+'"]').classList.add('selected');
      selectedAmount = amount;
    } else {
      selectedAmount = 0;
    }
    updatePayBtn();
  }

  function updateCustom(val) {
    selectedAmount = parseFloat(val) || 0;
    updatePayBtn();
  }

  function updatePayBtn() {
    var btn = document.getElementById('payBtn');
    btn.disabled = selectedAmount < 1;
    btn.textContent = selectedAmount >= 1 ? 'Payer ' + selectedAmount + '€ en sécurité' : 'Sélectionnez un montant';
  }

  function processTip() {
    var btn = document.getElementById('payBtn');
    var email = document.getElementById('passengerEmail').value;
    btn.disabled = true;
    btn.textContent = 'Traitement...';
    document.getElementById('tipError').style.display = 'none';
    fetch(BACKEND + '/api/driver-site/tip', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({slug: SLUG, amount: selectedAmount, email: email, source: '${source}'})
    }).then(function(r){return r.json()}).then(function(data) {
      if (data.checkout_url) {
        window.location.href = data.checkout_url;
      } else if (data.error) {
        throw new Error(data.error);
      }
    }).catch(function(e) {
      document.getElementById('tipError').textContent = 'Erreur: ' + e.message;
      document.getElementById('tipError').style.display = 'block';
      btn.disabled = false;
      updatePayBtn();
    });
  }

  // ── REVIEW (preserved) ──
  function setRating(n) {
    selectedRating = n;
    document.querySelectorAll('.review-star').forEach(function(s,i) {
      s.classList.toggle('lit', i < n);
    });
  }

  function submitReview() {
    if (!selectedRating) { alert('Choisissez une note d\\'abord'); return; }
    var text = document.getElementById('reviewText').value;
    var name = document.getElementById('reviewName').value;
    document.getElementById('reviewError').style.display = 'none';
    fetch(BACKEND + '/api/driver-site/review', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({slug: SLUG, rating: selectedRating, text: text, name: name})
    }).then(function() {
      document.getElementById('reviewSuccess').style.display = 'block';
      document.getElementById('reviewText').value = '';
      setRating(0);
    }).catch(function() {
      document.getElementById('reviewError').textContent = 'Erreur, réessayez.';
      document.getElementById('reviewError').style.display = 'block';
    });
  }
</script>
</body></html>`;
}

// ── Shared render handler ────────────────────────────────────
async function renderDriverSiteBySlug(slug: string, source: string, res: any): Promise<any> {
  try {
    const supa = await getSupabaseAdmin();
    const { data: site, error } = await supa
      .from('driver_sites')
      .select('*')
      .eq('slug', slug)
      .eq('is_active', true)
      .single();
    if (error || !site) {
      return res
        .status(404)
        .send(
          '<h1 style="font-family:sans-serif;text-align:center;margin-top:80px;color:#333">Page introuvable</h1>',
        );
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    const bUrl =
      process.env.BACKEND_URL || 'https://foreas-stripe-backend-production.up.railway.app';
    return res.send(
      renderDriverPageV3(site, source, {
        backendUrl: bUrl,
        stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY || undefined,
        mapboxToken: process.env.MAPBOX_ACCESS_TOKEN || undefined,
      }),
    );
  } catch (err: any) {
    console.error('[DriverSite] render error:', err.message);
    return res.status(500).send('<p>Erreur serveur</p>');
  }
}

// ── GET /c/:slug — Legacy route (compat slugs existants pré-v104) ──
app.get('/c/:slug', async (req: any, res: any) => {
  const { slug } = req.params;
  const source = (req.query.src as string) || 'link';
  return renderDriverSiteBySlug(slug, source, res);
});

// ── GET /:slug — v104 Sprint 3A — URL directe foreas.xyz/prenom-XX ──
// Catch-all qui sert les sites chauffeur via URL racine.
// Garde-fou : filtre les segments réservés (api, webhooks, pages légales, etc.)
// pour ne pas intercepter les autres routes du backend.
app.get('/:slug', async (req: any, res: any, next: any) => {
  const { slug } = req.params;

  // Ignore les routes réservées → laisse passer au middleware suivant
  if (RESERVED_URL_SEGMENTS.has(slug.toLowerCase())) {
    return next();
  }
  // Ignore les fichiers avec extension (.txt, .ico, .png, etc.)
  if (/\.[a-z0-9]{2,5}$/i.test(slug)) {
    return next();
  }
  // Validation format attendu : prenom-XX (lettres + tiret + chiffres)
  if (!/^[a-z][a-z0-9-]{1,40}$/i.test(slug)) {
    return next();
  }

  const source = (req.query.src as string) || 'link';
  return renderDriverSiteBySlug(slug, source, res);
});

// ── POST /api/driver-site/generate — Créer / mettre à jour le site ──
app.post('/api/driver-site/generate', async (req: any, res: any) => {
  const {
    driver_id,
    display_name,
    photo_url,
    bio,
    languages,
    vehicle_type,
    city,
    rating,
    total_trips,
    theme_color,
    niche,
    niche_label,
    pricing,
    promo_discount_percent,
  } = req.body || {};
  if (!driver_id || !display_name)
    return res.status(400).json({ error: 'driver_id + display_name requis' });
  try {
    const supa = await getSupabaseAdmin();
    // Vérifier si un site existe déjà
    const { data: existing } = await supa
      .from('driver_sites')
      .select('id,slug')
      .eq('driver_id', driver_id)
      .single();
    const slug = existing?.slug || (await generateUniqueSlug(display_name));
    const generatedBio =
      bio ||
      generateBio(
        display_name,
        city || 'France',
        rating || 5.0,
        total_trips || 0,
        languages || ['Français'],
        niche,
      );
    const siteData: Record<string, any> = {
      driver_id,
      slug,
      display_name,
      bio: generatedBio,
      languages: languages || ['Français'],
      vehicle_type: vehicle_type || null,
      city: city || null,
      rating: rating || 5.0,
      total_trips: total_trips || 0,
      theme_color: theme_color || '#8C52FF',
      is_active: true,
      updated_at: new Date().toISOString(),
    };
    // Add optional enriched fields if provided (don't overwrite existing values)
    if (photo_url) siteData.photo_url = photo_url;
    if (niche) siteData.niche = niche;
    if (niche_label) siteData.niche_label = niche_label;
    if (pricing) siteData.pricing = pricing;
    if (promo_discount_percent != null) siteData.promo_discount_percent = promo_discount_percent;

    // Promo code: ALWAYS auto-generate if missing (new OR existing without code)
    let isNewPromoCode = false;
    if (!existing) {
      siteData.promo_code = generatePromoCode(display_name);
      isNewPromoCode = true;
    } else {
      // Check if existing site has a promo code
      const { data: existingSite } = await supa
        .from('driver_sites')
        .select('promo_code')
        .eq('id', existing.id)
        .single();
      if (!existingSite?.promo_code) {
        siteData.promo_code = generatePromoCode(display_name);
        isNewPromoCode = true;
      }
    }

    const { data, error } = existing
      ? await supa.from('driver_sites').update(siteData).eq('id', existing.id).select().single()
      : await supa.from('driver_sites').insert(siteData).select().single();
    if (error) throw new Error(error.message);
    const siteBaseUrl =
      process.env.BACKEND_URL || 'https://foreas-stripe-backend-production.up.railway.app';
    const publicUrl = `${siteBaseUrl}/c/${data.slug}`;

    // Send promo code email to driver (async, non-blocking)
    if (isNewPromoCode && data.promo_code) {
      // Fetch driver email from drivers table
      const { data: driver } = await supa
        .from('drivers')
        .select('email')
        .eq('id', driver_id)
        .single();
      if (driver?.email) {
        sendPromoCodeEmail(
          driver.email,
          display_name,
          data.promo_code,
          data.promo_discount_percent || 10,
          publicUrl,
        ).catch((e: any) => console.error('[PromoEmail] bg error:', e.message));
      }
    }

    return res.json({
      success: true,
      site: data,
      public_url: publicUrl,
      qr_data: `${publicUrl}?src=qr`,
    });
  } catch (err: any) {
    console.error('[DriverSite] generate error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/driver-site/mine/:driverId — Données du site chauffeur ──
app.get('/api/driver-site/mine/:driverId', async (req: any, res: any) => {
  const { driverId } = req.params;
  try {
    const supa = await getSupabaseAdmin();
    const { data: site } = await supa
      .from('driver_sites')
      .select('*')
      .eq('driver_id', driverId)
      .single();
    const siteBaseUrl =
      process.env.BACKEND_URL || 'https://foreas-stripe-backend-production.up.railway.app';
    if (!site) return res.json({ exists: false });
    return res.json({
      exists: true,
      site,
      public_url: `${siteBaseUrl}/c/${site.slug}`,
      qr_data: `${siteBaseUrl}/c/${site.slug}?src=qr`,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/driver-site/tip — Créer checkout Stripe pour pourboire ──
app.post('/api/driver-site/tip', async (req: any, res: any) => {
  const { slug, amount, email, source } = req.body || {};
  if (!slug || !amount || amount < 1)
    return res.status(400).json({ error: 'slug + amount (min 1€) requis' });
  try {
    const supa = await getSupabaseAdmin();
    const { data: site } = await supa.from('driver_sites').select('*').eq('slug', slug).single();
    if (!site) return res.status(404).json({ error: 'Site introuvable' });
    if (!site.stripe_account_id || !site.stripe_charges_enabled) {
      return res
        .status(400)
        .json({ error: 'Chauffeur non connecté à Stripe', code: 'stripe_not_connected' });
    }
    const stripe = await getStripe();
    const amountCents = Math.round(amount * 100);
    // v1.10.50 — Commission par chauffeur configurable via driver_sites.commission_percent.
    // Default 0% → tout va au chauffeur. Modifiable plus tard pour MLM/Premium tier.
    const commissionPercent = Number(site.commission_percent ?? 0);
    const platformFeeCents = Math.round(amountCents * (commissionPercent / 100));
    const backendUrl =
      process.env.BACKEND_URL || 'https://foreas-stripe-backend-production.up.railway.app';
    // Stripe Checkout pour le pourboire
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'eur',
            unit_amount: amountCents,
            product_data: {
              name: `Pourboire pour ${site.display_name}`,
              description: `Merci pour votre course ! FOREAS facilite ce paiement.`,
            },
          },
          quantity: 1,
        },
      ],
      payment_intent_data: {
        // application_fee_amount=0 si commission_percent=0 (Stripe accepte 0)
        application_fee_amount: platformFeeCents,
        transfer_data: { destination: site.stripe_account_id },
        metadata: {
          driver_site_id: site.id,
          slug,
          source: source || 'web',
          commission_percent: String(commissionPercent),
        },
      },
      customer_email: email || undefined,
      success_url: `${backendUrl}/c/${slug}?tip=success`,
      cancel_url: `${backendUrl}/c/${slug}?tip=cancel`,
    });
    // Enregistrer l'interaction (en attente de confirmation)
    await supa.from('driver_site_interactions').insert({
      driver_site_id: site.id,
      interaction_type: 'tip',
      passenger_email: email || null,
      tip_amount: amount,
      platform_fee: platformFeeCents / 100,
      driver_net: (amountCents - platformFeeCents) / 100,
      scan_source: source || 'web',
    });
    return res.json({ checkout_url: session.url });
  } catch (err: any) {
    console.error('[DriverSite] tip error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/driver-site/review — Avis passager ─────────────
app.post('/api/driver-site/review', async (req: any, res: any) => {
  const { slug, rating, text, name } = req.body || {};
  if (!slug || !rating || rating < 1 || rating > 5)
    return res.status(400).json({ error: 'slug + rating (1-5) requis' });
  try {
    const supa = await getSupabaseAdmin();
    const { data: site } = await supa
      .from('driver_sites')
      .select('id,total_tip_count,rating')
      .eq('slug', slug)
      .single();
    if (!site) return res.status(404).json({ error: 'Site introuvable' });
    // Sauvegarder l'avis
    await supa.from('driver_site_interactions').insert({
      driver_site_id: site.id,
      interaction_type: 'review',
      passenger_name: name || null,
      review_rating: rating,
      review_text: text || null,
    });
    // Mettre à jour la note moyenne du site
    const newCount = (site.total_tip_count || 0) + 1;
    const newRating = ((site.rating || 5.0) * (newCount - 1) + rating) / newCount;
    await supa
      .from('driver_sites')
      .update({ total_tip_count: newCount, rating: Math.round(newRating * 100) / 100 })
      .eq('id', site.id);
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/bookings/upload-photo — Upload photo chauffeur → Supabase Storage ──
app.post('/api/bookings/upload-photo', async (req: any, res: any) => {
  const { driverId, base64, mimeType } = req.body || {};
  if (!driverId || !base64) {
    return res.status(400).json({ error: 'driverId + base64 requis' });
  }

  try {
    const supa = await getSupabaseAdmin();
    const ext = (mimeType || 'image/jpeg').includes('png') ? 'png' : 'jpg';
    const filePath = `${driverId}/photo-${Date.now()}.${ext}`;

    // Decode base64 to Buffer
    const buffer = Buffer.from(base64, 'base64');

    // Upload to Supabase Storage (bucket must exist + be public)
    const { error: uploadError } = await supa.storage
      .from('driver-site-photos')
      .upload(filePath, buffer, {
        contentType: mimeType || 'image/jpeg',
        upsert: true,
      });

    if (uploadError) {
      console.error('[Photo Upload] Storage error:', uploadError.message);
      return res.status(500).json({ error: uploadError.message });
    }

    // Get public URL
    const { data: urlData } = supa.storage.from('driver-site-photos').getPublicUrl(filePath);

    const publicUrl = urlData?.publicUrl;
    console.log('[Photo Upload] ✅ Uploaded:', publicUrl);

    // Also update driver_sites if the driver already has a site
    const { data: site } = await supa
      .from('driver_sites')
      .select('id')
      .eq('driver_id', driverId)
      .single();

    if (site) {
      await supa
        .from('driver_sites')
        .update({ photo_url: publicUrl, updated_at: new Date().toISOString() })
        .eq('id', site.id);
      console.log('[Photo Upload] ✅ Updated driver_sites.photo_url for site', site.id);
    }

    return res.json({ success: true, publicUrl });
  } catch (err: any) {
    console.error('[Photo Upload] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/driver-site/create-payment-intent — PaymentIntent pour réservation ──
app.post('/api/driver-site/create-payment-intent', async (req: any, res: any) => {
  const { slug, amount, pickup_address, destination, booking_date, booking_time } = req.body || {};
  if (!slug || !amount || amount < 5) {
    return res.status(400).json({ error: 'slug + amount (min 5€) requis' });
  }
  try {
    const supa = await getSupabaseAdmin();
    const { data: site } = await supa
      .from('driver_sites')
      .select('id,display_name,stripe_account_id,stripe_charges_enabled,commission_percent')
      .eq('slug', slug)
      .eq('is_active', true)
      .single();
    if (!site) return res.status(404).json({ error: 'Site introuvable' });
    if (!site.stripe_account_id || !site.stripe_charges_enabled) {
      return res
        .status(400)
        .json({ error: 'Chauffeur non connecté à Stripe', code: 'stripe_not_connected' });
    }

    const stripe = await getStripe();
    const amountCents = Math.round(amount * 100);
    // v1.10.50 — Commission par chauffeur via driver_sites.commission_percent (default 0%).
    const commissionPercent = Number(site.commission_percent ?? 0);
    const platformFeeCents = Math.round(amountCents * (commissionPercent / 100));

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'eur',
      application_fee_amount: platformFeeCents,
      transfer_data: { destination: site.stripe_account_id },
      metadata: {
        driver_site_id: site.id,
        slug,
        type: 'booking',
        pickup: pickup_address || '',
        dest: destination || '',
        date: booking_date || '',
        time: booking_time || '',
        commission_percent: String(commissionPercent),
      },
      description: `Course ${site.display_name} — ${pickup_address || 'départ'} → ${destination || 'arrivée'}`,
    });

    return res.json({
      client_secret: paymentIntent.client_secret,
      payment_intent_id: paymentIntent.id,
      amount: amount,
      platform_fee: platformFeeCents / 100,
      driver_net: (amountCents - platformFeeCents) / 100,
    });
  } catch (err: any) {
    console.error('[DriverSite] create-payment-intent error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/driver-site/booking — Réservation passager (2 étapes) ──
app.post('/api/driver-site/booking', async (req: any, res: any) => {
  const {
    slug,
    service_type,
    pickup_address,
    booking_date,
    booking_time,
    passenger_name,
    passenger_phone,
    passenger_email,
    notes,
    source,
    destination,
    estimated_fare,
    payment_intent_id,
  } = req.body || {};

  if (!slug || !passenger_name || !passenger_phone) {
    return res.status(400).json({ error: 'slug + nom + téléphone requis' });
  }

  try {
    const supa = await getSupabaseAdmin();
    const { data: site } = await supa
      .from('driver_sites')
      .select('id,display_name')
      .eq('slug', slug)
      .eq('is_active', true)
      .single();

    if (!site) return res.status(404).json({ error: 'Site introuvable' });

    const bookingData: Record<string, any> = {
      driver_site_id: site.id,
      slug,
      service_type: service_type || 'transfer',
      pickup_address: pickup_address || null,
      booking_date: booking_date || null,
      booking_time: booking_time || null,
      passenger_name,
      passenger_phone,
      passenger_email: passenger_email || null,
      notes: notes || null,
      source: source || 'web',
    };
    // Enriched fields (v3.0)
    if (destination) bookingData.destination = destination;
    if (estimated_fare) bookingData.estimated_fare = estimated_fare;
    if (payment_intent_id) bookingData.payment_intent_id = payment_intent_id;

    const { data, error } = await supa
      .from('driver_bookings')
      .insert(bookingData)
      .select()
      .single();

    if (error) throw new Error(error.message);

    // Track interaction
    await supa.from('driver_site_interactions').insert({
      driver_site_id: site.id,
      interaction_type: 'booking',
      passenger_name,
      scan_source: source || 'web',
    });

    return res.json({ success: true, booking_id: data.id });
  } catch (err: any) {
    console.error('[DriverSite] booking error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/driver-site/view/:slug — Track view ─────────────
app.post('/api/driver-site/view/:slug', async (req: any, res: any) => {
  const { slug } = req.params;
  const { source } = req.body || {};
  try {
    const supa = await getSupabaseAdmin();
    const { data: site } = await supa.from('driver_sites').select('id').eq('slug', slug).single();
    if (!site) return res.json({ ok: false });
    await Promise.all([
      supa
        .from('driver_sites')
        .update({ view_count: supa.rpc('increment', { x: 1 }) })
        .eq('id', site.id),
      supa.from('driver_site_interactions').insert({
        driver_site_id: site.id,
        interaction_type: 'view',
        scan_source: source || 'link',
      }),
    ]);
    return res.json({ ok: true });
  } catch {
    return res.json({ ok: false });
  }
});

// ── POST /api/driver-site/connect/onboard — Stripe Connect Express ──
app.post('/api/driver-site/connect/onboard', async (req: any, res: any) => {
  const { driver_id, driver_email, slug } = req.body || {};
  if (!driver_id || !slug) return res.status(400).json({ error: 'driver_id + slug requis' });
  try {
    const stripe = await getStripe();
    const supa = await getSupabaseAdmin();
    const { data: site } = await supa
      .from('driver_sites')
      .select('stripe_account_id')
      .eq('driver_id', driver_id)
      .single();
    let accountId = site?.stripe_account_id;
    // Créer le compte Express si inexistant
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: 'express',
        country: 'FR',
        email: driver_email || undefined,
        capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
        metadata: { driver_id, foreas_slug: slug },
      });
      accountId = account.id;
      await supa
        .from('driver_sites')
        .update({ stripe_account_id: accountId })
        .eq('driver_id', driver_id);
    }
    // Générer le lien d'onboarding
    const backendUrl =
      process.env.BACKEND_URL || 'https://foreas-stripe-backend-production.up.railway.app';
    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${backendUrl}/api/driver-site/connect/onboard`,
      return_url: `${backendUrl}/c/${slug}?onboard=success`,
      type: 'account_onboarding',
    });
    return res.json({ onboarding_url: accountLink.url, account_id: accountId });
  } catch (err: any) {
    console.error(
      '[DriverSite] connect error:',
      err.message,
      err.type || '',
      err.code || '',
      err.statusCode || '',
    );
    console.error('[DriverSite] connect stack:', err.stack?.substring(0, 500));
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/driver-site/connect/status/:driverId — Vérifie si Stripe Connect est actif ──
app.get('/api/driver-site/connect/status/:driverId', async (req: any, res: any) => {
  const { driverId } = req.params;
  try {
    const supa = await getSupabaseAdmin();
    const { data: site } = await supa
      .from('driver_sites')
      .select('stripe_account_id,stripe_onboarded,stripe_charges_enabled')
      .eq('driver_id', driverId)
      .single();
    if (!site?.stripe_account_id) return res.json({ connected: false });
    // Vérifier via Stripe
    const stripe = await getStripe();
    const account = await stripe.accounts.retrieve(site.stripe_account_id);
    const chargesEnabled = account.charges_enabled;
    if (chargesEnabled !== site.stripe_charges_enabled) {
      await supa
        .from('driver_sites')
        .update({ stripe_charges_enabled: chargesEnabled, stripe_onboarded: true })
        .eq('driver_id', driverId);
    }
    return res.json({
      connected: true,
      charges_enabled: chargesEnabled,
      account_id: site.stripe_account_id,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ============================================
// DEBUG ROUTES (dev only)
// ============================================
if (process.env.NODE_ENV !== 'production') {
  app.get('/__routes', (_req, res) => {
    const stack = (app as any)._router?.stack || [];
    const routes = stack
      .filter((l: any) => l.route)
      .map((l: any) => ({ methods: l.route.methods, path: l.route.path }));
    res.json(routes);
  });
}

// ============================================
// SERVER START
// ============================================
const server = app.listen(PORT, HOST, () => {
  console.log(`[FOREAS] Backend v${VERSION} (${GIT_SHA.substring(0, 7)})`);
  console.log(`[FOREAS] Listening on ${HOST}:${PORT}`);
  console.log(`[FOREAS] Health: http://localhost:${PORT}/health`);
});
