import 'dotenv/config';
import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());

// ============================================
// FAST BOOT: Health check AVANT tout import lourd
// ============================================
const startTime = Date.now();
app.get('/health', (_req, res) => {
  const uptime = Date.now() - startTime;
  res.status(200).json({ status: 'ok', uptime_ms: uptime, version: '2.1.0' });
});
app.get('/', (_req, res) => res.send('FOREAS Stripe Backend is running'));

// ============================================
// LAZY INIT: Stripe chargé après health ready
// ============================================
let stripe: import('stripe').default | null = null;
async function getStripe() {
  if (!stripe) {
    const Stripe = (await import('stripe')).default;
    stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
      apiVersion: '2024-06-20',
    });
  }
  return stripe;
}

// Webhook (route EXACTE) - async pour lazy Stripe
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'] as string | undefined;
  const whSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!sig || !whSecret) return res.status(400).send('Missing signature or secret');

  try {
    const stripeClient = await getStripe();
    const event = stripeClient.webhooks.constructEvent(req.body, sig, whSecret);

    switch (event.type) {
      case 'checkout.session.completed':
      case 'payment_intent.succeeded':
      case 'invoice.payment_succeeded':
        console.log('✅ Stripe event:', event.type);
        markPremiumNow();
        break;
      default:
        console.log('ℹ️ Unhandled Stripe event:', event.type);
    }
    res.json({ received: true });
  } catch (err: any) {
    console.error('❌ Stripe webhook error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

// Les autres routes peuvent être en JSON APRES le webhook Stripe
app.use(express.json());

// Cache mémoire pour l'état premium (démo)
let lastPremium = 0;
function markPremiumNow() {
  lastPremium = Date.now();
}

// =====================================
// OTP Routes v2 - Production-grade (lazy loaded)
// =====================================
// Import dynamique pour éviter le chargement de @supabase/supabase-js au démarrage
import('./routes/otp.routes.js').then(({ otpRouter }) => {
  app.use('/api/auth', otpRouter);
  console.log('[OTP] Routes mounted at /api/auth');
}).catch(err => {
  console.error('[OTP] Failed to load OTP routes:', err.message);
});

app.post('/create-checkout-session', async (_req, res) => {
  try {
    const priceId = process.env.STRIPE_PRICE_ID;
    if (!priceId) return res.status(400).json({ error: 'Missing STRIPE_PRICE_ID' });

    const stripeClient = await getStripe();
    const session = await stripeClient.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: 'https://example.com/success',
      cancel_url: 'https://example.com/cancel'
    });

    res.json({ url: session.url });
  } catch (e: any) {
    console.error('❌ create-checkout-session error:', e.message);
    res.status(400).json({ error: e.message });
  }
});

// GET /subscription/status - Vérifier l'état premium
app.get('/subscription/status', (_req, res) => {
  const active = (Date.now() - lastPremium) < 1000 * 60 * 30; // "actif" 30 minutes après un paiement test
  res.json({ active });
});

// (option debug) lister les routes connues pour vérifier le montage
app.get('/__routes', (_req, res) => {
  // @ts-ignore
  const stack = (app as any)._router?.stack || [];
  const routes = stack
    .filter((l: any) => l.route)
    .map((l: any) => ({ methods: l.route.methods, path: l.route.path }));
  res.json(routes);
});

const PORT = process.env.PORT || 8080;
const HOST = '0.0.0.0'; // Railway requires binding to 0.0.0.0

app.listen(Number(PORT), HOST, () => {
  console.log(`🚀 FOREAS backend listening on ${HOST}:${PORT}`);
  console.log(`🔐 OTP Endpoints:`);
  console.log(`   POST /api/auth/send-otp`);
  console.log(`   POST /api/auth/verify-otp`);
  console.log(`   POST /api/auth/finalize-signup`);
  console.log(`   GET  /api/auth/otp/status`);
});
