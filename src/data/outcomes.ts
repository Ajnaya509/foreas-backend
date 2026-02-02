/**
 * FOREAS Data Platform V1 - Outcomes
 * ==================================
 * Ground truth labels for ML training.
 * Tables: public.ai_outcomes
 *
 * RÈGLES:
 * - Lie recommandation → action réelle
 * - Calcul delta (earnings, time saved)
 * - Feedback utilisateur
 */

import { getSupabaseAdmin } from '../helpers/supabase';
import type { RecordOutcomeInput, Outcome, OutcomeType, UserFeedback } from './types';

// ============================================
// OUTCOME RECORDING
// ============================================

/**
 * Record an AI recommendation outcome
 */
export async function recordOutcome(input: RecordOutcomeInput): Promise<Outcome> {
  const supabase = getSupabaseAdmin();

  const outcomeData = {
    conversation_id: input.conversationId || null,
    message_id: input.messageId || null,
    driver_id: input.driverId,
    action_recommended: input.actionRecommended,
    action_taken: input.actionTaken || null,
    action_taken_at: input.actionTakenAt?.toISOString() || null,
    outcome_type: input.outcomeType,
    delta_metric: input.deltaMetric || null,
    confidence: input.confidence || null,
    user_feedback: input.userFeedback || null,
    user_feedback_text: input.userFeedbackText || null,
  };

  const { data, error } = await supabase
    .from('ai_outcomes')
    .insert(outcomeData)
    .select()
    .single();

  if (error) {
    console.error('[Outcomes] Record failed:', error.message);
    throw new Error(`Failed to record outcome: ${error.message}`);
  }

  console.log(`[Outcomes] Recorded ${input.outcomeType} for ${input.actionRecommended}`);
  return data as Outcome;
}

/**
 * Record outcome without waiting (async)
 */
export function recordOutcomeAsync(input: RecordOutcomeInput): void {
  recordOutcome(input).catch((err) => {
    console.error('[Outcomes] Async record failed:', err);
  });
}

// ============================================
// OUTCOME UPDATES
// ============================================

/**
 * Update outcome when user takes action
 */
export async function updateOutcomeAction(
  outcomeId: string,
  actionTaken: string,
  deltaMetric?: Record<string, number>
): Promise<void> {
  const supabase = getSupabaseAdmin();

  const { error } = await supabase
    .from('ai_outcomes')
    .update({
      action_taken: actionTaken,
      action_taken_at: new Date().toISOString(),
      outcome_type: determineOutcomeType(actionTaken),
      delta_metric: deltaMetric || undefined,
      updated_at: new Date().toISOString(),
    })
    .eq('id', outcomeId);

  if (error) {
    console.error('[Outcomes] Update action failed:', error.message);
    throw new Error(`Failed to update outcome action: ${error.message}`);
  }

  console.log(`[Outcomes] Updated outcome ${outcomeId} with action: ${actionTaken}`);
}

/**
 * Add user feedback to outcome
 */
