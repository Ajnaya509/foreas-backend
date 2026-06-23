/**
 * GET /api/clients-directs/:driverId — Journal Clients Directs
 * Paginé : 20 items/page, triés par detected_at DESC
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

router.get('/:driverId', async (req: Request, res: Response) => {
  const { driverId } = req.params;
  const page = parseInt(req.query.page as string) || 0;
  const limit = 20;

  const supa = getSupabase();
  if (!supa) return res.status(503).json({ error: 'DB not configured' });

  try {
    const [logsResult, statsResult] = await Promise.all([
      supa
        .from('pieuvre_b2b_hunter_log')
        .select('*')
        .eq('driver_id', driverId)
        .order('detected_at', { ascending: false })
        .range(page * limit, (page + 1) * limit - 1),
      supa.from('pieuvre_b2b_hunter_log').select('status').eq('driver_id', driverId),
    ]);

    if (logsResult.error) {
      // Table manquante → retour vide (pas d'erreur pour le chauffeur)
      if (logsResult.error.code === '42P01') {
        return res.json({ logs: [], stats: { total: 0, converted: 0, active: 0 }, page });
      }
      return res.status(500).json({ error: logsResult.error.message });
    }

    const allStatuses = statsResult.data || [];
    const statsMap = {
      total: allStatuses.length,
      converted: allStatuses.filter((s: any) => s.status === 'CONVERTED').length,
      active: allStatuses.filter((s: any) => !['DECLINED', 'SILENT'].includes(s.status)).length,
    };

    return res.json({ logs: logsResult.data || [], stats: statsMap, page });
  } catch (err: any) {
    console.error('[ClientsDirects]', err?.message);
    return res.json({ logs: [], stats: { total: 0, converted: 0, active: 0 }, page });
  }
});

export default router;
