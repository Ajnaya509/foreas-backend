/**
 * Referral Routes - Systeme de parrainage FOREAS
 * 3 niveaux : 10€ N1, 4€ N2, 2€ N3
 */
import { Router, Request, Response } from 'express';

const router = Router();

let supabaseAdmin: any;
async function getSupa() {
  if (supabaseAdmin) return supabaseAdmin;
  const { createClient } = await import('@supabase/supabase-js');
  supabaseAdmin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return supabaseAdmin;
}

// ── Generateur de code parrainage : FOREAS-XX99 ──
export function generateReferralCode(firstName: string, lastName?: string): string {
  const first = (firstName || 'X')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z]/g, '')
    .substring(0, 1)
    .toUpperCase();
  const last = (lastName || firstName?.substring(1) || 'X')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z]/g, '')
    .substring(0, 1)
    .toUpperCase();
  const digits = Math.floor(Math.random() * 90 + 10);
  return `FOREAS-${first}${last}${digits}`;
}

export async function generateUniqueReferralCode(
  firstName: string,
  lastName?: string,
): Promise<string> {
  const supa = await getSupa();
  let code: string;
  let attempts = 0;
  do {
    code = generateReferralCode(firstName, lastName);
    const { data } = await supa.from('drivers').select('id').eq('referral_code', code).single();
    if (!data) return code;
    attempts++;
  } while (attempts < 10);
  const extra = Math.floor(Math.random() * 90 + 10);
  return `FOREAS-${code.split('-')[1]}${extra}`;
}

const COMMISSION_FIXED = {
  level_1: 10,
  level_2: 4,
  level_3: 2,
};

// ── GET /validate/:code — Verifier un code parrain ──
router.get('/validate/:code', async (req: Request, res: Response) => {
  const { code } = req.params;
  if (!code || code.length < 4) {
    return res.status(400).json({ valid: false, error: 'Code trop court' });
  }
  try {
    const supa = await getSupa();
    const { data: driver } = await supa
      .from('drivers')
      .select('id, first_name, last_name, referral_code')
      .eq('referral_code', code.toUpperCase())
      .single();

    if (!driver) {
      return res.json({ valid: false, message: 'Code parrain introuvable' });
    }
    return res.json({
      valid: true,
      sponsor: {
        first_name: driver.first_name,
        referral_code: driver.referral_code,
      },
    });
  } catch (err: any) {
    console.error('[Referral] validate error:', err.message);
    return res.status(500).json({ valid: false, error: 'Erreur serveur' });
  }
});

