/**
 * mlmMonthlyPayoutCron — Versement mensuel des commissions MLM (chauffeur + partner)
 * v1.10.55 — 2 mai 2026
 *
 * Déclenché par Railway Cron Service le 5 du mois à 09:00 UTC :
 *   POST /api/internal/run-mlm-monthly-payout
 *   Header: X-Internal-Secret = CRON_SECRET
 *
 * Mécanique (Referral Program V3 — 2026-06-22) :
 *   - CHAUFFEUR : MONO-NIVEAU. Parrain direct (N1) uniquement. Montant TIÉRÉ selon son
 *     nb de filleuls actifs+vérifiés : 25€ (0-14) / 35€ (15-49) / 50€ (50+).
 *     Source de vérité DB = referral_program_tiers + get_referral_commission_amount().
 *   - PARTENAIRE : barème COMMISSION_BY_LEVEL inchangé (deal séparé, à retravailler).
 *
 * Gates chauffeur : filleul vtc_card_verified=true (anti-fraude Claude Vision) +
 *   parrain SANS partner_id + parrain subscription_active.
 * Carence : `qualified_for_referral=true` requis sur le filleul (= 1 mois complet payé)
 * Récurrence : tant que filleul `subscription_active=true`
 * Idempotence : (sponsor_id, referred_id, commission_month, level) UNIQUE
 * Versement : Stripe Transfer immédiat vers stripe_account_id, pas de seuil
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

// Pricing V2 (09/06/2026) : 25€ / 8€ / 2€ — cascade dès le 1er paiement
const COMMISSION_BY_LEVEL: Record<1 | 2 | 3, number> = {
  1: 25,
  2: 8,
  3: 2,
};

let _supa: SupabaseClient | null = null;
function getDb(): SupabaseClient {
  if (_supa) return _supa;
  _supa = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return _supa;
}

let _stripe: Stripe | null = null;
function getStripe(): Stripe {
  if (_stripe) return _stripe;
  _stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2024-12-18.acacia' as any,
  });
  return _stripe;
}

/** Fire-and-forget vers le webhook Pieuvre N8N — ne bloque jamais le cron */
function notifyPieuvre(event: string, payload: Record<string, unknown>): void {
  const webhookUrl = process.env.PIEUVRE_MLM_WEBHOOK_URL;
  const secret = process.env.PIEUVRE_MLM_SECRET;
  if (!webhookUrl || !secret) return;
  fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Foreas-Shared-Secret': secret,
    },
    body: JSON.stringify({ event, ...payload }),
  }).catch((err: Error) => {
    console.warn(`[MlmCron] Pieuvre notify failed for event "${event}":`, err?.message);
  });
  console.log(`[MlmCron] Pieuvre notified event="${event}"`);
}

/** Premier jour du mois courant en YYYY-MM-DD */
function currentMonthStart(): string {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.toISOString().split('T')[0];
}

interface SponsorInfo {
  type: 'driver' | 'partner';
  id: string;
  stripe_account_id: string | null;
  email?: string | null;
  display_name?: string | null;
}

interface CronResult {
  ok: boolean;
  commission_month: string;
  qualified_filleuls_processed: number;
  commissions_inserted: number;
  commissions_skipped_idempotent: number;
  transfers_succeeded: number;
  transfers_failed: number;
  transfers_skipped_no_account: number;
  total_paid_eur: number;
  errors: string[];
  duration_ms: number;
}

/**
 * Trouve le sponsor d'un filleul, en remontant via les tables `referrals`
 * (chauffeur sponsor) ET `partner_referrals` (partner sponsor).
 *
 * Returns null si aucun sponsor à ce niveau.
 */
async function findSponsor(supa: SupabaseClient, filleulId: string): Promise<SponsorInfo | null> {
  // 1) Cherche un sponsor CHAUFFEUR via referrals
  const { data: driverRef } = await supa
    .from('referrals')
    .select('sponsor_id')
    .eq('referred_id', filleulId)
    .eq('level', 1)
    .eq('status', 'active')
    .maybeSingle();

  if (driverRef?.sponsor_id) {
    const { data: driver } = await supa
      .from('drivers')
      .select('id, stripe_account_id, email, first_name, subscription_active')
      .eq('id', driverRef.sponsor_id)
      .maybeSingle();
    if (driver?.subscription_active) {
      return {
        type: 'driver',
        id: driver.id,
        stripe_account_id: driver.stripe_account_id,
        email: driver.email,
        display_name: driver.first_name,
      };
    }
  }

  // 2) Sinon, cherche un sponsor PARTNER via partner_referrals
  const { data: partnerRef } = await supa
    .from('partner_referrals')
    .select('partner_id')
    .eq('driver_id', filleulId)
    .maybeSingle();

  if (partnerRef?.partner_id) {
    const { data: partner } = await supa
      .from('partners')
      .select('id, stripe_account_id, contact_email, company_name, status')
      .eq('id', partnerRef.partner_id)
      .maybeSingle();
    if (partner?.status === 'active') {
      return {
        type: 'partner',
        id: partner.id,
        stripe_account_id: partner.stripe_account_id,
        email: partner.contact_email,
        display_name: partner.company_name,
      };
    }
  }

  return null;
}

