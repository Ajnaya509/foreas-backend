/**
 * FOREAS Data Platform V1 - Daily Features Job
 * =============================================
 * Calcule les features quotidiennes pour tous les drivers actifs.
 *
 * RÈGLES:
 * - NO EVENT → NO FEATURE (fail fast)
 * - Snapshots immuables
 * - Anti-duplication via unique constraint
 *
 * DÉCLENCHEMENT:
 * - Cron: 04:00 UTC daily
 * - Admin: POST /api/admin/jobs/features
 */

import { getSupabaseAdmin } from '../helpers/supabase';
import { trackEventAsync } from '../data/eventStore';

// ============================================
// TYPES
// ============================================

interface DriverFeatures {
  // Activity
  total_trips: number;
  trips_last_7d: number;
  trips_last_30d: number;
  days_since_last_trip: number;

  // Performance
  acceptance_rate_7d: number;
  rejection_rate_7d: number;
  ignored_rate_7d: number;

  // Earnings (anonymized)
  avg_earnings_per_trip: number;
  earnings_trend_7d: 'up' | 'down' | 'stable';

  // Engagement
  sessions_last_7d: number;
  avg_session_duration_min: number;
  ai_interactions_7d: number;

  // Subscription
  subscription_status: 'active' | 'trial' | 'expired' | 'none';
  days_since_signup: number;

  // Risk
  churn_risk_score: number; // 0-100
}

interface DriverFlags {
  is_new_driver: boolean;
  needs_onboarding: boolean;
  high_performer: boolean;
  at_risk_churn: boolean;
  low_engagement: boolean;
}

interface ComputeResult {
  driver_id: string;
  features: DriverFeatures;
  flags: DriverFlags;
  events_count: number;
}

// ============================================
// FEATURE COMPUTATION
// ============================================

/**
 * Compute features for a single driver
 */
export async function computeDriverFeatures(driverId: string): Promise<ComputeResult | null> {
  const supabase = getSupabaseAdmin();
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  // Fetch events for this driver
  const { data: events, error: eventsError } = await supabase
    .from('events')
    .select('event_name, payload, created_at')
    .eq('actor_id', driverId)
    .gte('created_at', thirtyDaysAgo.toISOString())
    .order('created_at', { ascending: false });

  if (eventsError) {
    console.error(`[DailyFeatures] Error fetching events for ${driverId}:`, eventsError);
    return null;
  }

  // NO EVENT → NO FEATURE
  if (!events || events.length === 0) {
    console.log(`[DailyFeatures] No events for ${driverId}, skipping`);
    return null;
  }

  // Parse events
  const events7d = events.filter(e => new Date(e.created_at) >= sevenDaysAgo);

  // Count by event type
  const tripEvents = events.filter(e => e.event_name === 'earnings.trip_completed');
  const trips7d = tripEvents.filter(e => new Date(e.created_at) >= sevenDaysAgo);

  const recoShown = events7d.filter(e => e.event_name === 'reco.shown');
  const recoAccepted = events7d.filter(e => e.event_name === 'reco.accepted');
  const recoRejected = events7d.filter(e => e.event_name === 'reco.rejected');
  const recoIgnored = events7d.filter(e => e.event_name === 'reco.ignored');

  const sessions = events7d.filter(e => e.event_name === 'session.started');
  const aiChats = events7d.filter(e =>
    e.event_name.startsWith('reco.') || e.event_name === 'features.refreshed'
  );

  // Calculate rates
  const totalRecos = recoShown.length || 1; // avoid division by zero
  const acceptanceRate = recoAccepted.length / totalRecos;
  const rejectionRate = recoRejected.length / totalRecos;
  const ignoredRate = recoIgnored.length / totalRecos;

  // Days since last trip
  const lastTripDate = tripEvents[0]?.created_at;
  const daysSinceLastTrip = lastTripDate
    ? Math.floor((now.getTime() - new Date(lastTripDate).getTime()) / (24 * 60 * 60 * 1000))
    : 999;

  // Earnings (from payload, anonymized)
  const earnings = tripEvents
    .map(e => (e.payload as any)?.amount || 0)
    .filter(a => a > 0);
  const avgEarnings = earnings.length > 0
    ? earnings.reduce((sum: number, a: number) => sum + a, 0) / earnings.length
    : 0;

  // Earnings trend
  const earnings7dTotal = trips7d
    .map(e => (e.payload as any)?.amount || 0)
    .reduce((sum: number, a: number) => sum + a, 0);
  const earningsPrev7d = tripEvents
    .filter(e => {
      const d = new Date(e.created_at);
      return d < sevenDaysAgo && d >= new Date(sevenDaysAgo.getTime() - 7 * 24 * 60 * 60 * 1000);
    })
    .map(e => (e.payload as any)?.amount || 0)
    .reduce((sum: number, a: number) => sum + a, 0);

  let earningsTrend: 'up' | 'down' | 'stable' = 'stable';
  if (earnings7dTotal > earningsPrev7d * 1.1) earningsTrend = 'up';
  if (earnings7dTotal < earningsPrev7d * 0.9) earningsTrend = 'down';

  // Session duration (estimate from session events)
  const avgSessionDuration = sessions.length > 0 ? 15 : 0; // placeholder, needs session.ended events

  // Get subscription status from Supabase
  const { data: driver } = await supabase
    .from('drivers')
    .select('created_at, subscription_status')
    .eq('id', driverId)
    .single();

  const daysSinceSignup = driver?.created_at
    ? Math.floor((now.getTime() - new Date(driver.created_at).getTime()) / (24 * 60 * 60 * 1000))
    : 0;

  const subscriptionStatus = (driver?.subscription_status as any) || 'none';

  // Churn risk score (simple heuristic V1)
  let churnRiskScore = 0;
  if (daysSinceLastTrip > 14) churnRiskScore += 30;
  if (daysSinceLastTrip > 7) churnRiskScore += 20;
  if (sessions.length < 2) churnRiskScore += 20;
  if (ignoredRate > 0.5) churnRiskScore += 15;
  if (rejectionRate > 0.3) churnRiskScore += 15;
  churnRiskScore = Math.min(100, churnRiskScore);

  // Build features
  const features: DriverFeatures = {
    total_trips: tripEvents.length,
    trips_last_7d: trips7d.length,
    trips_last_30d: tripEvents.length,
    days_since_last_trip: daysSinceLastTrip,

    acceptance_rate_7d: Math.round(acceptanceRate * 100) / 100,
    rejection_rate_7d: Math.round(rejectionRate * 100) / 100,
    ignored_rate_7d: Math.round(ignoredRate * 100) / 100,

    avg_earnings_per_trip: Math.round(avgEarnings * 100) / 100,
    earnings_trend_7d: earningsTrend,

    sessions_last_7d: sessions.length,
    avg_session_duration_min: avgSessionDuration,
    ai_interactions_7d: aiChats.length,

    subscription_status: subscriptionStatus,
    days_since_signup: daysSinceSignup,

    churn_risk_score: churnRiskScore,
  };

  // Build flags
  const flags: DriverFlags = {
    is_new_driver: daysSinceSignup < 14,
    needs_onboarding: daysSinceSignup < 7 && tripEvents.length < 3,
    high_performer: acceptanceRate > 0.8 && trips7d.length >= 5,
    at_risk_churn: churnRiskScore >= 50,
    low_engagement: sessions.length < 2 && aiChats.length < 2,
  };

  return {
    driver_id: driverId,
    features,
    flags,
    events_count: events.length,
  };
}

