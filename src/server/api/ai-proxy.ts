/**
 * AI Proxy Routes - FOREAS Stripe Backend
 *
 * Proxy les requêtes de l'app mobile vers le backend AI.
 * La clé de service FOREAS_SERVICE_KEY reste côté serveur.
 *
 * Architecture:
 *   App Mobile (JWT) → Stripe Backend (/api/ai/*) → AI Backend
 */

import { Router, Request, Response } from 'express';
import { env } from '@/env';

const router = Router();

// Configuration
const AI_BACKEND = env.AI_BACKEND_URL || 'https://foreas-ai-backend-production.up.railway.app';
const SERVICE_KEY = env.FOREAS_SERVICE_KEY;

// Vérification au démarrage
if (!SERVICE_KEY) {
  console.error('[AI-PROXY] ❌ FOREAS_SERVICE_KEY manquante!');
} else {
  console.log('[AI-PROXY] ✅ Service key configurée');
}

/**
 * POST /api/ai/chat
 * Proxy vers AI Backend /api/ajnaya/chat
 */
router.post('/chat', async (req: Request, res: Response) => {
  console.log('[AI-PROXY] 📨 /chat request');

  if (!SERVICE_KEY) {
    return res.status(500).json({
      error: 'Service configuration error',
      message: 'FOREAS_SERVICE_KEY not configured'
    });
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
  } catch (err: any) {
    console.error('[AI-PROXY] ❌ Chat error:', err.message);
    return res.status(500).json({ error: 'AI proxy error', message: err.message });
  }
});

/**
 * POST /api/ai/transcribe
 * Proxy vers AI Backend /api/ajnaya/transcribe
 */
router.post('/transcribe', async (req: Request, res: Response) => {
  console.log('[AI-PROXY] 📨 /transcribe request');

  if (!SERVICE_KEY) {
    return res.status(500).json({
      error: 'Service configuration error',
      message: 'FOREAS_SERVICE_KEY not configured'
    });
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
  } catch (err: any) {
    console.error('[AI-PROXY] ❌ Transcribe error:', err.message);
    return res.status(500).json({ error: 'AI proxy error', message: err.message });
  }
});

/**
 * POST /api/ai/tts
 * Proxy vers AI Backend /api/ajnaya/tts
 * Retourne audio/mpeg
 */
router.post('/tts', async (req: Request, res: Response) => {
  console.log('[AI-PROXY] 📨 /tts request');

  if (!SERVICE_KEY) {
    return res.status(500).json({
      error: 'Service configuration error',
      message: 'FOREAS_SERVICE_KEY not configured'
    });
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
  } catch (err: any) {
    console.error('[AI-PROXY] ❌ TTS error:', err.message);
    return res.status(500).json({ error: 'AI proxy error', message: err.message });
  }
});

/**
 * GET /api/ai/health
 * Health check
 */
router.get('/health', async (req: Request, res: Response) => {
  try {
    const response = await fetch(`${AI_BACKEND}/health`);
    const data = await response.json();
    return res.json({
      proxy: 'ok',
      aiBackend: data,
      serviceKeyConfigured: !!SERVICE_KEY
    });
  } catch (err: any) {
    return res.status(503).json({
      proxy: 'ok',
      aiBackend: 'unreachable',
      error: err.message
    });
  }
});

export const aiProxyRouter = router;
