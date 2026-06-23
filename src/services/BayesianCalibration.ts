/**
 * BayesianCalibration — S7
 * ============================================================
 * Couche bayésienne multi-niveau qui combine :
 *   1. Calibration PERSONNELLE du chauffeur (P40 €/h sur 60 dernières courses)
 *   2. Calibration COLLECTIVE anonymisée (médiane de la cohorte
 *      ville × véhicule × zone × heure, min 3 samples)
 *   3. Fallback CITY_PROFILE (valeurs de référence par ville)
 *
 * Poids adaptatif selon la quantité de données personnelles :
 *   - 0-10 samples perso  : 80% collectif / 20% perso (cold start)
 *   - 10-30 samples       : 50% / 50% (transition)
 *   - 30-60 samples       : 30% collectif / 70% perso
 *   - 60+ samples         : 10% / 90% (chauffeur expérimenté)
 *
 * Objectif : dès le 1er jour du chauffeur, utiliser la sagesse de la
 * cohorte. Au fur et à mesure qu'il roule, on bascule vers sa propre
 * signature. Pas de cold-start dégueulasse.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { CityProfile, VehicleCategory } from './CityProfileCache.js';
import {
  getEurHourRef as cityGetEurHourRef,
  getAcceptThreshold as cityGetAcceptThreshold,
} from './CityProfileCache.js';

// ── Supabase lazy client ─────────────────────────────────────────

let _supa: SupabaseClient | null = null;
function getSupa(): SupabaseClient | null {
  if (_supa) return _supa;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  _supa = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  return _supa;
}

// ── Types ────────────────────────────────────────────────────────

export interface BayesianInput {
  driverId: string;
  vehicleCategory: VehicleCategory;
  cityProfile: CityProfile;
  h3Zone: string;
  hourSlot: number;
}

export interface BayesianOutput {
  /** €/h de référence bayésien (blended perso + collectif + city) */
  eurHourRef: number;
  /** Seuil ACCEPT (score 0-100) bayésien */
  acceptThreshold: number;
  /** Confiance 0-1 du calcul (basée sur nb samples combinés) */
  confidence: number;
  /** Composantes détaillées pour debug */
  breakdown: {
    personalEurHour: number | null;
    personalSamples: number;
    collectiveEurHour: number | null;
    collectiveSamples: number;
    cityBaselineEurHour: number;
    weightPersonal: number;
    weightCollective: number;
    weightCity: number;
  };
}

