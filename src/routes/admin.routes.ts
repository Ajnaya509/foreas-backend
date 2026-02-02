/**
 * FOREAS Data Platform V1 - Admin API Routes
 * ===========================================
 * Admin-only endpoints for data management.
 */

import { Router, Response } from 'express';
import {
  authenticateUser,
  requireAdmin,
  requireSupport,
  AuthenticatedRequest,
} from '../middleware/rbac';
import { queryEvents, countEvents } from '../data/eventStore';
import { queryAuditLogs } from '../data/auditLog';
import { queryOutcomes } from '../data/outcomes';
import { listDocuments, indexDocument, deleteDocument } from '../ai/rag/indexer';
import { logAuditAsync, AUDIT_ACTIONS } from '../data/auditLog';
import { getSupabaseAdmin } from '../helpers/supabase';

const router = Router();

// Apply authentication to all routes
router.use(authenticateUser);

// ============================================
// EVENT ANALYTICS (Admin/Support)
// ============================================

/**
 * GET /api/admin/events
 * Query analytics events
 */
router.get(
  '/events',
  requireSupport,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const {
        actorId,
        eventName,
        eventCategory,
        startDate,
        endDate,
        limit,
        offset,
      } = req.query;

      const events = await queryEvents({
        actorId: actorId as string,
        eventName: eventName as string,
        eventCategory: eventCategory as any,
        startDate: startDate ? new Date(startDate as string) : undefined,
        endDate: endDate ? new Date(endDate as string) : undefined,
        limit: limit ? parseInt(limit as string, 10) : 50,
        offset: offset ? parseInt(offset as string, 10) : 0,
      });

      res.json(events);
    } catch (err: any) {
      console.error('[Admin Routes] Query events error:', err);
      res.status(500).json({ error: 'Failed to query events' });
    }
  }
);

/**
 * GET /api/admin/events/count
 * Count events by criteria
 */
router.get(
  '/events/count',
  requireSupport,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { actorId, eventName, eventCategory, startDate, endDate } = req.query;

      const count = await countEvents({
        actorId: actorId as string,
        eventName: eventName as string,
        eventCategory: eventCategory as any,
        startDate: startDate ? new Date(startDate as string) : undefined,
        endDate: endDate ? new Date(endDate as string) : undefined,
      });

      res.json({ count });
    } catch (err: any) {
      console.error('[Admin Routes] Count events error:', err);
      res.status(500).json({ error: 'Failed to count events' });
    }
  }
);

// ============================================
// AUDIT LOGS (Admin only)
// ============================================

/**
 * GET /api/admin/audit
 * Query audit logs
 */
router.get(
  '/audit',
  requireAdmin,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const {
        actorId,
        actorRole,
        action,
        targetType,
        targetId,
        startDate,
        endDate,
        limit,
        offset,
      } = req.query;

      const logs = await queryAuditLogs({
        actorId: actorId as string,
        actorRole: actorRole as any,
        action: action as string,
        targetType: targetType as string,
        targetId: targetId as string,
        startDate: startDate ? new Date(startDate as string) : undefined,
        endDate: endDate ? new Date(endDate as string) : undefined,
        limit: limit ? parseInt(limit as string, 10) : 50,
        offset: offset ? parseInt(offset as string, 10) : 0,
      });

      res.json(logs);
    } catch (err: any) {
      console.error('[Admin Routes] Query audit logs error:', err);
      res.status(500).json({ error: 'Failed to query audit logs' });
    }
  }
);

// ============================================
// OUTCOMES (Admin/Support)
// ============================================

/**
 * GET /api/admin/outcomes
 * Query all outcomes
 */
router.get(
  '/outcomes',
  requireSupport,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const {
        driverId,
        conversationId,
        outcomeType,
        startDate,
        endDate,
        limit,
        offset,
      } = req.query;

      const outcomes = await queryOutcomes({
        driverId: driverId as string,
        conversationId: conversationId as string,
        outcomeType: outcomeType as any,
        startDate: startDate ? new Date(startDate as string) : undefined,
        endDate: endDate ? new Date(endDate as string) : undefined,
        limit: limit ? parseInt(limit as string, 10) : 50,
        offset: offset ? parseInt(offset as string, 10) : 0,
      });

      res.json(outcomes);
    } catch (err: any) {
      console.error('[Admin Routes] Query outcomes error:', err);
      res.status(500).json({ error: 'Failed to query outcomes' });
    }
  }
);

// ============================================
// RAG DOCUMENTS (Admin only)
// ============================================

/**
 * GET /api/admin/documents
 * List RAG documents
 */
