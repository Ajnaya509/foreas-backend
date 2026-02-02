/**
 * FOREAS Data Platform V1 - Outcomes Timeout Job
 * ===============================================
 * Marque les outcomes "pending" > 24h comme "ignored".
 *
 * RÈGLE: Chaque reco DOIT produire un outcome.
 * - reco.shown → outcome = pending
 * - feedback user → accepted / rejected
 * - timeout 24h → ignored
 */

import { getSupabaseAdmin } from '../helpers/supabase';
import { trackEventAsync } from '../data/eventStore';

const TIMEOUT_HOURS = 24;

/**
 * Run outcomes timeout job
 * Marks pending outcomes older than 24h as "ignored"
 */
export async function runOutcomesTimeoutJob(): Promise<{
  processed: number;
  updated: number;
  errors: number;
}> {
  const supabase = getSupabaseAdmin();
  const startTime = Date.now();

  console.log('[OutcomesTimeout] Starting timeout job...');

  const timeoutDate = new Date(Date.now() - TIMEOUT_HOURS * 60 * 60 * 1000);

  // Find pending outcomes older than timeout
  const { data: pendingOutcomes, error: fetchError } = await supabase
    .from('ai_outcomes')
    .select('id, driver_id, action_recommended')
    .eq('outcome_type', 'unknown')
    .lt('created_at', timeoutDate.toISOString());

  if (fetchError) {
    console.error('[OutcomesTimeout] Error fetching pending outcomes:', fetchError);
    return { processed: 0, updated: 0, errors: 1 };
  }

  if (!pendingOutcomes || pendingOutcomes.length === 0) {
    console.log('[OutcomesTimeout] No pending outcomes to timeout');
    return { processed: 0, updated: 0, errors: 0 };
  }

  console.log(`[OutcomesTimeout] Found ${pendingOutcomes.length} outcomes to timeout`);

  let updated = 0;
  let errors = 0;

  // Update in batches
  const batchSize = 100;
  for (let i = 0; i < pendingOutcomes.length; i += batchSize) {
    const batch = pendingOutcomes.slice(i, i + batchSize);
    const ids = batch.map(o => o.id);

    const { error: updateError } = await supabase
      .from('ai_outcomes')
      .update({
        outcome_type: 'ignored',
        updated_at: new Date().toISOString(),
      })
      .in('id', ids);

    if (updateError) {
      console.error(`[OutcomesTimeout] Error updating batch ${i}:`, updateError);
      errors += batch.length;
    } else {
      updated += batch.length;
    }
  }

  const duration = Date.now() - startTime;

  // Track job completion
  trackEventAsync({
    eventName: 'outcome.feedback',
    eventCategory: 'recommendation',
    actorRole: 'system',
    payload: {
      job_type: 'timeout',
      processed: pendingOutcomes.length,
      updated,
      errors,
      duration_ms: duration,
    },
  });

  console.log(`[OutcomesTimeout] Completed in ${duration}ms: ${updated} updated, ${errors} errors`);

  return {
    processed: pendingOutcomes.length,
    updated,
    errors,
  };
}

export default runOutcomesTimeoutJob;