export async function addOutcomeFeedback(
  outcomeId: string,
  feedback: UserFeedback,
  feedbackText?: string
): Promise<void> {
  const supabase = getSupabaseAdmin();

  const { error } = await supabase
    .from('ai_outcomes')
    .update({
      user_feedback: feedback,
      user_feedback_text: feedbackText || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', outcomeId);

  if (error) {
    console.error('[Outcomes] Add feedback failed:', error.message);
    throw new Error(`Failed to add feedback: ${error.message}`);
  }

  console.log(`[Outcomes] Added ${feedback} feedback to outcome ${outcomeId}`);
}

// ============================================
// OUTCOME QUERIES
// ============================================

export interface OutcomeQueryOptions {
  driverId?: string;
  conversationId?: string;
  outcomeType?: OutcomeType;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
}

/**
 * Query outcomes
 */
export async function queryOutcomes(options: OutcomeQueryOptions): Promise<Outcome[]> {
  const supabase = getSupabaseAdmin();

  let query = supabase
    .from('ai_outcomes')
    .select()
    .order('created_at', { ascending: false });

  if (options.driverId) {
    query = query.eq('driver_id', options.driverId);
  }

  if (options.conversationId) {
    query = query.eq('conversation_id', options.conversationId);
  }

  if (options.outcomeType) {
    query = query.eq('outcome_type', options.outcomeType);
  }

  if (options.startDate) {
    query = query.gte('created_at', options.startDate.toISOString());
  }

  if (options.endDate) {
    query = query.lte('created_at', options.endDate.toISOString());
  }

  if (options.limit) {
    query = query.limit(options.limit);
  }

  if (options.offset) {
    query = query.range(options.offset, options.offset + (options.limit || 50) - 1);
  }

  const { data, error } = await query;

  if (error) {
    console.error('[Outcomes] Query failed:', error.message);
    throw new Error(`Failed to query outcomes: ${error.message}`);
  }

  return data as Outcome[];
}

/**
 * Get outcomes for a driver
 */
export async function getDriverOutcomes(
  driverId: string,
  limit = 50
): Promise<Outcome[]> {
  return queryOutcomes({ driverId, limit });
}

/**
 * Get outcome by ID
 */
export async function getOutcome(outcomeId: string): Promise<Outcome | null> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from('ai_outcomes')
    .select()
    .eq('id', outcomeId)
    .maybeSingle();

  if (error) {
    console.error('[Outcomes] Get failed:', error.message);
    throw new Error(`Failed to get outcome: ${error.message}`);
  }

  return data as Outcome | null;
}

// ============================================
// OUTCOME ANALYTICS
// ============================================

export interface OutcomeStats {
  totalOutcomes: number;
  accepted: number;
  rejected: number;
  ignored: number;
  partial: number;
  unknown: number;
  acceptanceRate: number;
  avgConfidence: number | null;
  feedbackCount: {
    helpful: number;
    not_helpful: number;
    neutral: number;
  };
}

/**
 * Get outcome statistics for a driver
 */
export async function getOutcomeStats(driverId: string): Promise<OutcomeStats> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from('ai_outcomes')
    .select('outcome_type, confidence, user_feedback')
    .eq('driver_id', driverId);

  if (error) {
    console.error('[Outcomes] Get stats failed:', error.message);
    throw new Error(`Failed to get outcome stats: ${error.message}`);
  }

  const stats: OutcomeStats = {
    totalOutcomes: data.length,
    accepted: 0,
    rejected: 0,
    ignored: 0,
    partial: 0,
    unknown: 0,
    acceptanceRate: 0,
    avgConfidence: null,
    feedbackCount: {
      helpful: 0,
      not_helpful: 0,
      neutral: 0,
    },
  };

  let confidenceSum = 0;
  let confidenceCount = 0;

  for (const outcome of data) {
    // Count by outcome type
    switch (outcome.outcome_type) {
      case 'accepted':
        stats.accepted++;
        break;
      case 'rejected':
        stats.rejected++;
        break;
      case 'ignored':
        stats.ignored++;
        break;
      case 'partial':
        stats.partial++;
        break;
      default:
        stats.unknown++;
    }

    // Sum confidence
    if (outcome.confidence !== null) {
      confidenceSum += outcome.confidence;
      confidenceCount++;
    }

    // Count feedback
    if (outcome.user_feedback === 'helpful') {
      stats.feedbackCount.helpful++;
    } else if (outcome.user_feedback === 'not_helpful') {
      stats.feedbackCount.not_helpful++;
    } else if (outcome.user_feedback === 'neutral') {
      stats.feedbackCount.neutral++;
    }
  }

  // Calculate rates
  const actionableOutcomes = stats.accepted + stats.rejected + stats.partial;
  if (actionableOutcomes > 0) {
    stats.acceptanceRate = (stats.accepted + stats.partial) / actionableOutcomes;
  }

  if (confidenceCount > 0) {
    stats.avgConfidence = confidenceSum / confidenceCount;
  }

  return stats;
}

/**
 * Get delta metrics summary for a driver
 */
export async function getDeltaMetricsSummary(driverId: string): Promise<{
  totalEarningsChange: number;
  totalTimeSavedMin: number;
  outcomesWithMetrics: number;
}> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from('ai_outcomes')
    .select('delta_metric')
    .eq('driver_id', driverId)
    .not('delta_metric', 'is', null);

  if (error) {
    console.error('[Outcomes] Get delta metrics failed:', error.message);
    throw new Error(`Failed to get delta metrics: ${error.message}`);
  }

  let totalEarningsChange = 0;
  let totalTimeSavedMin = 0;
  let outcomesWithMetrics = 0;

  for (const outcome of data) {
    if (outcome.delta_metric) {
      outcomesWithMetrics++;
      totalEarningsChange += outcome.delta_metric.earnings_change || 0;
      totalTimeSavedMin += outcome.delta_metric.time_saved_min || 0;
    }
  }

  return {
    totalEarningsChange,
    totalTimeSavedMin,
    outcomesWithMetrics,
  };
}

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Determine outcome type from action taken
 */
function determineOutcomeType(actionTaken: string): OutcomeType {
  const lower = actionTaken.toLowerCase();

  if (lower.includes('accept') || lower.includes('follow') || lower.includes('start')) {
    return 'accepted';
  }

  if (lower.includes('reject') || lower.includes('cancel') || lower.includes('decline')) {
    return 'rejected';
  }

  if (lower.includes('partial') || lower.includes('modify') || lower.includes('change')) {
    return 'partial';
  }

  return 'unknown';
}

// ============================================
// CONVENIENCE HELPERS
// ============================================

/**
 * Record a navigation recommendation outcome
 */
export function recordNavigationOutcome(
  driverId: string,
  recommendedDestination: string,
  options: {
    conversationId?: string;
    messageId?: string;
    confidence?: number;
  } = {}
): void {
  recordOutcomeAsync({
    driverId,
    conversationId: options.conversationId,
    messageId: options.messageId,
    actionRecommended: `navigate_to:${recommendedDestination}`,
    outcomeType: 'unknown', // Will be updated when action is taken
    confidence: options.confidence,
  });
}

/**
 * Record zone recommendation outcome
 */
export function recordZoneOutcome(
  driverId: string,
  recommendedZone: string,
  options: {
    conversationId?: string;
    messageId?: string;
    confidence?: number;
  } = {}
): void {
  recordOutcomeAsync({
    driverId,
    conversationId: options.conversationId,
    messageId: options.messageId,
    actionRecommended: `go_to_zone:${recommendedZone}`,
    outcomeType: 'unknown',
    confidence: options.confidence,
  });
}
