/**
 * conciergeReveal.routes.ts — Révélation sécurisée du numéro prospect
 * ════════════════════════════════════════════════════════════════════════
 * Pieuvre2026(v12) — Chantier Onglet Clients (P0)
 *
 * Le numéro est masqué dans la liste (`06 ●● 47`). Le chauffeur le révèle au
 * moment d'appeler / d'ouvrir WhatsApp. Chaque révélation est loggée pour
 * audit RGPD + anti-scrape.
 *
 *   POST /api/concierge/prospects/:prospectId/reveal-phone
 *     Auth : JWT chauffeur (Bearer).
 *     Ownership : prospect doit appartenir au driver (v_driver_prospects).
 *     Rate-limit : 30 reveals / 24h / chauffeur.
 *     Renvoie : { phone, prospectId, revealedAt } — numéro EN CLAIR.
 *     Log : pieuvre_phone_reveals (driver_id, prospect_id, source_table, phone, ip).
 *
 * Le numéro n'est jamais renvoyé par l'endpoint liste (qui passe par le
 * router pieuvre / concierge existant). Seul cet endpoint le révèle.
 */
import { Router, Request, Response } from 'express';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

const router = Router();

const REVEAL_DAILY_LIMIT = 30;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let supaAdmin: SupabaseClient | null = null;
function getSupa(): SupabaseClient {
  if (supaAdmin) return supaAdmin;
  supaAdmin = createClient(
    process.env.SUPABASE_URL || 'https://fihvdvlhftcxhlnocqiq.supabase.co',
    process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  return supaAdmin;
}

async function getDriverIdFromJWT(req: Request): Promise<string | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;
  try {
    const { data } = await getSupa().auth.getUser(authHeader.replace('Bearer ', ''));
    return data?.user?.id || null;
  } catch {
    return null;
  }
}

router.post('/prospects/:prospectId/reveal-phone', async (req: Request, res: Response) => {
  const driverId = await getDriverIdFromJWT(req);
  if (!driverId) return res.status(401).json({ error: 'Auth requise' });

  const prospectId = req.params.prospectId;
  if (!prospectId || !UUID_RE.test(prospectId)) {
    return res.status(400).json({ error: 'prospectId invalide' });
  }

  const supa = getSupa();

  try {
    // Rate-limit : compter les reveals sur 24h glissantes
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count: revealsToday } = await supa
      .from('pieuvre_phone_reveals')
      .select('*', { count: 'exact', head: true })
      .eq('driver_id', driverId)
      .gte('created_at', since);

    if ((revealsToday ?? 0) >= REVEAL_DAILY_LIMIT) {
      return res.status(429).json({
        error: 'limite_journaliere_atteinte',
        message: `Limite de ${REVEAL_DAILY_LIMIT} révélations / 24h atteinte`,
        retryAfter: 24 * 3600,
      });
    }

    // Lecture via la vue unifiée — ownership inclus + récupère source_table
    const { data: prospect, error: pErr } = await supa
      .from('v_driver_prospects')
      .select('id, driver_id, source_table, contact_phone, contact_whatsapp, prospect_name')
      .eq('id', prospectId)
      .eq('driver_id', driverId)
      .maybeSingle();

    if (pErr) {
      console.error('[ConciergeReveal] vue prospects erreur:', pErr.message);
      return res.status(500).json({ error: 'internal_error' });
    }
    if (!prospect) {
      return res.status(404).json({ error: 'prospect_introuvable' });
    }

    const phone = prospect.contact_phone || prospect.contact_whatsapp;
    if (!phone) {
      return res
        .status(404)
        .json({ error: 'numero_indisponible', message: 'Pas de numéro pour ce prospect' });
    }

    // Audit log (best-effort — on ne bloque pas la révélation si log fail)
    const ipRaw =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || null;
    const revealedAt = new Date().toISOString();

    const { error: logErr } = await supa.from('pieuvre_phone_reveals').insert({
      driver_id: driverId,
      prospect_id: prospectId,
      source_table: prospect.source_table,
      phone_revealed: phone,
      ip_address: ipRaw,
      user_agent: req.headers['user-agent'] || null,
    });
    if (logErr) {
      console.warn('[ConciergeReveal] log soft-fail:', logErr.message);
    }

    return res.json({ phone, prospectId, revealedAt });
  } catch (err: any) {
    console.error('[ConciergeReveal] error:', err?.message);
    return res.status(500).json({ error: 'internal_error' });
  }
});

export default router;
