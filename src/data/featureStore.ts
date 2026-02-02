/**
 * FOREAS Data Platform V1 - Feature Store
 * =======================================
 * Driver feature snapshots for ML personalization.
 * Tables: public.driver_features
 *
 * RÈGLES:
 * - Snapshots immutables (append-only)
 * - Contexte de personnalisation pour LLM
 * - Support daily/weekly/realtime/manual snapshots
 */

import { getSupabaseAdmin } from '../helpers/supabase';
import type {
  DriverFeatures,
  DriverFlags,
  DriverFeaturesSnapshot,
  SaveFeaturesInput,
  SnapshotType,
} from './types';

// ============================================
// FEATURE RETRIEVAL
// ============================================

/**
 * Get latest features for a driver
 */
export async function getDriverFeatures(
  driverId: string,
  snapshotType?: SnapshotType
): Promise<DriverFeaturesSnapshot | null> {
  const supabase = getSupabaseAdmin();

  let query = supabase
    .from('driver_features')
    .select()
    .eq('driver_id', driverId)
    .order('computed_at', { ascending: false })
    .limit(1);

  if (snapshotType) {
    query = query.eq('snapshot_type', snapshotType);
  }

  const { data, error } = await query.maybeSingle();

  if (error) {
    console.error('[FeatureStore] Get features failed:', error.message);
    throw new Error(`Failed to get driver features: ${error.message}`);
  }

  return data as DriverFeaturesSnapshot | null;
}

/**
 * Get merged features and flags for LLM context
 */
export async function getDriverContext(driverId: string): Promise<{
  features: DriverFeatures;
  flags: DriverFlags;
  snapshotId: string | null;
  computedAt: string | null;
}> {
  const snapshot = await getDriverFeatures(driverId);

  if (!snapshot) {
    return {
      features: {},
      flags: {},
      snapshotId: null,
      computedAt: null,
    };
  }

  return {
    features: snapshot.features,
    flags: snapshot.flags,
    snapshotId: snapshot.id,
    computedAt: snapshot.computed_at,
  };
}

// ============================================
// FEATURE STORAGE
// ============================================

/**
 * Save a features snapshot
 */
export async function saveFeatures(input: SaveFeaturesInput): Promise<DriverFeaturesSnapshot> {
  const supabase = getSupabaseAdmin();

  const snapshotData = {
    driver_id: input.driverId,
    snapshot_type: input.snapshotType || 'manual',
    features: input.features,
    flags: input.flags || {},
    computed_at: new Date().toISOString(),
    valid_until: input.validUntil?.toISOString() || null,
  };

  const { data, error } = await supabase
    .from('driver_features')
    .insert(snapshotData)
    .select()
    .single();

  if (error) {
    console.error('[FeatureStore] Save features failed:', error.message);
    throw new Error(`Failed to save features: ${error.message}`);
  }

  console.log(`[FeatureStore] Saved ${input.snapshotType} snapshot for driver ${input.driverId}`);
  return data as DriverFeaturesSnapshot;
}

// ============================================
// FEATURE COMPUTATION (Stubs for future jobs)
// ============================================

/**
 * Compute features from raw data (stub)
 * TODO: Connect to real data sources
 */
export async function computeDriverFeatures(driverId: string): Promise<DriverFeatures> {
  // Placeholder - would aggregate from trips, ratings, earnings, etc.
  console.log(`[FeatureStore] Computing features for driver ${driverId}`);

  // Return demo features for now
  return {
    total_trips: 0,
    trips_last_7d: 0,
    trips_last_30d: 0,
    avg_rating: 0,
    acceptance_rate: 0,
    cancellation_rate: 0,
    avg_earnings_per_hour: 0,
    total_earnings_30d: 0,
    peak_hours: [],
    top_zones: [],
    preferred_platforms: [],
    fatigue_score: 0,
    days_since_last_trip: 999,
    subscription_status: 'unknown',
  };
}

/**
 * Compute flags from features (rule-based)
 */