/**
 * Insert idempotent d'une commission. Retourne la commission ou null si déjà existante.
 */
async function insertCommissionIdempotent(
  supa: SupabaseClient,
  sponsor: SponsorInfo,
  filleulId: string,
  level: 1 | 2 | 3,
  commissionMonth: string,
): Promise<{ id: string; amount: number; type: 'driver' | 'partner' } | null> {
  if (sponsor.type === 'driver') {
    // ── Referral Program V3 (2026-06-22) : MONO-NIVEAU + montant tiéré 25/35/50 ──
    // On ne paie que le parrain DIRECT (N1). Les niveaux 2/3 ne sont plus payés.
    if (level !== 1) return null;

    // Anti-fraude : le filleul ne compte que si sa carte VTC est vérifiée (Claude Vision + anti-IA).
    const { data: filleul } = await supa
      .from('drivers')
      .select('vtc_card_verified')
      .eq('id', filleulId)
      .maybeSingle();
    if (!filleul?.vtc_card_verified) return null;

    // Parrain inscrit au programme PARTENAIRE → deal séparé (partner_commissions), pas de commission MLM chauffeur.
    const { data: sp } = await supa
      .from('drivers')
      .select('partner_id')
      .eq('id', sponsor.id)
      .maybeSingle();
    if (sp?.partner_id) return null;

    // Montant tiéré selon le palier du parrain (25/35/50) — source de vérité DB referral_program_tiers.
    const { data: tieredAmount } = await supa.rpc('get_referral_commission_amount', {
      p_sponsor_id: sponsor.id,
    });
    const amount = typeof tieredAmount === 'number' ? tieredAmount : 25;

    // Idempotence
    const { data: existing } = await supa
      .from('referral_commissions')
      .select('id')
      .eq('sponsor_id', sponsor.id)
      .eq('referred_id', filleulId)
      .eq('commission_month', commissionMonth)
      .eq('level', level)
      .gt('amount', 0)
      .maybeSingle();
    if (existing) return null;

    const { data: created, error } = await supa
      .from('referral_commissions')
      .insert({
        sponsor_id: sponsor.id,
        referred_id: filleulId,
        level,
        amount,
        source_amount: amount,
        commission_month: commissionMonth,
        status: 'pending',
      })
      .select('id')
      .single();
    if (error) {
      console.warn(`[MlmCron] insert referral_commissions failed:`, error.message);
      return null;
    }
    return { id: created.id, amount, type: 'driver' };
  } else {
    const amount = COMMISSION_BY_LEVEL[level]; // Partenaires : barème inchangé (deal séparé, à retravailler)
    // Partner
    const { data: existing } = await supa
      .from('partner_commissions')
      .select('id')
      .eq('partner_id', sponsor.id)
      .eq('referred_id', filleulId)
      .eq('commission_month', commissionMonth)
      .eq('level', level)
      .maybeSingle();
    if (existing) return null;

    const { data: created, error } = await supa
      .from('partner_commissions')
      .insert({
        partner_id: sponsor.id,
        driver_id: filleulId, // legacy column = filleul direct N1 (peut être null pour N2/N3)
        referred_id: filleulId,
        level,
        commission_amount: amount,
        commission_month: commissionMonth,
        status: 'pending',
      })
      .select('id')
      .single();
    if (error) {
      console.warn(`[MlmCron] insert partner_commissions failed:`, error.message);
      return null;
    }
    return { id: created.id, amount, type: 'partner' };
  }
}

/**
 * Verse une commission via Stripe Transfer + update le statut.
 */
async function payCommission(
  supa: SupabaseClient,
  sponsor: SponsorInfo,
  commission: { id: string; amount: number; type: 'driver' | 'partner' },
  filleulId: string,
  commissionMonth: string,
): Promise<{ ok: boolean; transferId?: string; error?: string }> {
  if (!sponsor.stripe_account_id) {
    return { ok: false, error: 'no_stripe_account' };
  }

  try {
    const stripe = getStripe();
    const transfer = await stripe.transfers.create({
      amount: Math.round(commission.amount * 100),
      currency: 'eur',
      destination: sponsor.stripe_account_id,
      transfer_group: `mlm_payout_${commissionMonth}`,
      metadata: {
        type: 'mlm_commission_monthly',
        sponsor_type: sponsor.type,
        sponsor_id: sponsor.id,
        referred_id: filleulId,
        commission_id: commission.id,
        commission_month: commissionMonth,
      },
    });

    // Update commission status='paid'
    const table = sponsor.type === 'driver' ? 'referral_commissions' : 'partner_commissions';
    await supa
      .from(table)
      .update({
        status: 'paid',
        paid_at: new Date().toISOString(),
        ...(sponsor.type === 'partner' ? { stripe_transfer_id: transfer.id } : {}),
      })
      .eq('id', commission.id);

    return { ok: true, transferId: transfer.id };
  } catch (err: any) {
    console.error(
      `[MlmCron] Stripe Transfer failed for commission ${commission.id}:`,
      err?.message,
    );
    return { ok: false, error: err?.message ?? 'stripe_error' };
  }
}

