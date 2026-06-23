/**
 * voiceBudgetMonitor — Budget monitoring + circuit breaker
 * Ajnaya2026v88
 *
 * Thresholds:
 * - 50€/week → log warning
 * - 100€ → Telegram alert
 * - 200€ → critical alert
 * - 300€ → CIRCUIT BREAKER: disable ALL voice calls
 */
import { createClient } from '@supabase/supabase-js';

let supa: any = null;
function getDb() {
  if (!supa) supa = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  return supa;
}

export async function runBudgetCheck(): Promise<{
  weeklySpend: number;
  threshold: string;
  circuitBroken: boolean;
}> {
  const db = getDb();
  console.log('[VoiceBudget] Running budget check...');

  // Calculate week start (Sunday)
  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  weekStart.setHours(0, 0, 0, 0);

  const { data: calls } = await db
    .from('finder_voice_calls')
    .select('cost_estimate_eur')
    .gte('created_at', weekStart.toISOString())
    .not('cost_estimate_eur', 'is', null);

  const weeklySpend = (calls || []).reduce(
    (sum: number, c: any) => sum + (c.cost_estimate_eur || 0),
    0,
  );
  const rounded = Math.round(weeklySpend * 100) / 100;

  let threshold = 'OK';
  let circuitBroken = false;

  if (rounded >= 300) {
    threshold = 'CIRCUIT_BREAKER_300';
    circuitBroken = true;
    console.error(`[VoiceBudget] CIRCUIT BREAKER: ${rounded}€ >= 300€. Disabling ALL voice calls.`);

    // Disable voice_calls_enabled for ALL drivers
    await db
      .from('client_finder_settings')
      .update({
        voice_calls_enabled: false,
        paused_reason: 'BUDGET_CAP_300_EUR',
      })
      .eq('voice_calls_enabled', true);

    // Log analytics event for Telegram alert
    await db
      .from('pieuvre_analytics_events')
      .insert({
        event_type: 'VOICE_BUDGET_CIRCUIT_BREAKER',
        payload: { weeklySpend: rounded, threshold: 300, action: 'ALL_VOICE_DISABLED' },
      })
      .catch(() => {});
  } else if (rounded >= 200) {
    threshold = 'CRITICAL_200';
    console.warn(`[VoiceBudget] CRITICAL: ${rounded}€ >= 200€`);
    await db
      .from('pieuvre_analytics_events')
      .insert({
        event_type: 'VOICE_BUDGET_CRITICAL',
        payload: { weeklySpend: rounded, threshold: 200 },
      })
      .catch(() => {});
  } else if (rounded >= 100) {
    threshold = 'ALERT_100';
    console.warn(`[VoiceBudget] Alert: ${rounded}€ >= 100€`);
    await db
      .from('pieuvre_analytics_events')
      .insert({
        event_type: 'VOICE_BUDGET_ALERT',
        payload: { weeklySpend: rounded, threshold: 100 },
      })
      .catch(() => {});
  } else if (rounded >= 50) {
    threshold = 'WARNING_50';
    console.warn(`[VoiceBudget] Warning: ${rounded}€ >= 50€`);
  }

  console.log(`[VoiceBudget] Weekly spend: ${rounded}€, threshold: ${threshold}`);
  return { weeklySpend: rounded, threshold, circuitBroken };
}