export function computeDriverFlags(features: DriverFeatures): DriverFlags {
  const flags: DriverFlags = {};

  // New driver: less than 10 total trips
  flags.is_new_driver = (features.total_trips || 0) < 10;

  // Needs onboarding: new driver or no recent activity
  flags.needs_onboarding = flags.is_new_driver || (features.trips_last_7d || 0) === 0;

  // High performer: high rating + high acceptance
  flags.high_performer =
    (features.avg_rating || 0) >= 4.8 && (features.acceptance_rate || 0) >= 0.9;

  // At risk of churn: no activity in 7+ days
  flags.at_risk_churn = (features.days_since_last_trip || 999) >= 7;

  // Needs attention: low rating or high cancellation
  flags.needs_attention =
    (features.avg_rating || 0) < 4.5 || (features.cancellation_rate || 0) > 0.1;

  return flags;
}

/**
 * Refresh driver features (compute + save)
 */
export async function refreshDriverFeatures(
  driverId: string,
  snapshotType: SnapshotType = 'manual'
): Promise<DriverFeaturesSnapshot> {
  const features = await computeDriverFeatures(driverId);
  const flags = computeDriverFlags(features);

  // Calculate validity period based on snapshot type
  let validUntil: Date | undefined;
  if (snapshotType === 'daily') {
    validUntil = new Date();
    validUntil.setDate(validUntil.getDate() + 1);
  } else if (snapshotType === 'weekly') {
    validUntil = new Date();
    validUntil.setDate(validUntil.getDate() + 7);
  } else if (snapshotType === 'realtime') {
    validUntil = new Date();
    validUntil.setMinutes(validUntil.getMinutes() + 5); // 5 min validity
  }

  return saveFeatures({
    driverId,
    snapshotType,
    features,
    flags,
    validUntil,
  });
}

// ============================================
// FEATURE HISTORY
// ============================================

/**
 * Get feature history for a driver
 */
export async function getFeatureHistory(
  driverId: string,
  options: { limit?: number; snapshotType?: SnapshotType } = {}
): Promise<DriverFeaturesSnapshot[]> {
  const supabase = getSupabaseAdmin();

  let query = supabase
    .from('driver_features')
    .select()
    .eq('driver_id', driverId)
    .order('computed_at', { ascending: false });

  if (options.snapshotType) {
    query = query.eq('snapshot_type', options.snapshotType);
  }

  if (options.limit) {
    query = query.limit(options.limit);
  }

  const { data, error } = await query;

  if (error) {
    console.error('[FeatureStore] Get history failed:', error.message);
    throw new Error(`Failed to get feature history: ${error.message}`);
  }

  return data as DriverFeaturesSnapshot[];
}

// ============================================
// LLM CONTEXT BUILDER
// ============================================

/**
 * Build a context summary string for LLM prompts
 */
export async function buildContextSummary(driverId: string): Promise<string> {
  const { features, flags } = await getDriverContext(driverId);

  const lines: string[] = [];

  // Activity level
  if (flags.is_new_driver) {
    lines.push('- Nouveau chauffeur (moins de 10 courses)');
  } else if (features.total_trips) {
    lines.push(`- Chauffeur expérimenté (${features.total_trips} courses au total)`);
  }

  // Recent activity
  if (features.trips_last_7d !== undefined) {
    if (features.trips_last_7d === 0) {
      lines.push('- Aucune course cette semaine');
    } else {
      lines.push(`- ${features.trips_last_7d} courses cette semaine`);
    }
  }

  // Performance
  if (features.avg_rating) {
    lines.push(`- Note moyenne: ${features.avg_rating.toFixed(1)}/5`);
  }

  if (features.acceptance_rate) {
    lines.push(`- Taux d'acceptation: ${(features.acceptance_rate * 100).toFixed(0)}%`);
  }

  // Earnings
  if (features.avg_earnings_per_hour) {
    lines.push(`- Revenu horaire moyen: ${features.avg_earnings_per_hour.toFixed(0)}€/h`);
  }

  // Patterns
  if (features.peak_hours?.length) {
    lines.push(`- Heures de pointe préférées: ${features.peak_hours.join(', ')}`);
  }

  if (features.top_zones?.length) {
    lines.push(`- Zones favorites: ${features.top_zones.slice(0, 3).join(', ')}`);
  }

  // Status flags
  if (flags.high_performer) {
    lines.push('- Chauffeur performant');
  }

  if (flags.at_risk_churn) {
    lines.push('- Attention: inactivité prolongée');
  }

  return lines.length > 0 ? lines.join('\n') : 'Données insuffisantes';
}
