/**
 * FOREAS Data Platform V1 - AI API Routes
 * ========================================
 * Endpoints for AI services + Ajnaya Voice Proxy.
 *
 * Architecture:
 *   App Mobile (JWT optionnel) → Stripe Backend (/api/ai/*) → AI Backend
 *   Toutes les clés API restent côté serveur.
 */

import { Router, Request, Response } from 'express';
import multer from 'multer';
import {
  processAIRequest,
  getQuickRecommendation,
  completeConversation,
} from '../ai/aiService';
import { getDriverContext, refreshDriverFeatures } from '../data/featureStore';
import { getDriverOutcomes, getOutcomeStats, addOutcomeFeedback } from '../data/outcomes';
import { getDriverConversations, getDriverConversationStats } from '../data/conversationLog';
import {
  authenticateUser,
  requireAuth,
  requireOwnership,
  requireConsent,
  AuthenticatedRequest,
} from '../middleware/rbac';
import { trackEventAsync } from '../data/eventStore';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// ============================================
// AI BACKEND PROXY CONFIG
// ============================================
const AI_BACKEND = process.env.AI_BACKEND_URL || 'https://foreas-ai-backend-production.up.railway.app';
const SERVICE_KEY = process.env.FOREAS_SERVICE_KEY;

if (!SERVICE_KEY) {
  console.error('[AI-PROXY] ❌ FOREAS_SERVICE_KEY manquante — les routes Ajnaya proxy ne fonctionneront pas');
} else {
  console.log('[AI-PROXY] ✅ Service key configurée, proxy actif vers', AI_BACKEND);
}

// Apply authentication to all routes (SOFT: ne rejette pas si pas de token)
router.use(authenticateUser);

// ============================================
// AJNAYA VOICE PROXY ROUTES
// Pas de requireAuth → fonctionne avec ou sans JWT
// Les clés API (OpenAI, ElevenLabs) restent sur le AI Backend
// ============================================

/**
 * POST /api/ai/transcribe
 * Proxy vers AI Backend Whisper STT
 * Accepte: multipart/form-data (audio file) ou JSON (base64 audio)
 */
router.post('/transcribe', upload.single('audio'), async (req: Request, res: Response) => {
  console.log('[AI-PROXY] 📨 /transcribe request');

  if (!SERVICE_KEY) {
    return res.status(500).json({ error: 'AI proxy not configured', message: 'FOREAS_SERVICE_KEY missing' });
  }

  try {
    let proxyRes: globalThis.Response;

    if (req.file) {
      // Multipart: forward audio file as base64
      const audioBase64 = req.file.buffer.toString('base64');
      const mimeType = req.file.mimetype || 'audio/m4a';

      proxyRes = await fetch(`${AI_BACKEND}/api/ajnaya/transcribe`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-FOREAS-SERVICE-KEY': SERVICE_KEY,
        },
        body: JSON.stringify({
          audio: audioBase64,
          mimeType,
          language: (req.body as any)?.language || 'fr',
        }),
      });
    } else {
      // JSON body (base64 audio or other format)
      proxyRes = await fetch(`${AI_BACKEND}/api/ajnaya/transcribe`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-FOREAS-SERVICE-KEY': SERVICE_KEY,
        },
        body: JSON.stringify(req.body),
      });
    }

    const data = await proxyRes.json();
    console.log('[AI-PROXY] ✅ Transcribe response:', proxyRes.status);
    return res.status(proxyRes.status).json(data);
  } catch (err: any) {
    console.error('[AI-PROXY] ❌ Transcribe error:', err.message);
    return res.status(500).json({ error: 'AI proxy error', message: err.message });
  }
});

/**
 * POST /api/ai/chat
 * Smart routing:
 *   - Si body contient "text" → proxy Ajnaya (voice chat simplifié)
 *   - Si body contient "message" + auth → Data Platform AI (full pipeline)
 */
