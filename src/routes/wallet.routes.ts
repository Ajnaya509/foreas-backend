/**
 * Wallet Routes — Résumé solde, demande de retrait, historique payouts
 *
 * VARIABLES RAILWAY REQUISES:
 *   SUPABASE_URL              = https://fihvdvlhftcxhlnocqiq.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY = eyJ... (service_role key depuis Supabase → Settings → API)
 *   STRIPE_SECRET_KEY         = sk_live_... (depuis Stripe Dashboard)
 */
import { Router, Request, Response } from 'express';
import Stripe from 'stripe';

const router = Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2024-12-18.acacia' as any,
});

// ── Supabase admin client (lazy, null-safe) ──────────────────────────────────
let supabaseAdmin: any = null;

async function getSupa(): Promise<any | null> {
  if (supabaseAdmin) return supabaseAdmin;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.warn(
      '[Wallet] ⚠️  SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY manquant sur Railway — auth wallet désactivée',
    );
    return null;
  }
  const { createClient } = await import('@supabase/supabase-js');
  supabaseAdmin = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return supabaseAdmin;
}

/** Extraire le driver_id depuis le JWT Supabase (null = non authentifié ou config manquante) */
async function getDriverFromAuth(req: Request): Promise<string | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;

  const supa = await getSupa();
  if (!supa) return null; // env vars manquants — 401 renvoyé par la route

  try {
    const token = authHeader.slice(7);
    const { data, error } = await supa.auth.getUser(token);
    if (error) {
      console.warn('[Wallet] getUser failed:', error.message);
      return null;
    }
    return data?.user?.id ?? null;
  } catch (e: any) {
    console.error('[Wallet] Auth exception:', e?.message);
    return null;
  }
}

// ── GET /wallet-status — diagnostic endpoint ─────────────────────────────────
router.get('/wallet-status', (_req: Request, res: Response) => {
  const supaConfigured = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
  const stripeConfigured = !!process.env.STRIPE_SECRET_KEY;
  res.json({
    service: 'wallet',
    version: '1.1.0',
    supabase: supaConfigured
      ? 'configured'
      : 'MISSING — set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY on Railway',
    stripe: stripeConfigured ? 'configured' : 'MISSING — set STRIPE_SECRET_KEY on Railway',
    auth_method: 'Bearer JWT (Supabase access_token)',
  });
});