router.get(
  '/documents',
  requireAdmin,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { sourceType } = req.query;
      const documents = await listDocuments(sourceType as any);
      res.json(documents);
    } catch (err: any) {
      console.error('[Admin Routes] List documents error:', err);
      res.status(500).json({ error: 'Failed to list documents' });
    }
  }
);

/**
 * POST /api/admin/documents
 * Index new RAG document
 */
router.post(
  '/documents',
  requireAdmin,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { title, content, sourceType, metadata } = req.body;

      if (!title || !content || !sourceType) {
        return res.status(400).json({
          error: 'title, content, and sourceType are required',
        });
      }

      const document = await indexDocument({
        title,
        content,
        sourceType,
        metadata,
        createdBy: req.userId,
      });

      logAuditAsync({
        actorId: req.userId!,
        actorRole: 'admin',
        action: 'document.indexed',
        targetType: 'document',
        targetId: document.id,
        details: { title, source_type: sourceType },
      });

      res.status(201).json(document);
    } catch (err: any) {
      console.error('[Admin Routes] Index document error:', err);
      res.status(500).json({ error: 'Failed to index document' });
    }
  }
);

/**
 * DELETE /api/admin/documents/:id
 * Delete RAG document (soft delete)
 */
router.delete(
  '/documents/:id',
  requireAdmin,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { id } = req.params;

      await deleteDocument(id);

      logAuditAsync({
        actorId: req.userId!,
        actorRole: 'admin',
        action: 'document.deleted',
        targetType: 'document',
        targetId: id,
      });

      res.json({ success: true });
    } catch (err: any) {
      console.error('[Admin Routes] Delete document error:', err);
      res.status(500).json({ error: 'Failed to delete document' });
    }
  }
);

// ============================================
// USER MANAGEMENT (Admin only)
// ============================================

/**
 * GET /api/admin/users
 * List users with roles
 */
router.get(
  '/users',
  requireAdmin,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const supabase = getSupabaseAdmin();
      const { limit, offset, role } = req.query;

      let query = supabase
        .from('user_roles')
        .select('user_id, role, is_active, granted_at')
        .eq('is_active', true)
        .order('granted_at', { ascending: false });

      if (role) {
        query = query.eq('role', role);
      }

      if (limit) {
        query = query.limit(parseInt(limit as string, 10));
      }

      if (offset) {
        query = query.range(
          parseInt(offset as string, 10),
          parseInt(offset as string, 10) + parseInt((limit as string) || '50', 10) - 1
        );
      }

      const { data, error } = await query;

      if (error) {
        throw error;
      }

      res.json(data);
    } catch (err: any) {
      console.error('[Admin Routes] List users error:', err);
      res.status(500).json({ error: 'Failed to list users' });
    }
  }
);

/**
 * POST /api/admin/users/:userId/roles
 * Grant role to user
 */
router.post(
  '/users/:userId/roles',
  requireAdmin,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { userId } = req.params;
      const { role } = req.body;

      if (!role || !['driver', 'partner', 'support', 'admin'].includes(role)) {
        return res.status(400).json({ error: 'Valid role required' });
      }

      const supabase = getSupabaseAdmin();

      // Upsert role
      const { data, error } = await supabase
        .from('user_roles')
        .upsert(
          {
            user_id: userId,
            role,
            granted_by: req.userId,
            is_active: true,
          },
          { onConflict: 'user_id,role' }
        )
        .select()
        .single();

      if (error) {
        throw error;
      }

      logAuditAsync({
        actorId: req.userId!,
        actorRole: 'admin',
        action: AUDIT_ACTIONS.ROLE_GRANTED,
        targetType: 'user',
        targetId: userId,
        details: { role },
      });

      res.json(data);
    } catch (err: any) {
      console.error('[Admin Routes] Grant role error:', err);
      res.status(500).json({ error: 'Failed to grant role' });
    }
  }
);

/**
 * DELETE /api/admin/users/:userId/roles/:role
 * Revoke role from user
 */
router.delete(
  '/users/:userId/roles/:role',
  requireAdmin,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { userId, role } = req.params;

      const supabase = getSupabaseAdmin();

      const { error } = await supabase
        .from('user_roles')
        .update({
          is_active: false,
          revoked_at: new Date().toISOString(),
        })
        .eq('user_id', userId)
        .eq('role', role);

      if (error) {
        throw error;
      }

      logAuditAsync({
        actorId: req.userId!,
        actorRole: 'admin',
        action: AUDIT_ACTIONS.ROLE_REVOKED,
        targetType: 'user',
        targetId: userId,
        details: { role },
      });

      res.json({ success: true });
    } catch (err: any) {
      console.error('[Admin Routes] Revoke role error:', err);
      res.status(500).json({ error: 'Failed to revoke role' });
    }
  }
);

