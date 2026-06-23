/**
 * POST /api/analytics-events/event — Fire & forget event tracking
 */

import { Router, Request, Response } from 'express';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

const router = Router();

let _supa: SupabaseClient | null = null;
function getSupabase(): SupabaseClient | null {
  if (_supa) return _supa;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  _supa = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  return _supa;
}

router.post('/event', async (req: Request, res: Response) => {
  const { driver_id, event, meta, ts } = req.body;
  if (!driver_id || !event) return res.status(400).json({ error: 'Missing fields' });

  const supa = getSupabase();
  if (!supa) return res.json({ ok: true, mode: 'no_db' });

  supa
    .from('pieuvre_analytics_events')
    .insert({
      driver_id,
      event_name: event,
      meta: meta ?? {},
      created_at: new Date(ts || Date.now()).toISOString(),
    })
    .then(
      () => {},
      (e: any) => console.error('[Analytics]', e.message),
    );

  return res.json({ ok: true });
});

export default router;
