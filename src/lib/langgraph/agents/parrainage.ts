// src/lib/langgraph/agents/parrainage.ts
import { supabase } from '../supabase';
import type { AjnayaStateType } from '../state';

export async function parrainageAgent(state: AjnayaStateType): Promise<Partial<AjnayaStateType>> {
  if (!state.isSubscriber || state.daysSinceSubscription <= 14) {
    return { referralResult: { totalReferrals: 0, monthlyEarnings: 0, isGoodMoment: false } };
  }

  try {
    // 1. Compter les filleuls actifs
    const { count: totalReferrals } = await supabase
      .from('referrals')
      .select('*', { count: 'exact', head: true })
      .eq('sponsor_id', state.driverId!)
      .eq('status', 'active');

    // 2. Verifier le cooldown (pas de proposition parrainage dans les 7 derniers jours)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { count: recentCampaigns } = await supabase
      .from('pieuvre_referral_campaigns')
      .select('*', { count: 'exact', head: true })
      .eq('driver_id', state.driverId!)
      .gte('created_at', sevenDaysAgo);

    const cooldownOk = (recentCampaigns || 0) === 0;
    const isGoodMoment = cooldownOk && state.daysSinceSubscription > 14;
    const monthlyEarnings = (totalReferrals || 0) * 10;

    return {
      referralResult: {
        totalReferrals: totalReferrals || 0,
        monthlyEarnings,
        isGoodMoment,
      },
    };
  } catch (error: any) {
    return {
      referralResult: { totalReferrals: 0, monthlyEarnings: 0, isGoodMoment: false },
      errors: [{ agent: 'parrainage', error: error.message }],
    };
  }
}