/**
 * Job principal — appelé par /api/internal/run-mlm-monthly-payout
 */
export async function runMlmMonthlyPayout(): Promise<CronResult> {
  const t0 = Date.now();
  const supa = getDb();
  const commissionMonth = currentMonthStart();

  const result: CronResult = {
    ok: true,
    commission_month: commissionMonth,
    qualified_filleuls_processed: 0,
    commissions_inserted: 0,
    commissions_skipped_idempotent: 0,
    transfers_succeeded: 0,
    transfers_failed: 0,
    transfers_skipped_no_account: 0,
    total_paid_eur: 0,
    errors: [],
    duration_ms: 0,
  };

  // Aggrège les transfers par sponsor pour le payload Pieuvre
  const transfersMap = new Map<
    string,
    { sponsor_id: string; sponsor_type: string; amount: number; levels: number[] }
  >();

  try {
    // 1) List tous les filleuls qualifiés actifs
    const { data: filleuls, error: filErr } = await supa
      .from('drivers')
      .select('id')
      .eq('qualified_for_referral', true)
      .eq('subscription_active', true);

    if (filErr) throw new Error(`fetch qualified filleuls: ${filErr.message}`);
    if (!filleuls || filleuls.length === 0) {
      console.log('[MlmCron] Aucun filleul qualifié actif ce mois — exit early');
      result.duration_ms = Date.now() - t0;
      return result;
    }

    console.log(
      `[MlmCron] Processing ${filleuls.length} qualified filleul(s) for month ${commissionMonth}`,
    );

    // 2) Pour chaque filleul, remonter 3 niveaux et créer les commissions
    for (const filleul of filleuls) {
      result.qualified_filleuls_processed++;

      let currentDriverId: string = filleul.id;

      for (const level of [1, 2, 3] as const) {
        const sponsor = await findSponsor(supa, currentDriverId);
        if (!sponsor) break;

        // Créer la commission (idempotent)
        const commission = await insertCommissionIdempotent(
          supa,
          sponsor,
          filleul.id,
          level,
          commissionMonth,
        );

        if (!commission) {
          result.commissions_skipped_idempotent++;
        } else {
          result.commissions_inserted++;

          // Verser via Stripe Transfer
          const payRes = await payCommission(
            supa,
            sponsor,
            commission,
            filleul.id,
            commissionMonth,
          );
          if (payRes.ok) {
            result.transfers_succeeded++;
            result.total_paid_eur += commission.amount;
            // Agréger pour le webhook Pieuvre
            const existing = transfersMap.get(sponsor.id);
            if (existing) {
              existing.amount += commission.amount;
              existing.levels.push(level);
            } else {
              transfersMap.set(sponsor.id, {
                sponsor_id: sponsor.id,
                sponsor_type: sponsor.type,
                amount: commission.amount,
                levels: [level],
              });
            }
          } else if (payRes.error === 'no_stripe_account') {
            result.transfers_skipped_no_account++;
          } else {
            result.transfers_failed++;
            result.errors.push(`commission ${commission.id}: ${payRes.error}`);
          }
        }

        // Remonter au niveau suivant : on cherche le sponsor du sponsor
        currentDriverId = sponsor.id;
      }
    }

    // 3) Log dans pieuvre_workflow_logs (audit cross-fil)
    try {
      await supa.from('pieuvre_workflow_logs').insert({
        workflow_name: 'mlm_monthly_payout_cron',
        workflow_id: 'foreas_app_internal',
        status: result.errors.length > 0 ? 'partial_success' : 'success',
        payload_summary: {
          commission_month: commissionMonth,
          qualified_filleuls: result.qualified_filleuls_processed,
          inserted: result.commissions_inserted,
          paid: result.transfers_succeeded,
          total_eur: result.total_paid_eur,
        },
        duration_ms: Date.now() - t0,
        error_message: result.errors.length > 0 ? result.errors.slice(0, 5).join(' | ') : null,
        triggered_at: new Date().toISOString(),
      });
    } catch (logErr) {
      console.warn('[MlmCron] log workflow failed (non-blocking):', logErr);
    }

    // 4) Notifier Pieuvre (fire-and-forget) si au moins 1 transfer a réussi
    if (result.transfers_succeeded > 0) {
      notifyPieuvre('mlm_payout_done', {
        commission_month: commissionMonth,
        transfers: Array.from(transfersMap.values()),
      });
    }
  } catch (err: any) {
    result.ok = false;
    result.errors.push(`FATAL: ${err?.message ?? 'unknown'}`);
    console.error('[MlmCron] fatal error:', err);
  }

  result.duration_ms = Date.now() - t0;
  console.log('[MlmCron] DONE:', result);
  return result;
}