router.post('/chat', async (req: AuthenticatedRequest, res: Response) => {
  const { text, message } = req.body;

  // ── Ajnaya Voice Chat Proxy (champ "text") ──
  if (text && typeof text === 'string') {
    console.log('[AI-PROXY] 📨 /chat (Ajnaya proxy) text:', text.substring(0, 50));

    if (!SERVICE_KEY) {
      return res.status(500).json({ error: 'AI proxy not configured' });
    }

    try {
      const proxyRes = await fetch(`${AI_BACKEND}/api/ajnaya/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-FOREAS-SERVICE-KEY': SERVICE_KEY,
        },
        body: JSON.stringify({
          text,
          context: req.body.context || {},
          history: req.body.history || [],
          driverId: req.userId || undefined,
        }),
      });

      const data = await proxyRes.json();
      console.log('[AI-PROXY] ✅ Chat response:', proxyRes.status);
      return res.status(proxyRes.status).json(data);
    } catch (err: any) {
      console.error('[AI-PROXY] ❌ Chat proxy error:', err.message);
      return res.status(500).json({ error: 'AI proxy error', message: err.message });
    }
  }

  // ── Data Platform AI (champ "message" + auth requise) ──
  if (!req.userId) {
    return res.status(401).json({ error: 'Authentication required for Data Platform AI' });
  }

  try {
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Message or text is required' });
    }

    const { conversationId, contextType, sessionId, useRAG, temperature, model } = req.body;

    const result = await processAIRequest({
      driverId: req.userId!,
      message,
      conversationId,
      contextType,
      sessionId: sessionId || req.sessionId,
      useRAG,
      temperature,
      model,
    });

    res.json(result);
  } catch (err: any) {
    console.error('[AI Routes] Chat error:', err);
    res.status(500).json({ error: 'AI service error', details: err.message });
  }
});

/**
 * POST /api/ai/tts
 * Proxy vers AI Backend ElevenLabs TTS
 * Retourne audio/mpeg
 */
router.post('/tts', async (req: Request, res: Response) => {
  console.log('[AI-PROXY] 📨 /tts request');

  if (!SERVICE_KEY) {
    return res.status(500).json({ error: 'AI proxy not configured', message: 'FOREAS_SERVICE_KEY missing' });
  }

  try {
    const proxyRes = await fetch(`${AI_BACKEND}/api/ajnaya/tts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-FOREAS-SERVICE-KEY': SERVICE_KEY,
      },
      body: JSON.stringify(req.body),
    });

    if (!proxyRes.ok) {
      try {
        const errorData = await proxyRes.json();
        return res.status(proxyRes.status).json(errorData);
      } catch {
        const errorText = await proxyRes.text();
        return res.status(proxyRes.status).json({ error: errorText });
      }
    }

    // Stream audio back
    const buffer = await proxyRes.arrayBuffer();
    console.log('[AI-PROXY] ✅ TTS audio size:', buffer.byteLength);
    res.set('Content-Type', 'audio/mpeg');
    return res.status(200).send(Buffer.from(buffer));
  } catch (err: any) {
    console.error('[AI-PROXY] ❌ TTS error:', err.message);
    return res.status(500).json({ error: 'AI proxy error', message: err.message });
  }
});

/**
 * POST /api/ai/quick
 * Quick recommendation (no conversation tracking)
 */
router.post('/quick', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { query } = req.body;

    if (!query || typeof query !== 'string') {
      return res.status(400).json({ error: 'Query is required' });
    }

    const result = await getQuickRecommendation(req.userId!, query);

    res.json(result);
  } catch (err: any) {
    console.error('[AI Routes] Quick recommendation error:', err);
    res.status(500).json({ error: 'AI service error', details: err.message });
  }
});

/**
 * POST /api/ai/conversations/:id/complete
 * Complete a conversation and optionally record outcome
 */
router.post(
  '/conversations/:id/complete',
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { id } = req.params;
      const { actionRecommended, actionTaken, outcomeType } = req.body;

      await completeConversation(id, {
        actionRecommended,
        actionTaken,
        outcomeType,
      });

      res.json({ success: true });
    } catch (err: any) {
      console.error('[AI Routes] Complete conversation error:', err);
      res.status(500).json({ error: 'Failed to complete conversation' });
    }
  }
);

