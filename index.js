const express = require('express');
const bodyParser = require('body-parser');
const app = express();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// AI Proxy Configuration
const AI_BACKEND = process.env.AI_BACKEND_URL || 'https://foreas-ai-backend-production.up.railway.app';
const SERVICE_KEY = process.env.FOREAS_SERVICE_KEY;

if (!SERVICE_KEY) {
  console.error('[AI-PROXY] ❌ FOREAS_SERVICE_KEY manquante!');
} else {
  console.log('[AI-PROXY] ✅ Service key configurée');
}

app.use(
  '/api/webhooks/stripe',
  bodyParser.raw({ type: 'application/json' })
);

app.post('/api/webhooks/stripe', (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('⚠️  Erreur de vérification webhook:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'payment_intent.succeeded') {
    const paymentIntent = event.data.object;
    console.log('Paiement réussi', paymentIntent.id);
  }

  res.json({ received: true });
});

app.get('/', (req, res) => {
  res.send('FOREAS Stripe Backend is running');
});

app.get('/health', (req, res) => {
  res.send('OK');
});

// ============================================
// AI PROXY ROUTES - App Mobile → AI Backend
// ============================================
app.use(express.json());

// POST /api/ai/chat
app.post('/api/ai/chat', async (req, res) => {
  console.log('[AI-PROXY] 📨 /chat request');
  if (!SERVICE_KEY) {
    return res.status(500).json({ error: 'FOREAS_SERVICE_KEY not configured' });
  }
  try {
    const response = await fetch(`${AI_BACKEND}/api/ajnaya/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-FOREAS-SERVICE-KEY': SERVICE_KEY
      },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    console.log('[AI-PROXY] ✅ Chat response:', response.status);
    return res.status(response.status).json(data);
  } catch (err) {
    console.error('[AI-PROXY] ❌ Chat error:', err.message);
    return res.status(500).json({ error: 'AI proxy error', message: err.message });
  }
});

// POST /api/ai/transcribe
app.post('/api/ai/transcribe', async (req, res) => {
  console.log('[AI-PROXY] 📨 /transcribe request');
  if (!SERVICE_KEY) {
    return res.status(500).json({ error: 'FOREAS_SERVICE_KEY not configured' });
  }
  try {
    const response = await fetch(`${AI_BACKEND}/api/ajnaya/transcribe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-FOREAS-SERVICE-KEY': SERVICE_KEY
      },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    console.log('[AI-PROXY] ✅ Transcribe response:', response.status);
    return res.status(response.status).json(data);
  } catch (err) {
    console.error('[AI-PROXY] ❌ Transcribe error:', err.message);
    return res.status(500).json({ error: 'AI proxy error', message: err.message });
  }
});

// POST /api/ai/tts
app.post('/api/ai/tts', async (req, res) => {
  console.log('[AI-PROXY] 📨 /tts request');
  if (!SERVICE_KEY) {
    return res.status(500).json({ error: 'FOREAS_SERVICE_KEY not configured' });
  }
  try {
    const response = await fetch(`${AI_BACKEND}/api/ajnaya/tts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-FOREAS-SERVICE-KEY': SERVICE_KEY
      },
      body: JSON.stringify(req.body)
    });
    if (!response.ok) {
      try {
        const errorData = await response.json();
        return res.status(response.status).json(errorData);
      } catch {
        const errorText = await response.text();
        return res.status(response.status).json({ error: errorText });
      }
    }
    const buffer = await response.arrayBuffer();
    console.log('[AI-PROXY] ✅ TTS audio size:', buffer.byteLength);
    res.set('Content-Type', 'audio/mpeg');
    return res.status(response.status).send(Buffer.from(buffer));
  } catch (err) {
    console.error('[AI-PROXY] ❌ TTS error:', err.message);
    return res.status(500).json({ error: 'AI proxy error', message: err.message });
  }
});

// GET /api/ai/health
app.get('/api/ai/health', async (req, res) => {
  try {
    const response = await fetch(`${AI_BACKEND}/health`);
    const data = await response.json();
    return res.json({
      proxy: 'ok',
      aiBackend: data,
      serviceKeyConfigured: !!SERVICE_KEY
    });
  } catch (err) {
    return res.status(503).json({
      proxy: 'ok',
      aiBackend: 'unreachable',
      error: err.message
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur en écoute sur le port ${PORT}`));