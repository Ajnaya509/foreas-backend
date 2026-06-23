/**
 * FOREAS Signals Ingest API
 * =========================
 * Reçoit les batchs de signaux collectés par DataPipelineService (mobile).
 *
 * ENDPOINTS:
 *   POST /api/signals/ingest   — Batch insert signaux + stats
 *   GET  /api/signals/status   — Statut du pipeline (healthcheck)
 *
 * SÉCURITÉ V1:
 *   - Pas de JWT requis (signaux passifs, pas de données PII)
 *   - sessionId obligatoire (tracabilité sans identification)
 *   - Rate-limit : 20 req/min par IP (assez pour sync 5min)
 *   - Payload max : 2MB
 */

import { Router, Request, Response } from 'express';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

const router = Router();

// ── Supabase admin client (lazy) ─────────────────────────────────────────────
let _supa: SupabaseClient | null = null;

function getSupabase(): SupabaseClient | null {
  if (_supa) return _supa;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  _supa = createClient(url, key);
  return _supa;
}

// ── Simple in-memory rate limiter (per IP, window 60s) ───────────────────────
const ipCounts: Map<string, { count: number; resetAt: number }> = new Map();
const RATE_LIMIT = 20;
const WINDOW_MS = 60_000;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const rec = ipCounts.get(ip);
  if (!rec || now > rec.resetAt) {
    ipCounts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  if (rec.count >= RATE_LIMIT) return false;
  rec.count++;
  return true;
}

// ── POST /api/signals/ingest ─────────────────────────────────────────────────

router.post('/ingest', async (req: Request, res: Response) => {
  const ip =
    (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
    req.socket.remoteAddress ||
    'unknown';

  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Rate limit exceeded — retry in 60s' });
  }

  const { sessionId, driverId, day, recordCount, stats, signals } = req.body || {};

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId (string) required' });
  }

  const dayKey = typeof day === 'string' ? day : new Date().toISOString().split('T')[0];
  const count = typeof recordCount === 'number' ? recordCount : 0;
  const safeStats = typeof stats === 'object' && stats !== null ? stats : {};

  const supa = getSupabase();

  // Si Supabase non configuré : accusé de réception sans stockage (dev/test)
  if (!supa) {
    console.log(`[Signals] No DB configured — session=${sessionId} day=${dayKey} records=${count}`);
    return res.status(200).json({ received: count, stored: 0, mode: 'no_db' });
  }

  try {
    const now = new Date().toISOString();

    const { error } = await supa.from('driver_signals').upsert(
      {
        session_id: sessionId,
        driver_id: driverId || null,
        day_key: dayKey,
        record_count: count,
        stats: safeStats,
        // signals JSON brut : optionnel (bande passante)
        signals_batch: Array.isArray(signals) ? signals : null,
        updated_at: now,
      },
      { onConflict: 'session_id,day_key' },
    );

    if (error) {
      // Table absente → créer à la volée avec INSERT simple
      if (error.code === '42P01') {
        console.warn('[Signals] Table driver_signals not found — run migration');
        return res.status(200).json({ received: count, stored: 0, mode: 'table_missing' });
      }
      console.error('[Signals] Supabase error:', error.message);
      return res.status(200).json({ received: count, stored: 0, error: error.message });
    }

    console.log(`[Signals] ✅ session=${sessionId} day=${dayKey} records=${count}`);
    return res.status(200).json({ received: count, stored: count });
  } catch (err: any) {
    console.error('[Signals] Ingest error:', err?.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/signals/status ──────────────────────────────────────────────────

router.get('/status', (_req: Request, res: Response) => {
  const dbConfigured = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
  res.json({
    service: 'signals',
    version: '1.0.0',
    db: dbConfigured ? 'configured' : 'missing',
    rateLimit: `${RATE_LIMIT} req/min per IP`,
  });
});

export { router as signalsRouter };