// ============================================
// DRIVER CONTEXT ENDPOINTS
// ============================================

/**
 * GET /api/ai/context
 * Get current driver's AI context
 */
router.get('/context', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const context = await getDriverContext(req.userId!);
    res.json(context);
  } catch (err: any) {
    console.error('[AI Routes] Get context error:', err);
    res.status(500).json({ error: 'Failed to get context' });
  }
});

/**
 * POST /api/ai/context/refresh
 * Force refresh driver features
 */
router.post(
  '/context/refresh',
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { snapshotType } = req.body;
      const snapshot = await refreshDriverFeatures(req.userId!, snapshotType || 'manual');

      trackEventAsync({
        eventName: 'features.refreshed',
        eventCategory: 'recommendation',
        actorId: req.userId,
        actorRole: 'driver',
        payload: { snapshot_type: snapshotType || 'manual' },
      });

      res.json(snapshot);
    } catch (err: any) {
      console.error('[AI Routes] Refresh context error:', err);
      res.status(500).json({ error: 'Failed to refresh context' });
    }
  }
);

// ============================================
// CONVERSATION HISTORY
// ============================================

/**
 * GET /api/ai/conversations
 * Get current driver's conversations
 */
router.get(
  '/conversations',
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { limit, status } = req.query;

      const conversations = await getDriverConversations(req.userId!, {
        limit: limit ? parseInt(limit as string, 10) : 20,
        status: status as any,
      });

      res.json(conversations);
    } catch (err: any) {
      console.error('[AI Routes] Get conversations error:', err);
      res.status(500).json({ error: 'Failed to get conversations' });
    }
  }
);

/**
 * GET /api/ai/conversations/stats
 * Get conversation statistics
 */
router.get(
  '/conversations/stats',
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const stats = await getDriverConversationStats(req.userId!);
      res.json(stats);
    } catch (err: any) {
      console.error('[AI Routes] Get conversation stats error:', err);
      res.status(500).json({ error: 'Failed to get stats' });
    }
  }
);

// ============================================
// OUTCOMES & FEEDBACK
// ============================================

/**
 * GET /api/ai/outcomes
 * Get current driver's recommendation outcomes
 */
router.get('/outcomes', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { limit } = req.query;
    const outcomes = await getDriverOutcomes(
      req.userId!,
      limit ? parseInt(limit as string, 10) : 20
    );
    res.json(outcomes);
  } catch (err: any) {
    console.error('[AI Routes] Get outcomes error:', err);
    res.status(500).json({ error: 'Failed to get outcomes' });
  }
});

/**
 * GET /api/ai/outcomes/stats
 * Get outcome statistics
 */
router.get(
  '/outcomes/stats',
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const stats = await getOutcomeStats(req.userId!);
      res.json(stats);
    } catch (err: any) {
      console.error('[AI Routes] Get outcome stats error:', err);
      res.status(500).json({ error: 'Failed to get stats' });
    }
  }
);

/**
 * POST /api/ai/outcomes/:id/feedback
 * Add feedback to an outcome
 */
router.post(
  '/outcomes/:id/feedback',
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { id } = req.params;
      const { feedback, feedbackText } = req.body;

      if (!feedback || !['helpful', 'not_helpful', 'neutral'].includes(feedback)) {
        return res.status(400).json({
          error: 'Valid feedback required (helpful, not_helpful, neutral)',
        });
      }

      await addOutcomeFeedback(id, feedback, feedbackText);

      trackEventAsync({
        eventName: 'outcome.feedback',
        eventCategory: 'recommendation',
        actorId: req.userId,
        actorRole: 'driver',
        payload: { outcome_id: id, feedback },
      });

      res.json({ success: true });
    } catch (err: any) {
      console.error('[AI Routes] Add feedback error:', err);
      res.status(500).json({ error: 'Failed to add feedback' });
    }
  }
);

// ============================================
// HEALTH CHECK
// ============================================

/**
 * GET /api/ai/health
 * AI service health check
 */
router.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'ai',
    timestamp: new Date().toISOString(),
  });
});

export { router as aiRouter };
