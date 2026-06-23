/**
 * adminPieuvreState.routes.ts — Salle de commande Pieuvre (lecture admin)
 * =======================================================================
 * GET /api/admin/pieuvre-state
 *
 * Pont backend (chemin A) : les tables-cerveau de la Pieuvre sont
 * service_role-only → l'app (client anon) ne peut PAS les lire directement.
 * Cette route, réservée aux admins, agrège l'état de la Pieuvre via le
 * client SERVICE_ROLE et le renvoie en JSON propre.
 *
 * AUTH : JWT Supabase valide + rôle admin actif (user_roles role='admin').
 *        Sinon 401 / 403.
 *
 * Robustesse : chaque agrégat dans son propre try/catch — une vue/table
 * indisponible n'écroule jamais toute la route (renvoie une section vide).
 */

import { Router, Request, Response, NextFunction } from 'express';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

const router = Router();

// ── Client Supabase service_role (singleton lazy) ─────────────────────────
let _supa: SupabaseClient | null = null;
function getSupa(): SupabaseClient {
  if (_supa) return _supa;
  _supa = createClient(
    process.env.SUPABASE_URL || 'https://fihvdvlhftcxhlnocqiq.supabase.co',
    process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  return _supa;
}

// ── Middleware auth admin ─────────────────────────────────────────────────
// Vérifie le JWT puis l'appartenance au rôle 'admin' actif dans user_roles
// (cohérent avec mlm.routes.ts). is_admin() existe en DB mais on ne peut pas
// l'évaluer sous l'identité de l'appelant avec le client service_role, donc on
// lit user_roles directement (role='admin' + is_active).
async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Bearer token requis' });
  }
  try {
    const supa = getSupa();
    const { data, error } = await supa.auth.getUser(authHeader.replace('Bearer ', ''));
    if (error || !data?.user?.id) {
      return res.status(401).json({ error: 'Token invalide' });
    }

    const { data: role } = await supa
      .from('user_roles')
      .select('role')
      .eq('user_id', data.user.id)
      .eq('role', 'admin')
      .eq('is_active', true)
      .maybeSingle();

    if (!role) return res.status(403).json({ error: 'Rôle admin requis' });

    (req as any).adminUserId = data.user.id;
    next();
  } catch (err: any) {
    console.error('[AdminPieuvreState] requireAdmin error:', err?.message);
    return res.status(500).json({ error: 'Échec authentification' });
  }
}

// ── Helper : exécute une requête en l'isolant (jamais throw) ───────────────
async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err: any) {
    console.warn(`[AdminPieuvreState] ${label} failed:`, err?.message);
    return fallback;
  }
}

// ══════════════════════════════════════════════════════════════════════════
// GET /api/admin/pieuvre-state
// ══════════════════════════════════════════════════════════════════════════
router.get('/pieuvre-state', requireAdmin, async (_req: Request, res: Response) => {
  const supa = getSupa();

  // 1) Chauffeurs par état (driver_journey_state)
  const driversByState = await safe(
    'driversByState',
    async () => {
      const { data, error } = await supa.from('driver_journey_state').select('state').limit(2000);
      if (error) throw error;
      const buckets: Record<string, number> = {
        prospect: 0,
        onboarding: 0,
        active: 0,
        at_risk: 0,
        churned: 0,
        reactivated: 0,
      };
      let total = 0;
      for (const row of data || []) {
        const s = (row as any).state as string;
        if (s in buckets) buckets[s] += 1;
        else buckets[s] = (buckets[s] || 0) + 1; // tout état inattendu reste visible
        total += 1;
      }
      return { buckets, total };
    },
    {
      buckets: { prospect: 0, onboarding: 0, active: 0, at_risk: 0, churned: 0, reactivated: 0 },
      total: 0,
    },
  );

  // 2) Tâches Pieuvre par statut (pieuvre_tasks)
  const tasksByStatus = await safe(
    'tasksByStatus',
    async () => {
      const { data, error } = await supa.from('pieuvre_tasks').select('status').limit(5000);
      if (error) throw error;
      const buckets: Record<string, number> = { pending: 0, in_progress: 0, done: 0 };
      let total = 0;
      for (const row of data || []) {
        const s = (row as any).status as string;
        if (s in buckets) buckets[s] += 1;
        else buckets[s] = (buckets[s] || 0) + 1;
        total += 1;
      }
      return { buckets, total };
    },
    { buckets: { pending: 0, in_progress: 0, done: 0 }, total: 0 },
  );

  // 3) Dernières décisions du DG (dg_decisions, 10 dernières)
  const recentDecisions = await safe(
    'recentDecisions',
    async () => {
      const { data, error } = await supa
        .from('dg_decisions')
        .select(
          'id, driver_id, winning_tentacle_id, final_channel, rationale, driver_state_at, total_propositions_evaluated, reaction_type, sent_at, created_at',
        )
        .order('created_at', { ascending: false })
        .limit(10);
      if (error) throw error;
      return (data || []).map((d: any) => ({
        id: d.id,
        driverId: d.driver_id,
        tentacle: d.winning_tentacle_id || null,
        channel: d.final_channel || null,
        rationale: d.rationale || null,
        driverState: d.driver_state_at || null,
        propositionsEvaluated: d.total_propositions_evaluated ?? null,
        reaction: d.reaction_type || null,
        sentAt: d.sent_at || null,
        createdAt: d.created_at,
      }));
    },
    [] as any[],
  );

  // 4) Activité récente des tentacules (v_tentacle_activity_feed)
  const tentacleActivity = await safe(
    'tentacleActivity',
    async () => {
      const { data, error } = await supa
        .from('v_tentacle_activity_feed')
        .select('actor_tentacle, verb, channel, reason, outcome, ts')
        .order('ts', { ascending: false })
        .limit(20);
      if (error) throw error;
      return (data || []).map((a: any) => ({
        tentacle: a.actor_tentacle || null,
        verb: a.verb || null,
        channel: a.channel || null,
        reason: a.reason || null,
        outcome: a.outcome || null,
        at: a.ts,
      }));
    },
    [] as any[],
  );

  // 5) Flux du hub (v_pieuvre_hub) — entrant/sortant autour du DG/Facteur
  const hubFlow = await safe(
    'hubFlow',
    async () => {
      const { data, error } = await supa
        .from('v_pieuvre_hub')
        .select('sens, tentacule, interactions, dernier')
        .order('interactions', { ascending: false })
        .limit(40);
      if (error) throw error;
      return (data || []).map((h: any) => ({
        direction: h.sens || null, // 'in' / 'out' selon la vue
        tentacle: h.tentacule || null,
        interactions: Number(h.interactions || 0),
        lastAt: h.dernier || null,
      }));
    },
    [] as any[],
  );

  return res.json({
    driversByState,
    tasksByStatus,
    recentDecisions,
    tentacleActivity,
    hubFlow,
    updatedAt: new Date().toISOString(),
  });
});

export default router;
