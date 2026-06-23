/**
 * QualityScoreService — Score qualité chauffeur composite
 * Ajnaya2026v87.1
 *
 * Formule (0-100) :
 *   profile_score       × 0.25   — complétude du profil véhicule
 *   client_feedback     × 0.45   — rating moyen des courses complétées
 *   cancellation_score  × 0.30   — inverse du taux d'annulation (30j)
 *
 * Upsert dans `driver_quality_score` (une ligne par driver_id).
 */

import { getSupabase } from '../lib/supabase.js';

export interface QualityScoreResult {
  driver_id: string;
  profile_score: number; // 0-100
  feedback_score: number; // 0-100
  cancellation_score: number; // 0-100
  composite_score: number; // 0-100
  sample_size: number; // nb courses utilisées
  computed_at: string;
}

// ── Profile completeness ─────────────────────────────────────────
function computeProfileScore(vehicle: any | null): number {
  if (!vehicle) return 0;
  const fields = [
    vehicle.make,
    vehicle.model,
    vehicle.year,
    vehicle.color,
    vehicle.seats,
    vehicle.license_plate,
    vehicle.photo_url,
    vehicle.commercial_name,
  ];
  const filled = fields.filter((f) => f !== null && f !== undefined && f !== '').length;
  const base = (filled / fields.length) * 80; // max 80 sans features
  const featureBonus =
    Array.isArray(vehicle.features) && vehicle.features.length > 0
      ? Math.min(20, vehicle.features.length * 4)
      : 0;
  const validatedBonus = vehicle.is_validated ? 0 : 0; // neutre (pas inclus)
  return Math.min(100, Math.round(base + featureBonus + validatedBonus));
}

// ── Feedback (rating) ─────────────────────────────────────────────
function computeFeedbackScore(rides: Array<{ rating: number | null; status: string }>): {
  score: number;
  sample: number;
} {
  const rated = rides.filter(
    (r) => r.status === 'COMPLETED' && r.rating !== null && r.rating !== undefined,
  );
  if (rated.length === 0) return { score: 70, sample: 0 }; // neutre faute de data
  const avg = rated.reduce((s, r) => s + (r.rating as number), 0) / rated.length;
  // rating ∈ [1, 5] → score ∈ [0, 100]
  const score = Math.max(0, Math.min(100, Math.round(((avg - 1) / 4) * 100)));
  return { score, sample: rated.length };
}

// ── Cancellation (inverse du taux) ────────────────────────────────
function computeCancellationScore(rides: Array<{ status: string }>): number {
  if (rides.length === 0) return 80; // neutre
  const cancelled = rides.filter(
    (r) => r.status === 'CANCELLED' || r.status === 'DRIVER_CANCELLED',
  ).length;
  const rate = cancelled / rides.length; // 0..1
  // 0% annulation → 100, 25% → 0 (pénalité forte)
  const score = Math.max(0, Math.min(100, Math.round((1 - rate / 0.25) * 100)));
  return score;
}

// ── Point d'entrée principal ──────────────────────────────────────
export async function computeQualityScore(driverId: string): Promise<QualityScoreResult> {
  const supa = getSupabase();

  // 1. Profil véhicule
  const { data: vehicle } = await supa
    .from('driver_vehicle_profile')
    .select('*')
    .eq('driver_id', driverId)
    .maybeSingle();
  const profile_score = computeProfileScore(vehicle);

  // 2. Courses récentes (30j)
  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const { data: ridesData } = await supa
    .from('pieuvre_rides')
    .select('rating, status')
    .eq('driver_id', driverId)
    .gte('created_at', cutoff);
  const rides = (ridesData || []) as Array<{ rating: number | null; status: string }>;

  const feedback = computeFeedbackScore(rides);
  const cancellation_score = computeCancellationScore(rides);

  // 3. Score composite pondéré
  const composite = profile_score * 0.25 + feedback.score * 0.45 + cancellation_score * 0.3;

  const result: QualityScoreResult = {
    driver_id: driverId,
    profile_score,
    feedback_score: feedback.score,
    cancellation_score,
    composite_score: Math.round(composite),
    sample_size: rides.length,
    computed_at: new Date().toISOString(),
  };

  // 4. Upsert best-effort (la table peut ne pas exister en dev)
  try {
    await supa.from('driver_quality_score').upsert(
      {
        driver_id: driverId,
        profile_score: result.profile_score,
        feedback_score: result.feedback_score,
        cancellation_score: result.cancellation_score,
        composite_score: result.composite_score,
        sample_size: result.sample_size,
        computed_at: result.computed_at,
      },
      { onConflict: 'driver_id' },
    );
  } catch (err: any) {
    console.warn('[QualityScore] upsert error:', err?.message);
  }

  return result;
}

// ── Batch (à appeler en cron hebdo) ──────────────────────────────
export async function computeQualityScoresBatch(): Promise<number> {
  const supa = getSupabase();
  const { data: drivers } = await supa
    .from('client_finder_settings')
    .select('driver_id')
    .eq('enabled', true);

  if (!drivers || drivers.length === 0) return 0;

  let count = 0;
  for (const row of drivers as Array<{ driver_id: string }>) {
    try {
      await computeQualityScore(row.driver_id);
      count++;
    } catch (err: any) {
      console.warn(`[QualityScore] batch error ${row.driver_id}:`, err?.message);
    }
  }
  console.log(`[QualityScore] Batch completed: ${count}/${drivers.length} scored`);
  return count;
}
