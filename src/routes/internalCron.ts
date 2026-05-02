/**
 * Internal Cron Routes — Ajnaya2026v87.2
 *
 * POST /api/internal/run-followup-batch
 *   Protégé par header X-Internal-Secret = env.CRON_SECRET
 *   Déclenche runFollowupBatch() du finderFollowupCron
 *   Destiné au Railway Cron Service (curl quotidien 10h UTC)
 *
 * POST /api/internal/run-finder-batch
 *   Idem, déclenche runClientFinderBatch (B2B outreach)
 *
 * POST /api/internal/run-quality-score-batch
 *   Idem, recalcule les quality scores (hebdo)
 */

import { Router, Request, Response, NextFunction } from 'express';

const router = Router();

// ── Middleware : vérification du secret interne ──────────────────
function requireInternalSecret(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    console.error('[InternalCron] CRON_SECRET not set — refusing all requests');
    return res.status(503).json({ error: 'Internal cron not configured' });
  }
  const provided = req.headers['x-internal-secret'];
  if (typeof provided !== 'string' || provided !== expected) {
    console.warn('[InternalCron] Invalid X-Internal-Secret header');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── POST /run-followup-batch ─────────────────────────────────────
router.post('/run-followup-batch', requireInternalSecret, async (_req: Request, res: Response) => {
  try {
    const { runFollowupBatch } = await import('../jobs/finderFollowupCron.js');
    const t0 = Date.now();
    const result = await runFollowupBatch();
    console.log('[InternalCron] ✅ followup batch:', result);
    return res.json({ ok: true, durationMs: Date.now() - t0, result });
  } catch (err: any) {
    console.error('[InternalCron] followup batch error:', err?.message);
    return res.status(500).json({ ok: false, error: err?.message });
  }
});

// ── POST /run-mlm-monthly-payout (v1.10.55) ──────────────────────
// Railway Cron Service : curl le 5 du mois 09:00 UTC
//   curl -X POST -H "X-Internal-Secret: $CRON_SECRET" \
//     https://foreas-stripe-backend-production.up.railway.app/api/internal/run-mlm-monthly-payout
router.post(
  '/run-mlm-monthly-payout',
  requireInternalSecret,
  async (_req: Request, res: Response) => {
    try {
      const { runMlmMonthlyPayout } = await import('../jobs/mlmMonthlyPayoutCron.js');
      const result = await runMlmMonthlyPayout();
      console.log('[InternalCron] ✅ MLM monthly payout:', result);
      return res.json({ ok: true, ...result });
    } catch (err: any) {
      console.error('[InternalCron] MLM monthly payout error:', err?.message);
      return res.status(500).json({ ok: false, error: err?.message });
    }
  },
);

// ── POST /run-finder-batch ───────────────────────────────────────
router.post('/run-finder-batch', requireInternalSecret, async (_req: Request, res: Response) => {
  try {
    const { runClientFinderBatch } = await import('../services/ClientFinderService.js');
    const t0 = Date.now();
    const results = await runClientFinderBatch();
    const summary = {
      drivers: results.length,
      emailsSent: results.reduce((s, r) => s + r.emailsSent, 0),
      errors: results.reduce((s, r) => s + r.errors, 0),
    };
    console.log('[InternalCron] ✅ finder batch:', summary);
    return res.json({ ok: true, durationMs: Date.now() - t0, summary });
  } catch (err: any) {
    console.error('[InternalCron] finder batch error:', err?.message);
    return res.status(500).json({ ok: false, error: err?.message });
  }
});

// ── POST /run-quality-score-batch ────────────────────────────────
router.post(
  '/run-quality-score-batch',
  requireInternalSecret,
  async (_req: Request, res: Response) => {
    try {
      const { computeQualityScoresBatch } = await import('../services/QualityScoreService.js');
      const t0 = Date.now();
      const count = await computeQualityScoresBatch();
      console.log('[InternalCron] ✅ quality score batch:', count);
      return res.json({ ok: true, durationMs: Date.now() - t0, drivers_scored: count });
    } catch (err: any) {
      console.error('[InternalCron] quality score batch error:', err?.message);
      return res.status(500).json({ ok: false, error: err?.message });
    }
  },
);

// ── v88: ML batch ────────────────────────────────────────────────
router.post('/run-ml-batch', requireInternalSecret, async (_req, res) => {
  try {
    const start = Date.now();
    const { runMLBatch } = await import('../jobs/finderMLCron.js');
    const result = await runMLBatch();
    res.json({ ok: true, durationMs: Date.now() - start, result });
  } catch (e: any) {
    console.error('[cron] ML batch error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── v88: Voice recording purge ───────────────────────────────────
router.post('/run-voice-purge', requireInternalSecret, async (_req, res) => {
  try {
    const start = Date.now();
    const { runVoicePurge } = await import('../jobs/voicePurgeCron.js');
    const result = await runVoicePurge();
    res.json({ ok: true, durationMs: Date.now() - start, result });
  } catch (e: any) {
    console.error('[cron] Voice purge error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── v88: Voice budget monitor ────────────────────────────────────
router.post('/run-voice-budget-check', requireInternalSecret, async (_req, res) => {
  try {
    const start = Date.now();
    const { runBudgetCheck } = await import('../jobs/voiceBudgetMonitor.js');
    const result = await runBudgetCheck();
    res.json({ ok: true, durationMs: Date.now() - start, result });
  } catch (e: any) {
    console.error('[cron] Budget check error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

export default router;