/**
 * Save feature snapshot to Supabase
 */
export async function saveFeatureSnapshot(
  driverId: string,
  features: DriverFeatures,
  flags: DriverFlags,
  snapshotType: 'daily' | 'weekly' | 'manual' = 'daily'
): Promise<string | null> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from('driver_features')
    .insert({
      driver_id: driverId,
      snapshot_type: snapshotType,
      features,
      flags,
      computed_at: new Date().toISOString(),
      valid_until: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24h
    })
    .select('id')
    .single();

  if (error) {
    console.error(`[DailyFeatures] Error saving snapshot for ${driverId}:`, error);
    return null;
  }

  return data.id;
}

/**
 * Run daily features job for all active drivers
 */
export async function runDailyFeaturesJob(): Promise<{
  processed: number;
  success: number;
  skipped: number;
  errors: number;
}> {
  const supabase = getSupabaseAdmin();
  const startTime = Date.now();

  console.log('[DailyFeatures] Starting daily job...');

  // Get all drivers with events in last 30 days
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const { data: activeDrivers, error: driversError } = await supabase
    .from('events')
    .select('actor_id')
    .not('actor_id', 'is', null)
    .gte('created_at', thirtyDaysAgo.toISOString())
    .order('actor_id');

  if (driversError) {
    console.error('[DailyFeatures] Error fetching active drivers:', driversError);
    return { processed: 0, success: 0, skipped: 0, errors: 1 };
  }

  // Dedupe driver IDs
  const driverIds = [...new Set(activeDrivers.map(d => d.actor_id))];

  console.log(`[DailyFeatures] Processing ${driverIds.length} active drivers...`);

  let success = 0;
  let skipped = 0;
  let errors = 0;

  for (const driverId of driverIds) {
    try {
      const result = await computeDriverFeatures(driverId);

      if (!result) {
        skipped++;
        continue;
      }

      const snapshotId = await saveFeatureSnapshot(
        driverId,
        result.features,
        result.flags,
        'daily'
      );

      if (snapshotId) {
        success++;
      } else {
        errors++;
      }
    } catch (err) {
      console.error(`[DailyFeatures] Error processing ${driverId}:`, err);
      errors++;
    }
  }

  const duration = Date.now() - startTime;

  // Track job completion event
  trackEventAsync({
    eventName: 'features.refreshed',
    eventCategory: 'recommendation',
    actorRole: 'system',
    payload: {
      job_type: 'daily',
      processed: driverIds.length,
      success,
      skipped,
      errors,
      duration_ms: duration,
    },
  });

  console.log(`[DailyFeatures] Completed in ${duration}ms: ${success} success, ${skipped} skipped, ${errors} errors`);

  return {
    processed: driverIds.length,
    success,
    skipped,
    errors,
  };
}

export default runDailyFeaturesJob;