// ── GET /wallet-summary ──────────────────────────────────────────────────────
router.get('/wallet-summary', async (req: Request, res: Response) => {
  try {
    const driverId = await getDriverFromAuth(req);
    if (!driverId) {
      return res.status(401).json({ error: 'Non authentifie' });
    }

    const supa = await getSupa();

    // Récupérer le driver + stripe_account_id
    const { data: driver } = await supa
      .from('drivers')
      .select('id, stripe_account_id, referral_code')
      .eq('id', driverId)
      .single();

    if (!driver) {
      return res.json({
        available: 0,
        pending: 0,
        processing: 0,
        total_paid: 0,
        total_earned: 0,
        can_withdraw: false,
        min_withdrawal: 10,
        stripe_status: 'not_connected',
      });
    }

    // Commissions parrainage
    const { data: paidComm } = await supa
      .from('referral_commissions')
      .select('amount')
      .eq('sponsor_id', driverId)
      .eq('status', 'paid');

    const { data: pendingComm } = await supa
      .from('referral_commissions')
      .select('amount')
      .eq('sponsor_id', driverId)
      .eq('status', 'pending');

    const totalPaid = (paidComm || []).reduce((s: number, c: any) => s + (c.amount || 0), 0);
    const totalPending = (pendingComm || []).reduce((s: number, c: any) => s + (c.amount || 0), 0);

    // Stripe balance si connecté
    let stripeAvailable = 0;
    let stripeStatus = 'not_connected';
    let lastPayoutAt: string | null = null;
    let lastPayoutAmount = 0;

    if (driver.stripe_account_id) {
      try {
        const account = await stripe.accounts.retrieve(driver.stripe_account_id);
        stripeStatus = account.details_submitted ? 'active' : 'pending_kyc';

        const balance = await stripe.balance.retrieve({ stripeAccount: driver.stripe_account_id });
        stripeAvailable = (balance.available?.[0]?.amount || 0) / 100;

        // Dernier payout
        const payouts = await stripe.payouts.list(
          { limit: 1 },
          { stripeAccount: driver.stripe_account_id },
        );
        if (payouts.data.length > 0) {
          lastPayoutAt = new Date(payouts.data[0].created * 1000).toISOString();
          lastPayoutAmount = payouts.data[0].amount / 100;
        }
      } catch (stripeErr: any) {
        console.warn('[Wallet] Stripe error:', stripeErr.message);
        if (stripeErr.code === 'account_invalid') stripeStatus = 'restricted';
      }
    }

    const available = stripeAvailable + totalPaid;

    return res.json({
      available,
      pending: totalPending,
      processing: 0,
      total_paid: totalPaid,
      total_earned: totalPaid + totalPending,
      last_payout_at: lastPayoutAt,
      last_payout_amount: lastPayoutAmount,
      can_withdraw: available >= 10 && stripeStatus === 'active',
      min_withdrawal: 10,
      stripe_status: stripeStatus,
    });
  } catch (err: any) {
    console.error('[Wallet] summary error:', err.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── POST /payout-request ─────────────────────────────────────────────────────
router.post('/payout-request', async (req: Request, res: Response) => {
  try {
    const driverId = await getDriverFromAuth(req);
    if (!driverId) return res.status(401).json({ error: 'Non authentifie' });

    const { amount } = req.body;
    if (!amount || amount < 10) {
      return res.status(400).json({ error: 'Minimum 10€' });
    }

    const supa = await getSupa();
    const { data: driver } = await supa
      .from('drivers')
      .select('stripe_account_id')
      .eq('id', driverId)
      .single();

    if (!driver?.stripe_account_id) {
      return res.status(400).json({ error: 'Compte Stripe non configure' });
    }

    // Créer un transfert depuis le compte platform vers le compte connecté
    const transfer = await stripe.transfers.create({
      amount: Math.round(amount * 100),
      currency: 'eur',
      destination: driver.stripe_account_id,
      description: `FOREAS - Retrait commissions parrainage`,
    });

    // Marquer les commissions pending comme paid
    await supa
      .from('referral_commissions')
      .update({ status: 'paid', paid_at: new Date().toISOString() })
      .eq('sponsor_id', driverId)
      .eq('status', 'pending');

    console.log(`[Wallet] Payout ${amount}€ pour driver ${driverId}`);

    return res.json({
      success: true,
      transfer_id: transfer.id,
      amount,
    });
  } catch (err: any) {
    console.error('[Wallet] payout error:', err.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── POST /stripe-onboarding ─────────────────────────────────────────────────
router.post('/stripe-onboarding', async (req: Request, res: Response) => {
  try {
    const driverId = await getDriverFromAuth(req);
    if (!driverId) return res.status(401).json({ error: 'Non authentifie' });

    const supa = await getSupa();
    const { data: driver } = await supa
      .from('drivers')
      .select('id, email, stripe_account_id, first_name, last_name')
      .eq('id', driverId)
      .single();

    if (!driver) return res.status(404).json({ error: 'Chauffeur non trouve' });

    let accountId = driver.stripe_account_id;

    // Créer le compte Express si pas encore fait
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: 'express',
        country: 'FR',
        email: driver.email,
        capabilities: { transfers: { requested: true } },
        business_type: 'individual',
        metadata: { driver_id: driverId, platform: 'foreas' },
      });
      accountId = account.id;

      await supa.from('drivers').update({ stripe_account_id: accountId }).eq('id', driverId);
    }

    // Créer le lien d'onboarding
    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: 'foreas://wallet/stripe-refresh',
      return_url: 'foreas://wallet/stripe-return',
      type: 'account_onboarding',
    });

    return res.json({
      success: true,
      url: accountLink.url,
      account_id: accountId,
    });
  } catch (err: any) {
    console.error('[Wallet] onboarding error:', err.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

export default router;
