import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';
import { otpRouter } from './routes/otp.routes';

const app = express();
app.use(cors());

// ⚠️ Webhook Stripe: utiliser express.raw, et surtout AVANT express.json()
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
  apiVersion: '2024-06-20',
});

// Health-check simple
app.get('/health', (_req, res) => res.status(200).send('OK'));
app.get('/', (_req, res) => res.send('FOREAS Stripe Backend is running'));

// Webhook (route EXACTE)
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'] as string | undefined;
  const whSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!sig || !whSecret) return res.status(400).send('Missing signature or secret');

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, whSecret);
  } catch (err: any) {
    console.error('❌ Stripe signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

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
});

// Les autres routes peuvent être en JSON APRES le webhook Stripe
app.use(express.json());

// Cache mémoire pour l'état premium (démo)
let lastPremium = 0;
function markPremiumNow() {
  lastPremium = Date.now();
}

// =====================================
// OTP Routes v2 - Production-grade
// =====================================
app.use('/api/auth', otpRouter);

app.post('/create-checkout-session', async (_req, res) => {
  try {
    const priceId = process.env.STRIPE_PRICE_ID;
    if (!priceId) return res.status(400).json({ error: 'Missing STRIPE_PRICE_ID' });

    const session = await stripe.checkout.sessions.create({
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
app.listen(PORT, () => {
  console.log(`🚀 FOREAS backend listening on ${PORT}`);
  console.log(`🔐 OTP Endpoints:`);
  console.log(`   POST /api/auth/send-otp`);
  console.log(`   POST /api/auth/verify-otp`);
  console.log(`   POST /api/auth/finalize-signup`);
  console.log(`   GET  /api/auth/otp/status`);
});
