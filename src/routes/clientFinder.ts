/**
 * Client Finder Routes
 * Ajnaya2026v86
 *
 * GET  /api/client-finder/stats/:driverId       — live stats
 * GET  /api/client-finder/impact/:driverId      — impact du jour
 * GET  /api/client-finder/prospects/:driverId   — liste prospects paginée
 * GET  /api/client-finder/settings/:driverId    — lire settings
 * POST /api/client-finder/settings/:driverId    — upsert settings
 * POST /api/client-finder/run/:driverId         — déclencher run manuellement (debug)
 */

import { Router, Request, Response } from 'express';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

const router = Router();

let _supa: SupabaseClient | null = null;
function getSupa(): SupabaseClient | null {
  if (_supa) return _supa;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  _supa = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  return _supa;
}

// ── GET /stats/:driverId ──────────────────────────────────────────
router.get('/stats/:driverId', async (req: Request, res: Response) => {
  const supa = getSupa();
  if (!supa) return res.status(503).json({ error: 'DB not configured' });

  try {
    const { data, error } = await supa.rpc('get_finder_live_stats', {
      p_driver_id: req.params.driverId,
    });
    if (error) return res.status(500).json({ error: error.message });
    return res.json(
      data ?? {
        prospectsFound: 0,
        emailsSent: 0,
        responses: 0,
        conversions: 0,
        estimatedRevenue: 0,
      },
    );
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /impact/:driverId ─────────────────────────────────────────
router.get('/impact/:driverId', async (req: Request, res: Response) => {
  const supa = getSupa();
  if (!supa) return res.status(503).json({ error: 'DB not configured' });

  try {
    const { data, error } = await supa.rpc('get_client_impact_today', {
      p_driver_id: req.params.driverId,
    });
    if (error) return res.status(500).json({ error: error.message });
    return res.json(
      data ?? { sentToday: 0, dailyLimit: 5, remaining: 5, enabled: true, paused: false },
    );
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /prospects/:driverId ──────────────────────────────────────
router.get('/prospects/:driverId', async (req: Request, res: Response) => {
  const supa = getSupa();
  if (!supa) return res.status(503).json({ error: 'DB not configured' });

  const page = parseInt(req.query.page as string) || 0;
  const PAGE_SIZE = 20;

  try {
    const { data, error, count } = await supa
      .from('pieuvre_b2b_hunter_log')
      .select(
        `
        id,
        business_name,
        business_type,
        address,
        detected_at,
        status,
        outreach_email,
        outreach_sent_at,
        response_received_at,
        place_type_family,
        place_directory_id
      `,
        { count: 'exact' },
      )
      .eq('driver_id', req.params.driverId)
      .not('outreach_sent_at', 'is', null)
      .order('outreach_sent_at', { ascending: false })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

    if (error) {
      // Table manquante → retour vide
      if (error.code === '42P01') {
        return res.json({ prospects: [], total: 0, page });
      }
      return res.status(500).json({ error: error.message });
    }

    return res.json({ prospects: data || [], total: count || 0, page });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /settings/:driverId ───────────────────────────────────────
router.get('/settings/:driverId', async (req: Request, res: Response) => {
  const supa = getSupa();
  if (!supa) return res.status(503).json({ error: 'DB not configured' });

  try {
    const { data, error } = await supa
      .from('client_finder_settings')
      .select('*')
      .eq('driver_id', req.params.driverId)
      .single();

    if (error && error.code !== 'PGRST116') {
      // PGRST116 = not found
      return res.status(500).json({ error: error.message });
    }

    // Defaults si pas encore configuré
    return res.json(
      data ?? {
        driver_id: req.params.driverId,
        enabled: true,
        daily_limit: 5,
        target_families: ['HOSPITALITY', 'HIGH_INCOME', 'EVENT'],
        city_slug: 'paris',
        driver_presentation: null,
        custom_signature: null,
        pause_until: null,
      },
    );
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /settings/:driverId ──────────────────────────────────────
const SettingsSchema = z.object({
  enabled: z.boolean().optional(),
  daily_limit: z.number().int().min(1).max(20).optional(),
  target_families: z
    .array(
      z.enum([
        'HOSPITALITY',
        'HIGH_INCOME',
        'EVENT',
        'GASTRONOMY',
        'CORPORATE',
        'HEALTH_LUXURY',
        'REAL_ESTATE',
        'DIPLOMATIC',
      ]),
    )
    .optional(),
  city_slug: z.string().optional(),
  driver_presentation: z.string().max(300).nullable().optional(),
  custom_signature: z.string().max(200).nullable().optional(),
  pause_until: z.string().datetime().nullable().optional(),
  voice_calls_enabled: z.boolean().optional(),
  max_voice_calls_per_week: z.number().int().min(1).max(20).optional(),
});

router.post('/settings/:driverId', async (req: Request, res: Response) => {
  const supa = getSupa();
  if (!supa) return res.status(503).json({ error: 'DB not configured' });

  const parsed = SettingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  // v87.1 — Plan tier gating : ClientFinder nécessite plan PRO/BUSINESS
  if (parsed.data.enabled === true) {
    try {
      const { data: pref } = await supa
        .from('user_preferences')
        .select('subscription_status, plan_tier')
        .eq('user_id', req.params.driverId)
        .maybeSingle();

      const planTier = (pref as any)?.plan_tier ?? 'ESSENTIEL';
      if (planTier === 'ESSENTIEL') {
        return res.status(403).json({
          error: 'PLAN_UPGRADE_REQUIRED',
          message:
            'Le Client Finder est réservé aux plans PRO et BUSINESS. Passe au plan supérieur pour activer Ajnaya.',
          current_plan: planTier,
          upgrade_url: 'https://foreas.xyz/upgrade',
        });
      }
    } catch (err: any) {
      console.warn('[ClientFinder] plan-tier check failed (non-blocking):', err?.message);
    }
  }

  try {
    const { data, error } = await supa
      .from('client_finder_settings')
      .upsert(
        { driver_id: req.params.driverId, ...parsed.data, updated_at: new Date().toISOString() },
        { onConflict: 'driver_id' },
      )
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    // v88 — TRIGGER IMMÉDIAT : si enabled passe à true
    if (parsed.data.enabled === true) {
      (async () => {
        try {
          console.log(`[ClientFinder] 🚀 Trigger immédiat pour driver ${req.params.driverId}`);
          const { runEnrichmentBeforeFinder } =
            await import('../services/ApolloEnrichmentService.js');
          const citySlug = parsed.data.city_slug || 'paris';
          await runEnrichmentBeforeFinder(citySlug);

          const { runFinderForDriver } = await import('../services/ClientFinderService.js');
          const result = await runFinderForDriver(req.params.driverId, 'Chauffeur FOREAS');
          console.log(`[ClientFinder] 🚀 Trigger terminé: ${result.emailsSent} emails`);
        } catch (err: any) {
          console.error('[ClientFinder] Trigger immédiat error:', err.message);
        }
      })();
    }

    return res.json(data);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /run/:driverId — déclenchement manuel (debug/admin) ──────
router.post('/run/:driverId', async (req: Request, res: Response) => {
  // Protégé par service key
  const authHeader = req.headers.authorization;
  const validKey = process.env.FOREAS_SERVICE_KEY;
  if (!validKey || authHeader !== `Bearer ${validKey}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { runFinderForDriver } = await import('../services/ClientFinderService.js');
    const driverName = (req.body?.driverName as string) || 'Chauffeur';
    const result = await runFinderForDriver(req.params.driverId, driverName);
    return res.json(result);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