// ── GET /my-code/:driverId — Recuperer son code ──
router.get('/my-code/:driverId', async (req: Request, res: Response) => {
  const { driverId } = req.params;
  try {
    const supa = await getSupa();
    const { data: driver } = await supa
      .from('drivers')
      .select('referral_code, first_name')
      .eq('id', driverId)
      .single();

    if (!driver) {
      return res.status(404).json({ error: 'Chauffeur non trouve' });
    }
    if (!driver.referral_code) {
      const code = await generateUniqueReferralCode(driver.first_name || 'VTC');
      await supa.from('drivers').update({ referral_code: code }).eq('id', driverId);
      return res.json({ referral_code: code });
    }
    return res.json({ referral_code: driver.referral_code });
  } catch (err: any) {
    console.error('[Referral] my-code error:', err.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── GET /network/:driverId — Dashboard reseau complet ──
router.get('/network/:driverId', async (req: Request, res: Response) => {
  const { driverId } = req.params;
  try {
    const supa = await getSupa();
    const referralSelect = `
      id, referred_id, status, created_at,
      referred:drivers!referrals_referred_id_fkey(
        id, first_name, last_name, is_active, created_at
      )
    `;

    const { data: l1Referrals } = await supa
      .from('referrals')
      .select(referralSelect)
      .eq('sponsor_id', driverId)
      .eq('level', 1)
      .order('created_at', { ascending: false });

    const { data: l2Referrals } = await supa
      .from('referrals')
      .select(referralSelect)
      .eq('sponsor_id', driverId)
      .eq('level', 2)
      .order('created_at', { ascending: false });

    const { data: l3Referrals } = await supa
      .from('referrals')
      .select(referralSelect)
      .eq('sponsor_id', driverId)
      .eq('level', 3)
      .order('created_at', { ascending: false });

    const { data: commissions } = await supa
      .from('referral_commissions')
      .select('amount, level, status, created_at')
      .eq('sponsor_id', driverId)
      .order('created_at', { ascending: false })
      .limit(100);

    const totalEarned = (commissions || [])
      .filter((c: any) => c.status === 'paid')
      .reduce((sum: number, c: any) => sum + (c.amount || 0), 0);
    const totalPending = (commissions || [])
      .filter((c: any) => c.status === 'pending')
      .reduce((sum: number, c: any) => sum + (c.amount || 0), 0);

    const buildLevel = (data: any[]) => ({
      count: data?.length || 0,
      active: data?.filter((r: any) => r.status === 'active').length || 0,
      referrals: data || [],
    });

    return res.json({
      network: {
        level_1: buildLevel(l1Referrals || []),
        level_2: buildLevel(l2Referrals || []),
        level_3: buildLevel(l3Referrals || []),
      },
      commissions: {
        total_earned: totalEarned,
        total_pending: totalPending,
        history: commissions || [],
        tarifs: COMMISSION_FIXED,
      },
    });
  } catch (err: any) {
    console.error('[Referral] network error:', err.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── GET /stats/:driverId — Stats rapides ──
router.get('/stats/:driverId', async (req: Request, res: Response) => {
  const { driverId } = req.params;
  try {
    const supa = await getSupa();

    const countLevel = async (level: number) => {
      const { count } = await supa
        .from('referrals')
        .select('id', { count: 'exact', head: true })
        .eq('sponsor_id', driverId)
        .eq('level', level);
      return count || 0;
    };

    const l1Count = await countLevel(1);
    const l2Count = await countLevel(2);
    const l3Count = await countLevel(3);

    const { data: totalData } = await supa.rpc('sum_referral_commissions', {
      p_sponsor_id: driverId,
    });

    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const { data: monthData } = await supa
      .from('referral_commissions')
      .select('amount')
      .eq('sponsor_id', driverId)
      .eq('status', 'paid')
      .gte('created_at', startOfMonth.toISOString());

    const monthTotal = (monthData || []).reduce((s: number, c: any) => s + (c.amount || 0), 0);

    return res.json({
      filleuls_niveau_1: l1Count,
      filleuls_niveau_2: l2Count,
      filleuls_niveau_3: l3Count,
      total_filleuls: l1Count + l2Count + l3Count,
      commissions_total: totalData || 0,
      commissions_ce_mois: monthTotal,
      tarifs: COMMISSION_FIXED,
    });
  } catch (err: any) {
    console.error('[Referral] stats error:', err.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── POST /commission/process — Calcul commissions (appele par webhook Stripe) ──
//
// REGLE METIER FOREAS :
// - Abonnement filleul = 12,97 EUR/semaine
// - Commissions versees UNE SEULE FOIS apres 4 paiements consecutifs du filleul
// - Pas de commission a chaque paiement, uniquement au 4eme
// - Montants fixes : 10 EUR N1, 4 EUR N2, 2 EUR N3
// - Chaque parrain dans l'arbre recoit sa commission quand SON filleul atteint 4 paiements
// - Le parrain doit lui-meme etre a jour de ses paiements
//
// Exemple : Marc -> Marcel -> Julie -> Karim
// Quand Karim atteint 4 paiements : Julie +10 EUR, Marcel +4 EUR, Marc +2 EUR
// Quand Julie atteint 4 paiements : Marcel +10 EUR, Marc +4 EUR
// Quand Marcel atteint 4 paiements : Marc +10 EUR
// Marc total = 16 EUR, Marcel total = 14 EUR, Julie total = 10 EUR
//
const PAYMENTS_REQUIRED_FOR_PAYOUT = 4;

router.post('/commission/process', async (req: Request, res: Response) => {
  const { driver_id, amount_paid, invoice_id, subscription_id } = req.body || {};
  if (!driver_id || !amount_paid) {
    return res.status(400).json({ error: 'driver_id + amount_paid requis' });
  }
  try {
    const supa = await getSupa();

    // ── VERROU ANTI-DOUBLE : cycle deja traite pour ce filleul ? ──
    // Verifie 2 choses :
    //   1. Des commissions reelles (paid/pending avec amount > 0)
    //   2. Un marqueur cycle_completed (meme si aucun parrain n'etait eligible)
    const { count: realCommissions } = await supa
      .from('referral_commissions')
      .select('id', { count: 'exact', head: true })
      .eq('referred_id', driver_id)
      .in('status', ['paid', 'pending'])
      .gt('amount', 0);

    const { count: cycleCompleted } = await supa
      .from('referral_commissions')
      .select('id', { count: 'exact', head: true })
      .eq('referred_id', driver_id)
      .eq('status', 'cycle_completed');

    if ((realCommissions && realCommissions > 0) || (cycleCompleted && cycleCompleted > 0)) {
      console.log(
        `[Referral] Cycle deja traite pour filleul ${driver_id} — SKIP (verrou anti-double)`,
      );
      return res.json({
        success: true,
        commissions_created: 0,
        already_paid: true,
        message: 'Cycle de 4 paiements deja traite pour ce filleul',
      });
    }

    // ── Compter UNIQUEMENT les marqueurs 'counting' (paiements 1-3) ──
    const { count: countingMarkers } = await supa
      .from('referral_commissions')
      .select('id', { count: 'exact', head: true })
      .eq('referred_id', driver_id)
      .eq('status', 'counting');

    const currentPayment = (countingMarkers || 0) + 1;

    // Avant le 4eme paiement : on enregistre juste le compteur, pas de commission
    if (currentPayment < PAYMENTS_REQUIRED_FOR_PAYOUT) {
      // Enregistrer un marqueur pour compter (commission a 0 EUR, status 'counting')
      // On cherche le parrain N1 pour enregistrer
      const { data: referral } = await supa
        .from('referrals')
        .select('sponsor_id')
        .eq('referred_id', driver_id)
        .eq('level', 1)
        .eq('status', 'active')
        .single();

      if (referral) {
        await supa.from('referral_commissions').insert({
          sponsor_id: referral.sponsor_id,
          referred_id: driver_id,
          level: 1,
          amount: 0,
          source_amount: amount_paid,
          invoice_id: invoice_id || null,
          subscription_id: subscription_id || null,
          status: 'counting',
        });
      }

      console.log(
        `[Referral] Paiement #${currentPayment}/${PAYMENTS_REQUIRED_FOR_PAYOUT} du filleul ${driver_id} — en attente`,
      );
      return res.json({
        success: true,
        commissions_created: 0,
        payment_number: currentPayment,
        eligible_for_payout: false,
        payments_remaining: PAYMENTS_REQUIRED_FOR_PAYOUT - currentPayment,
      });
    }

    // ── 4eme paiement atteint : creer les commissions et payer ──
    console.log(
      `[Referral] 4eme paiement atteint pour filleul ${driver_id} — creation commissions !`,
    );

    // v1.10.55 — Marquer le filleul comme qualifié pour les commissions MLM
    // récurrentes (le cron mensuel se sert de ce flag).
    try {
      await supa
        .from('drivers')
        .update({
          qualified_for_referral: true,
          first_qualified_at: new Date().toISOString(),
        })
        .eq('id', driver_id)
        .is('first_qualified_at', null);
    } catch (qualErr: any) {
      console.warn('[Referral] qualify driver failed:', qualErr?.message);
    }

    const commissionsCreated: any[] = [];
    let currentDriverId = driver_id;

    const levels = [
      { level: 1, amount: COMMISSION_FIXED.level_1 },
      { level: 2, amount: COMMISSION_FIXED.level_2 },
      { level: 3, amount: COMMISSION_FIXED.level_3 },
    ];

    for (const { level, amount } of levels) {
      const { data: referral } = await supa
        .from('referrals')
        .select('sponsor_id')
        .eq('referred_id', currentDriverId)
        .eq('level', 1)
        .eq('status', 'active')
        .single();

      if (!referral) break;

      // Verifier que le parrain est lui-meme a jour de ses paiements
      const { data: sponsorDriver } = await supa
        .from('drivers')
        .select('subscription_active, stripe_account_id, email, first_name')
        .eq('id', referral.sponsor_id)
        .single();

      if (!sponsorDriver?.subscription_active) {
        console.warn(
          `[Referral] Parrain ${referral.sponsor_id} N${level} pas a jour — commission skippee`,
        );
        currentDriverId = referral.sponsor_id;
        continue;
      }

      // v1.10.55 — Idempotence par mois : skip si commission existe déjà
      // pour ce couple (sponsor, filleul, mois courant, niveau).
      // Le cron mensuel utilise la même clé d'idempotence.
      const monthStart = new Date();
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);
      const commissionMonthIso = monthStart.toISOString().split('T')[0]; // YYYY-MM-01

      const { data: existing } = await supa
        .from('referral_commissions')
        .select('id')
        .eq('sponsor_id', referral.sponsor_id)
        .eq('referred_id', driver_id)
        .eq('level', level)
        .eq('commission_month', commissionMonthIso)
        .gt('amount', 0)
        .maybeSingle();

      if (existing) {
        console.log(
          `[Referral] Commission N${level} déjà créée ce mois pour (${referral.sponsor_id} → ${driver_id}) — SKIP`,
        );
        currentDriverId = referral.sponsor_id;
        continue;
      }

      // Creer la commission (UNE SEULE au 4eme paiement)
      const { data: commission } = await supa
        .from('referral_commissions')
        .insert({
          sponsor_id: referral.sponsor_id,
          referred_id: driver_id,
          level,
          amount,
          source_amount: amount_paid * PAYMENTS_REQUIRED_FOR_PAYOUT, // total du cycle
          invoice_id: invoice_id || null,
          subscription_id: subscription_id || null,
          commission_month: commissionMonthIso,
          status: 'pending',
        })
        .select()
        .single();

      if (commission) commissionsCreated.push(commission);

      // ── Stripe Transfer automatique si compte Connect ──
      if (sponsorDriver.stripe_account_id && commission) {
        try {
          const Stripe = (await import('stripe')).default;
          const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
            apiVersion: '2024-12-18.acacia' as any,
          });

          const transfer = await stripe.transfers.create({
            amount: Math.round(amount * 100), // centimes
            currency: 'eur',
            destination: sponsorDriver.stripe_account_id,
            transfer_group: `referral_${driver_id}_cycle`,
            metadata: {
              type: 'referral_commission',
              level: String(level),
              sponsor_id: referral.sponsor_id,
              referred_id: driver_id,
              commission_id: commission.id,
            },
          });

          await supa
            .from('referral_commissions')
            .update({ status: 'paid', paid_at: new Date().toISOString() })
            .eq('id', commission.id);

          console.log(
            `[Referral] Stripe Transfer N${level} : ${amount}\u20ac -> ${sponsorDriver.stripe_account_id} (${transfer.id})`,
          );
        } catch (stripeErr: any) {
          console.warn(
            `[Referral] Stripe Transfer N${level} failed (reste pending):`,
            stripeErr.message,
          );
        }
      } else if (!sponsorDriver.stripe_account_id) {
        console.log(`[Referral] N${level} : parrain sans compte Connect — commission pending`);
      }

      // ── Email au parrain ──
      try {
        const { data: referred } = await supa
          .from('drivers')
          .select('first_name')
          .eq('id', driver_id)
          .single();

        if (sponsorDriver.email) {
          const { sendReferralValidated } = await import('../services/email.js');
          await sendReferralValidated(
            sponsorDriver.email,
            sponsorDriver.first_name || 'Chauffeur',
            referred?.first_name || 'un chauffeur',
            `${amount.toFixed(2)} \u20ac`,
          );
        }
      } catch (emailErr: any) {
        console.warn(`[Referral] Email N${level} failed:`, emailErr.message);
      }

      currentDriverId = referral.sponsor_id;
    }

    // Convertir les marqueurs 'counting' en 'cycle_completed'
    // NE PAS SUPPRIMER : ils servent de verrou anti-double
    await supa
      .from('referral_commissions')
      .update({ status: 'cycle_completed' })
      .eq('referred_id', driver_id)
      .eq('status', 'counting');

    // Si aucun parrain n'etait eligible (tous inactifs), inserer un marqueur
    // pour que le verrou fonctionne quand meme
    if (commissionsCreated.length === 0) {
      const { data: anyReferral } = await supa
        .from('referrals')
        .select('sponsor_id')
        .eq('referred_id', driver_id)
        .eq('level', 1)
        .single();

      if (anyReferral) {
        await supa.from('referral_commissions').insert({
          sponsor_id: anyReferral.sponsor_id,
          referred_id: driver_id,
          level: 0,
          amount: 0,
          source_amount: amount_paid * PAYMENTS_REQUIRED_FOR_PAYOUT,
          status: 'cycle_completed',
        });
      }
    }

    console.log(
      `[Referral] ${commissionsCreated.length} commission(s) creee(s) pour filleul ${driver_id} (cycle 4 paiements complete)`,
    );
    return res.json({
      success: true,
      commissions_created: commissionsCreated.length,
      payment_number: currentPayment,
      eligible_for_payout: true,
      payments_remaining: 0,
      details: commissionsCreated,
    });
  } catch (err: any) {
    console.error('[Referral] commission/process error:', err.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── GET /admin/all — Vue admin de tous les parrainages ──
router.get('/admin/all', async (_req: Request, res: Response) => {
  try {
    const supa = await getSupa();
    const { data: referrals } = await supa
      .from('referrals')
      .select(
        `
        id, level, status, created_at,
        sponsor:drivers!referrals_sponsor_id_fkey(id, first_name, last_name, email, referral_code),
        referred:drivers!referrals_referred_id_fkey(id, first_name, last_name, email)
      `,
      )
      .order('created_at', { ascending: false })
      .limit(200);

    const { data: commissions } = await supa
      .from('referral_commissions')
      .select('sponsor_id, amount, level, status')
      .eq('status', 'paid');

    const totalPaid = (commissions || []).reduce((s: number, c: any) => s + (c.amount || 0), 0);

    return res.json({
      total_referrals: referrals?.length || 0,
      total_commissions_paid: totalPaid,
      referrals: referrals || [],
    });
  } catch (err: any) {
    console.error('[Referral] admin/all error:', err.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

export default router;