// ── Cache mémoire (TTL 5 min pour calibration, renouvelée si plus vieux)
const calibrationCache = new Map<string, { output: BayesianOutput; computedAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Calcule la calibration bayésienne pour un chauffeur dans un contexte
 * (h3_zone × hour_slot). Met en cache 5 min.
 */
export async function getBayesianCalibration(input: BayesianInput): Promise<BayesianOutput> {
  const cacheKey = `${input.driverId}|${input.vehicleCategory}|${input.h3Zone}|${input.hourSlot}`;
  const cached = calibrationCache.get(cacheKey);
  if (cached && Date.now() - cached.computedAt < CACHE_TTL_MS) {
    return cached.output;
  }

  const output = await computeCalibration(input);
  calibrationCache.set(cacheKey, { output, computedAt: Date.now() });
  return output;
}

async function computeCalibration(input: BayesianInput): Promise<BayesianOutput> {
  const { driverId, vehicleCategory, cityProfile, h3Zone, hourSlot } = input;
  const supa = getSupa();

  // City baseline (fallback toujours disponible)
  const cityBaselineEurHour = cityGetEurHourRef(vehicleCategory, cityProfile);

  if (!supa) {
    // No Supabase → fallback pure city
    return {
      eurHourRef: cityBaselineEurHour,
      acceptThreshold: cityGetAcceptThreshold(vehicleCategory, cityProfile),
      confidence: 0.3,
      breakdown: {
        personalEurHour: null,
        personalSamples: 0,
        collectiveEurHour: null,
        collectiveSamples: 0,
        cityBaselineEurHour,
        weightPersonal: 0,
        weightCollective: 0,
        weightCity: 1.0,
      },
    };
  }

  // Fetch personal + collective en parallèle
  const [personal, collective] = await Promise.all([
    fetchPersonalCalibration(supa, driverId, h3Zone, hourSlot),
    fetchCollectiveCalibration(supa, cityProfile.city_slug, vehicleCategory, h3Zone, hourSlot),
  ]);

  // Compute weights (adaptive selon samples perso)
  const weights = computeWeights(personal.samples, collective.samples);

  // Blended eur_hour_ref
  const eurHourRef = Math.round(
    (personal.eurHour ?? cityBaselineEurHour) * weights.personal +
      (collective.eurHour ?? cityBaselineEurHour) * weights.collective +
      cityBaselineEurHour * weights.city,
  );

  // Blended accept_threshold : + ou - strict selon écart perso vs city
  const baseThreshold = cityGetAcceptThreshold(vehicleCategory, cityProfile);
  // Si chauffeur perso a eur_hour > city (perf supérieure), on baisse un peu
  // le seuil (il peut se permettre d'accepter plus car il connaît mieux).
  // Si perso < city, on lève un peu (il doit être plus sélectif).
  let acceptThreshold = baseThreshold;
  if (personal.eurHour && personal.samples >= 10) {
    const ratio = personal.eurHour / cityBaselineEurHour;
    if (ratio > 1.15) acceptThreshold = Math.max(baseThreshold - 3, 30);
    else if (ratio < 0.85) acceptThreshold = Math.min(baseThreshold + 4, 85);
  }

  // Confidence
  const totalSamples = personal.samples + collective.samples;
  const confidence = Math.min(1.0, 0.3 + totalSamples / 100);

  return {
    eurHourRef,
    acceptThreshold,
    confidence,
    breakdown: {
      personalEurHour: personal.eurHour,
      personalSamples: personal.samples,
      collectiveEurHour: collective.eurHour,
      collectiveSamples: collective.samples,
      cityBaselineEurHour,
      weightPersonal: weights.personal,
      weightCollective: weights.collective,
      weightCity: weights.city,
    },
  };
}

/**
 * Calibration personnelle — lit ajnaya_learning_data du chauffeur sur
 * la zone+heure, computes P40 des €/h perso.
 */
async function fetchPersonalCalibration(
  supa: SupabaseClient,
  driverId: string,
  h3Zone: string,
  hourSlot: number,
): Promise<{ eurHour: number | null; samples: number }> {
  try {
    // Window : 60 dernières courses dans cette zone ± 1h
    const { data } = await supa
      .from('ajnaya_learning_data')
      .select('actual_fare, followed_advice, outcome_score, created_at')
      .eq('driver_id', driverId)
      .eq('h3_zone', h3Zone)
      .gte('hour_slot', Math.max(0, hourSlot - 1))
      .lte('hour_slot', Math.min(23, hourSlot + 1))
      .eq('followed_advice', true)
      .order('created_at', { ascending: false })
      .limit(60);

    if (!data || data.length === 0) return { eurHour: null, samples: 0 };

    // Approx eur_hour per ride (fare / 45min avg — sans distance/duration détaillé ici)
    // Note: pour plus de précision, on irait chercher actual_duration_min dans driver_ride_features
    const fares = (data as any[]).map((d) => d.actual_fare).filter((f) => typeof f === 'number');
    if (fares.length === 0) return { eurHour: null, samples: data.length };

    // P40 (40e percentile) comme "plancher acceptable" (résistant aux outliers)
    fares.sort((a, b) => a - b);
    const p40idx = Math.floor(fares.length * 0.4);
    const p40Fare = fares[p40idx];
    // Hypothèse : 45 min par course → €/h = fare * 60/45
    const eurHour = p40Fare * (60 / 45);

    return { eurHour, samples: data.length };
  } catch {
    return { eurHour: null, samples: 0 };
  }
}

/**
 * Calibration collective anonymisée via view collective_zone_stats_by_vehicle_anon.
 */
async function fetchCollectiveCalibration(
  supa: SupabaseClient,
  citySlug: string,
  vehicleCategory: VehicleCategory,
  h3Zone: string,
  hourSlot: number,
): Promise<{ eurHour: number | null; samples: number }> {
  try {
    const { data } = await supa
      .from('collective_zone_stats_by_vehicle_anon')
      .select('avg_eur_per_hour, sample_size')
      .eq('city_slug', citySlug)
      .eq('vehicle_category', vehicleCategory)
      .eq('h3_zone', h3Zone)
      .eq('hour_slot', hourSlot)
      .single();

    if (!data) return { eurHour: null, samples: 0 };
    return {
      eurHour: Number(data.avg_eur_per_hour) || null,
      samples: Number(data.sample_size) || 0,
    };
  } catch {
    return { eurHour: null, samples: 0 };
  }
}

/**
 * Weights adaptatifs :
 *   - perso dominé par confiance (nb samples)
 *   - city utilisé comme safety net (toujours >= 5%)
 */
function computeWeights(
  personalSamples: number,
  collectiveSamples: number,
): {
  personal: number;
  collective: number;
  city: number;
} {
  // Si perso > 60 : quasi 100% perso
  if (personalSamples >= 60) {
    return { personal: 0.85, collective: 0.1, city: 0.05 };
  }
  if (personalSamples >= 30) {
    return { personal: 0.65, collective: 0.25, city: 0.1 };
  }
  if (personalSamples >= 10) {
    return { personal: 0.4, collective: 0.45, city: 0.15 };
  }
  // 0-10 samples : cold start → collectif prime
  if (collectiveSamples >= 10) {
    return { personal: 0.15, collective: 0.7, city: 0.15 };
  }
  // Même collectif insuffisant → city baseline majoritaire
  return { personal: 0.1, collective: 0.3, city: 0.6 };
}

/**
 * Invalide le cache pour un chauffeur (appelé après record-outcome
 * pour que la prochaine décision utilise la nouvelle calibration).
 */
export function invalidateBayesianCache(driverId: string): void {
  for (const key of Array.from(calibrationCache.keys())) {
    if (key.startsWith(`${driverId}|`)) {
      calibrationCache.delete(key);
    }
  }
}
