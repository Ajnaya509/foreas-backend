const express = require('express');
const bodyParser = require('body-parser');
const multer = require('multer');
const FormData = require('form-data');
const app = express();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Multer pour traiter les fichiers audio (stockage en mémoire)
const upload = multer({ storage: multer.memoryStorage() });

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

// POST /api/ai/chat (doit être avant express.json global)
app.post('/api/ai/chat', express.json(), async (req, res) => {
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

// POST /api/ai/transcribe - UNIQUEMENT multipart/form-data
app.post('/api/ai/transcribe', upload.single('audio'), async (req, res) => {
  const ct = req.headers['content-type'] || 'unknown';
  console.log('[AI-PROXY][TRANSCRIBE] ct=', ct);
  console.log('[AI-PROXY][TRANSCRIBE] req.file=', !!req.file);
  console.log('[AI-PROXY][TRANSCRIBE] req.body keys=', Object.keys(req.body || {}));

  if (!SERVICE_KEY) {
    return res.status(500).json({ error: 'FOREAS_SERVICE_KEY not configured' });
  }

  // OBLIGATOIRE: fichier audio requis
  if (!req.file) {
    console.log('[AI-PROXY][TRANSCRIBE] ❌ NO FILE received by Stripe backend');
    return res.status(400).json({
      error: 'missing_audio',
      message: 'No audio field received by Stripe backend. Use multipart/form-data with field "audio".',
      contentType: ct,
      receivedFields: Object.keys(req.body || {}),
    });
  }

  const filename = req.body?.filename || req.file.originalname || 'audio.m4a';
  const format = req.body?.format || req.file.mimetype || 'audio/m4a';

  console.log('[AI-PROXY][TRANSCRIBE] 📎 File received:', {
    originalname: req.file.originalname,
    mimetype: req.file.mimetype,
    size: req.file.size,
    filename,
    format
  });

  try {
    // Créer FormData pour le AI backend
    const fd = new FormData();
    fd.append('audio', req.file.buffer, {
      filename: filename,
      contentType: req.file.mimetype || 'audio/mp4'
    });
    fd.append('filename', filename);
    fd.append('format', format);
    if (req.body.language) fd.append('language', req.body.language);

    const headers = {
      ...fd.getHeaders(),
      'X-FOREAS-SERVICE-KEY': SERVICE_KEY,
    };

    console.log('[AI-PROXY][TRANSCRIBE] 📤 Forwarding to AI backend...');

    const response = await fetch(`${AI_BACKEND}/api/ajnaya/transcribe`, {
      method: 'POST',
      headers,
      body: fd,
    });

    const text = await response.text();
    console.log('[AI-PROXY][TRANSCRIBE] status=', response.status, 'body=', text.slice(0, 800));

    // Parse JSON si possible
    try {
      const json = JSON.parse(text);
      return res.status(response.status).json(json);
    } catch {
      return res.status(response.status).type('text/plain').send(text);
    }
  } catch (e) {
    console.error('[AI-PROXY][TRANSCRIBE] ❌ Exception:', e);
    return res.status(500).json({ error: 'proxy_error', message: String(e?.message || e) });
  }
});

// POST /api/ai/tts
app.post('/api/ai/tts', express.json(), async (req, res) => {
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
      serviceKeyConfigured: !!SERVICE_KEY,
      version: '2.0.0-multipart'
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