// ============================================
// DATA CONSENTS (Admin/Support)
// ============================================

/**
 * GET /api/admin/users/:userId/consents
 * Get user's data consents
 */
router.get(
  '/users/:userId/consents',
  requireSupport,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { userId } = req.params;

      const supabase = getSupabaseAdmin();

      const { data, error } = await supabase
        .from('data_consents')
        .select('*')
        .eq('user_id', userId);

      if (error) {
        throw error;
      }

      res.json(data);
    } catch (err: any) {
      console.error('[Admin Routes] Get consents error:', err);
      res.status(500).json({ error: 'Failed to get consents' });
    }
  }
);

// ============================================
// SYSTEM STATS (Admin only)
// ============================================

/**
 * GET /api/admin/stats
 * System-wide statistics
 */
router.get(
  '/stats',
  requireAdmin,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const supabase = getSupabaseAdmin();

      // Get counts from various tables
      const [
        { count: eventsCount },
        { count: conversationsCount },
        { count: outcomesCount },
        { count: documentsCount },
        { count: usersCount },
      ] = await Promise.all([
        supabase.from('events').select('id', { count: 'exact', head: true }),
        supabase.from('ai_conversations').select('id', { count: 'exact', head: true }),
        supabase.from('ai_outcomes').select('id', { count: 'exact', head: true }),
        supabase.from('documents').select('id', { count: 'exact', head: true }).eq('is_active', true),
        supabase.from('user_roles').select('user_id', { count: 'exact', head: true }).eq('is_active', true),
      ]);

      res.json({
        events: eventsCount || 0,
        conversations: conversationsCount || 0,
        outcomes: outcomesCount || 0,
        documents: documentsCount || 0,
        users: usersCount || 0,
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      console.error('[Admin Routes] Get stats error:', err);
      res.status(500).json({ error: 'Failed to get stats' });
    }
  }
);

// ============================================
// BACKGROUND JOBS (Admin only)
// ============================================

/**
 * POST /api/admin/jobs/features
 * Trigger daily features computation
 */
router.post(
  '/jobs/features',
  requireAdmin,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { runDailyFeaturesJob } = await import('../jobs/dailyFeatures.js');

      // Run job in background
      runDailyFeaturesJob()
        .then(result => {
          console.log('[Admin] Daily features job completed:', result);
        })
        .catch(err => {
          console.error('[Admin] Daily features job failed:', err);
        });

      logAuditAsync({
        actorId: req.userId!,
        actorRole: 'admin',
        action: 'job.triggered',
        targetType: 'job',
        targetId: 'daily_features',
        details: { triggered_by: 'admin_api' },
      });

      res.json({
        success: true,
        message: 'Daily features job started',
        job: 'daily_features',
      });
    } catch (err: any) {
      console.error('[Admin Routes] Trigger features job error:', err);
      res.status(500).json({ error: 'Failed to trigger job' });
    }
  }
);

/**
 * POST /api/admin/jobs/outcomes-timeout
 * Trigger outcomes timeout job
 */
router.post(
  '/jobs/outcomes-timeout',
  requireAdmin,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { runOutcomesTimeoutJob } = await import('../jobs/outcomesTimeout.js');

      // Run job in background
      runOutcomesTimeoutJob()
        .then(result => {
          console.log('[Admin] Outcomes timeout job completed:', result);
        })
        .catch(err => {
          console.error('[Admin] Outcomes timeout job failed:', err);
        });

      logAuditAsync({
        actorId: req.userId!,
        actorRole: 'admin',
        action: 'job.triggered',
        targetType: 'job',
        targetId: 'outcomes_timeout',
        details: { triggered_by: 'admin_api' },
      });

      res.json({
        success: true,
        message: 'Outcomes timeout job started',
        job: 'outcomes_timeout',
      });
    } catch (err: any) {
      console.error('[Admin Routes] Trigger outcomes job error:', err);
      res.status(500).json({ error: 'Failed to trigger job' });
    }
  }
);

/**
 * GET /api/admin/jobs
 * List available jobs
 */
router.get(
  '/jobs',
  requireAdmin,
  async (_req: AuthenticatedRequest, res: Response) => {
    res.json({
      jobs: [
        {
          id: 'daily_features',
          name: 'Daily Features Computation',
          description: 'Computes driver features for all active drivers',
          schedule: '04:00 UTC daily',
          endpoint: 'POST /api/admin/jobs/features',
        },
        {
          id: 'outcomes_timeout',
          name: 'Outcomes Timeout',
          description: 'Marks pending outcomes > 24h as ignored',
          schedule: '05:00 UTC daily',
          endpoint: 'POST /api/admin/jobs/outcomes-timeout',
        },
      ],
    });
  }
);

export { router as adminRouter };
