/**
 * FOREAS Data Platform V1 - AI API Routes
 * ========================================
 * Endpoints for AI services.
 */

import { Router, Response } from 'express';
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

// Apply authentication to all routes
router.use(authenticateUser);

// ============================================
// AI COMPLETION ENDPOINTS
// ============================================

/**
 * POST /api/ai/chat
 * Main AI chat endpoint
 */
router.post(
  '/chat',
  requireAuth,
  requireConsent('ai_personalization'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { message, conversationId, contextType, sessionId, useRAG, temperature, model } =
        req.body;

      if (!message || typeof message !== 'string') {
        return res.status(400).json({ error: 'Message is required' });
      }

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
  }
);

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
