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
  });
});

app.get('/', (_req, res) => {
  res.send(`FOREAS Backend v${VERSION} (${GIT_SHA.substring(0, 7)})`);
});

// ============================================
// LAZY STRIPE - Chargé au premier usage
// ============================================
let stripeClient: import('stripe').default | null = null;

async function getStripe(): Promise<import('stripe').default> {
  if (!stripeClient) {
    const Stripe = (await import('stripe')).default;
    stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
      apiVersion: '2024-06-20',
    });
    console.log('[Stripe] Client initialized');
  }
  return stripeClient;
}

// ============================================
// STRIPE WEBHOOK - AVANT express.json()
// ============================================
app.post(
  '/api/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'] as string | undefined;
    const whSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!sig || !whSecret) {
      return res.status(400).send('Missing signature or secret');
    }

    try {
      const stripe = await getStripe();
      const event = stripe.webhooks.constructEvent(req.body, sig, whSecret);

      switch (event.type) {
        case 'checkout.session.completed':
        case 'payment_intent.succeeded':
        case 'invoice.payment_succeeded':
          console.log(`[Stripe] Event: ${event.type}`);
          markPremiumNow();
          break;
        default:
          console.log(`[Stripe] Unhandled: ${event.type}`);
      }

      res.json({ received: true });
    } catch (err: any) {
      console.error(`[Stripe] Webhook error: ${err.message}`);
      res.status(400).send(`Webhook Error: ${err.message}`);
    }
  }
);

// ============================================
// JSON PARSER - APRÈS webhook Stripe
// ============================================
app.use(express.json());

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

// Charger OTP routes immédiatement après listen
// mais APRÈS que le serveur soit prêt
setTimeout(() => loadOtpRoutes(), 0);

// ============================================
// STRIPE CHECKOUT
// ============================================
app.post('/create-checkout-session', async (_req, res) => {
  try {
    const priceId = process.env.STRIPE_PRICE_ID;
    if (!priceId) {
      return res.status(400).json({ error: 'Missing STRIPE_PRICE_ID' });
    }

    const stripe = await getStripe();
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: 'https://foreas.app/success',
      cancel_url: 'https://foreas.app/cancel',
    });

    res.json({ url: session.url });
  } catch (e: any) {
    console.error(`[Checkout] Error: ${e.message}`);
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
app.listen(PORT, HOST, () => {
  console.log(`[FOREAS] Backend v${VERSION} (${GIT_SHA.substring(0, 7)})`);
  console.log(`[FOREAS] Listening on ${HOST}:${PORT}`);
  console.log(`[FOREAS] Health: http://localhost:${PORT}/health`);
});
