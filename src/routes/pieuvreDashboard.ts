/**
 * GET /api/pieuvre/dashboard/:driverId
 * GET /api/pieuvre/prospects/:driverId
 * GET /api/pieuvre/conversations/:driverId
 *
 * Endpoints qui exposent au driver app la puissance Pieuvre en arrière-plan.
 * Agrège :
 *   - pieuvre_prospects + pieuvre_conversion_funnel (pipeline deals)
 *   - pieuvre_conversations (messagerie active)
 *   - pieuvre_b2b_hunter_log (scraping en cours)
 *   - pieuvre_crm_enrichment (scores)
 *   - pieuvre_phone_calls (appels)
 *   - pieuvre_acquisition_pipeline (Apollo.io enrichment)
 *
 * Auth : JWT driver requis
 */
import { Router, Request, Response } from 'express';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

const router = Router();

let supabaseAdmin: SupabaseClient | null = null;
async function getSupa(): Promise<SupabaseClient> {
  if (supabaseAdmin) return supabaseAdmin;
  supabaseAdmin = createClient(
    process.env.SUPABASE_URL || 'https://fihvdvlhftcxhlnocqiq.supabase.co',
    process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  return supabaseAdmin;
}

async function getDriverIdFromJWT(req: Request): Promise<string | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;
  try {
    const supa = await getSupa();
    const { data } = await supa.auth.getUser(authHeader.replace('Bearer ', ''));
    return data?.user?.id || null;
  } catch {
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════════
// GET /api/pieuvre/dashboard/:driverId
// Vue synthèse "Ta Concierge" — 1 appel pour tout l'écran Dashboard
// ══════════════════════════════════════════════════════════════════════════

router.get('/dashboard/:driverId', async (req: Request, res: Response) => {
  const authDriverId = await getDriverIdFromJWT(req);
  const paramDriverId = req.params.driverId;
  // Sécurité : le driverId du JWT doit matcher le param
  if (!authDriverId || authDriverId !== paramDriverId) {
    return res.status(401).json({ error: 'Non authentifié ou driver_id mismatch' });
  }

  try {
    const supa = await getSupa();
    const startOfWeek = new Date();
    startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
    startOfWeek.setHours(0, 0, 0, 0);
    const weekISO = startOfWeek.toISOString();

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayISO = today.toISOString();

    // 6 requêtes parallèles pour perf
    const [prospectsFunnel, activeConvs, hunterScans, enrichments, recentCalls, crmStats] =
      await Promise.allSettled([
        // Pipeline de prospects (funnel view)
        supa
          .from('pieuvre_conversion_funnel')
          .select('prospect_id, first_name, phone, prospect_status, score, source, city')
          .order('score', { ascending: false })
          .limit(50),

        // Conversations actives (pas fermées, dernière activité < 7j)
        supa
          .from('pieuvre_conversations')
          .select('id, prospect_id, driver_id, channel, direction, created_at, updated_at')
          .eq('driver_id', paramDriverId)
          .gte('updated_at', new Date(Date.now() - 7 * 86400000).toISOString())
          .order('updated_at', { ascending: false })
          .limit(20),

        // Scans hunter en cours (dernières 24h)
        supa
          .from('pieuvre_b2b_hunter_log')
          .select('id, business_name, business_address, business_lat, business_lng, created_at')
          .eq('driver_id', paramDriverId)
          .gte('created_at', new Date(Date.now() - 86400000).toISOString())
          .order('created_at', { ascending: false })
          .limit(15),

        // Enrichissements récents (scores)
        supa
          .from('pieuvre_crm_enrichment')
          .select('prospect_id, engagement_score, churn_risk_score, referral_potential_score')
          .eq('driver_id', paramDriverId)
          .order('engagement_score', { ascending: false })
          .limit(20),

        // Appels récents Twilio
        supa
          .from('pieuvre_phone_calls')
          .select('id, prospect_id, direction, caller_number, created_at')
          .eq('driver_id', paramDriverId)
          .gte('created_at', weekISO)
          .order('created_at', { ascending: false })
          .limit(10),

        // Stats CRM cumulatives (semaine)
        supa
          .from('pieuvre_conversations')
          .select('id', { count: 'exact', head: true })
          .eq('driver_id', paramDriverId)
          .gte('created_at', weekISO),
      ]);

    const prospects =
      prospectsFunnel.status === 'fulfilled' ? prospectsFunnel.value.data || [] : [];
    const convs = activeConvs.status === 'fulfilled' ? activeConvs.value.data || [] : [];
    const scans = hunterScans.status === 'fulfilled' ? hunterScans.value.data || [] : [];
    const enrichArr = enrichments.status === 'fulfilled' ? enrichments.value.data || [] : [];
    const calls = recentCalls.status === 'fulfilled' ? recentCalls.value.data || [] : [];
    const convWeek = crmStats.status === 'fulfilled' ? crmStats.value.count || 0 : 0;

    // Compteurs pipeline
    const statusCounts: Record<string, number> = {
      discovered: 0,
      contacted: 0,
      responded: 0,
      negotiating: 0,
      closed: 0,
      lost: 0,
    };
    for (const p of prospects) {
      const status = mapStatusToEnum(p.prospect_status as string);
      statusCounts[status] = (statusCounts[status] || 0) + 1;
    }

    // Calcul "actions Ajnaya aujourd'hui" pour le hero
    const scansToday = scans.filter((s) => new Date(s.created_at) >= today).length;
    const convsToday = convs.filter((c) => new Date(c.updated_at) >= today).length;
    const callsToday = calls.filter((c) => new Date(c.created_at) >= today).length;

    // Timeline activités (merge scans + convs + calls)
    const timeline = buildTimeline(scans, convs, calls).slice(0, 15);

    // Top 3 prospects high-intent (score > 70 OU en négociation)
    const hotProspects = prospects
      .filter((p) => (p.score || 0) >= 70 || p.prospect_status === 'negotiating')
      .slice(0, 3);

    // Score global "performance réseau" (0-100)
    const networkScore = computeNetworkScore({
      prospects: prospects.length,
      convsWeek: convWeek,
      closed: statusCounts.closed,
      responded: statusCounts.responded,
    });

    return res.json({
      hero: {
        todayActions: {
          prospectsScanned: scansToday,
          conversationsActive: convsToday,
          callsMade: callsToday,
          totalAjnayaActions: scansToday + convsToday + callsToday,
        },
        networkScore, // 0-100
        weekSummary: `${convWeek} conversations cette semaine · ${statusCounts.closed} deals conclus`,
      },
      pipeline: statusCounts,
      hotProspects: hotProspects.map((p) => ({
        prospectId: p.prospect_id,
        name: (p as any).first_name || 'Prospect',
        phone: maskPhone((p as any).phone),
        status: mapStatusToEnum(p.prospect_status as string),
        score: p.score || 0,
        source: p.source || 'hunter',
        city: (p as any).city || null,
      })),
      timeline,
      stats: {
        activeConversations: convs.length,
        prospectsInFunnel: prospects.length,
        enrichmentsDone: enrichArr.length,
        callsThisWeek: calls.length,
      },
      refreshedAt: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error('[pieuvre/dashboard] error', err?.message);
    return res.status(500).json({ error: err?.message || 'Erreur serveur' });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// GET /api/pieuvre/prospects/:driverId
// Liste détaillée prospects pipeline (écran 2)
// ══════════════════════════════════════════════════════════════════════════

router.get('/prospects/:driverId', async (req: Request, res: Response) => {
  const authDriverId = await getDriverIdFromJWT(req);
  const paramDriverId = req.params.driverId;
  if (!authDriverId || authDriverId !== paramDriverId) {
    return res.status(401).json({ error: 'Non authentifié' });
  }

  try {
    const supa = await getSupa();
    const { data, error } = await supa
      .from('pieuvre_conversion_funnel')
      .select('*')
      .order('score', { ascending: false })
      .limit(100);

    if (error) throw error;

    return res.json({
      prospects: (data || []).map((p: any) => ({
        id: p.prospect_id,
        name: p.first_name || 'Prospect',
        phone: maskPhone(p.phone),
        email: p.email || null,
        city: p.city || null,
        status: mapStatusToEnum(p.prospect_status),
        score: p.score || 0,
        source: p.source || 'hunter',
        engagementScore: p.engagement_score || null,
        lastActivity: p.updated_at || p.created_at,
      })),
      total: data?.length || 0,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// GET /api/pieuvre/conversations/:driverId
// Liste messageries actives (écran 3)
// ══════════════════════════════════════════════════════════════════════════

router.get('/conversations/:driverId', async (req: Request, res: Response) => {
  const authDriverId = await getDriverIdFromJWT(req);
  const paramDriverId = req.params.driverId;
  if (!authDriverId || authDriverId !== paramDriverId) {
    return res.status(401).json({ error: 'Non authentifié' });
  }

  try {
    const supa = await getSupa();
    const { data, error } = await supa
      .from('pieuvre_conversations')
      .select('*, pieuvre_prospects(first_name, last_name, phone)')
      .eq('driver_id', paramDriverId)
      .order('updated_at', { ascending: false })
      .limit(50);

    if (error) throw error;

    return res.json({
      conversations: (data || []).map((c: any) => ({
        id: c.id,
        prospectId: c.prospect_id,
        prospectName: c.pieuvre_prospects?.first_name || 'Prospect',
        channel: c.channel || 'whatsapp',
        lastDirection: c.direction,
        lastMessage: c.content_preview || '',
        unread: c.unread_count || 0,
        updatedAt: c.updated_at,
      })),
      total: data?.length || 0,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════════

function mapStatusToEnum(status: string): string {
  if (!status) return 'discovered';
  const s = status.toLowerCase();
  if (s.includes('close') || s.includes('won') || s.includes('partner')) return 'closed';
  if (s.includes('lost') || s.includes('dead')) return 'lost';
  if (s.includes('negot')) return 'negotiating';
  if (s.includes('respond') || s.includes('reply')) return 'responded';
  if (s.includes('contact') || s.includes('sent')) return 'contacted';
  return 'discovered';
}

function maskPhone(phone: string | null): string | null {
  if (!phone) return null;
  // Garde les 4 premiers + 2 derniers chiffres : "06 XX XX XX 47"
  if (phone.length < 8) return phone;
  return `${phone.substring(0, 5)} ●●● ${phone.substring(phone.length - 2)}`;
}

interface TimelineItem {
  id: string;
  type: 'scan' | 'message' | 'call' | 'deal';
  title: string;
  subtitle?: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

function buildTimeline(scans: any[], convs: any[], calls: any[]): TimelineItem[] {
  const items: TimelineItem[] = [];

  for (const s of scans.slice(0, 5)) {
    items.push({
      id: `scan-${s.id ?? s.created_at}`,
      type: 'scan',
      title: `Ajnaya a repéré ${s.business_name || 'un lieu B2B'}`,
      subtitle: (s.business_address || '').substring(0, 60) || undefined,
      timestamp: s.created_at,
      metadata: { lat: s.business_lat, lng: s.business_lng },
    });
  }
  for (const c of convs.slice(0, 5)) {
    items.push({
      id: `conv-${c.id ?? c.updated_at}`,
      type: 'message',
      title: c.direction === 'outbound' ? 'Message envoyé par Ajnaya' : 'Réponse reçue',
      subtitle: `via ${c.channel || 'WhatsApp'}`,
      timestamp: c.updated_at,
      metadata: { channel: c.channel, direction: c.direction },
    });
  }
  for (const ca of calls.slice(0, 3)) {
    items.push({
      id: `call-${ca.id ?? ca.created_at}`,
      type: 'call',
      title: ca.direction === 'outbound' ? 'Appel sortant Ajnaya' : 'Appel entrant',
      subtitle: `vers ${maskPhone(ca.caller_number) || 'numéro privé'}`,
      timestamp: ca.created_at,
    });
  }

  // Sort desc par timestamp
  items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return items;
}

function computeNetworkScore(input: {
  prospects: number;
  convsWeek: number;
  closed: number;
  responded: number;
}): number {
  const { prospects, convsWeek, closed, responded } = input;
  // Composite score 0-100
  const reach = Math.min(30, prospects / 2); // 60 prospects = max 30 pts
  const engage = Math.min(25, convsWeek * 2); // 12 conv/sem = 24 pts
  const reply = Math.min(25, responded * 3); // 8 respond = 24 pts
  const deal = Math.min(20, closed * 10); // 2 deals = 20 pts
  return Math.round(reach + engage + reply + deal);
}

export default router;
