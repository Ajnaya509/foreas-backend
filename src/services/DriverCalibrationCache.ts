/**
 * DriverCalibrationCache — Auto-calibration des seuils personnels par chauffeur
 *
 * Problème résolu : les seuils city×vehicle sont des références de départ,
 * mais chaque chauffeur performe différemment. Ce service corrige les seuils
 * en temps réel en analysant les outcomes réels enregistrés.
 *
 * Inputs :
 *   - pieuvre_screen_reader_events : eur_per_hour observés (60 dernières décisions)
 *   - ajnaya_learning_data : outcome_score réels (40 derniers feedbacks)
 *
 * Outputs :
 *   - eurHourRef personnalisé (blend adaptatif base + observé, P40)
 *   - acceptThreshold personnalisé (ajusté selon qualité des outcomes)
 *   - confidence 0→1 (monte avec le nombre d'échantillons, plein à 30+)
 *
 * Cache : 2h en mémoire par driver, non-bloquant (cache chaud = <1ms)
 */

import { SupabaseClient } from '@supabase/supabase-js';

export interface DriverCalibration {
  eurHourRef: number; // Référentiel personnalisé (blend base + observé)
  acceptThreshold: number; // Seuil d'acceptation personnalisé
  confidence: number; // 0-1 (fiabilité de la calibration)
  sampleCount: number; // Nombre d'échantillons utilisés
  computedAt: number; // Timestamp de calcul
}

// ── Cache mémoire (TTL 2h) ──────────────────────────────────────
const _cache = new Map<string, DriverCalibration>();
const CACHE_TTL = 2 * 60 * 60 * 1000; // 2h

// Nettoyage périodique
setInterval(
  () => {
    const cutoff = Date.now() - CACHE_TTL;
    for (const [id, cal] of _cache) {
      if (cal.computedAt < cutoff) _cache.delete(id);
    }
  },
  30 * 60 * 1000,
);

/**
 * Retourne les seuils personnalisés pour un chauffeur.
 * - Cache chaud (< 2h) : retour immédiat < 1ms
 * - Cache froid : requête Supabase ~30-50ms, non-bloquante pour les autres drivers
 */
export async function getDriverCalibration(
  supabase: SupabaseClient,
  driverId: string,
  baseEurHourRef: number,
  baseAcceptThreshold: number,
): Promise<DriverCalibration> {
  // Cache hit
  const cached = _cache.get(driverId);
  if (cached && Date.now() - cached.computedAt < CACHE_TTL) return cached;

  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();

    // Parallèle : décisions passées + outcomes réels
    const [decisionsRes, outcomesRes] = await Promise.all([
      supabase
        .from('pieuvre_screen_reader_events')
        .select('eur_per_hour, coach_verdict')
        .eq('driver_id', driverId)
        .gte('created_at', thirtyDaysAgo)
        .order('created_at', { ascending: false })
        .limit(60),
      supabase
        .from('ajnaya_learning_data')
        .select('outcome_score, followed_advice, verdict_given')
        .eq('driver_id', driverId)
        .gte('created_at', thirtyDaysAgo)
        .order('created_at', { ascending: false })
        .limit(40),
    ]);

    const decisions = (decisionsRes.data ?? []) as {
      eur_per_hour: number;
      coach_verdict: string;
    }[];
    const outcomes = (outcomesRes.data ?? []) as {
      outcome_score: number;
      followed_advice: boolean;
    }[];

    const sampleCount = decisions.length + outcomes.length;
    // Confiance pleine à 30+ échantillons — évite sur-ajustement avec peu de data
    const confidence = Math.min(1, sampleCount / 30);

    // ── Calibration du référentiel €/h ─────────────────────────
    // On prend le P40 des courses ACCEPT : c'est le "plancher acceptable"
    // Un P40 est plus robuste qu'une moyenne (résistant aux outliers)
    const acceptedEurHours = decisions
      .filter((d) => d.coach_verdict === 'ACCEPT' && d.eur_per_hour > 5)
      .map((d) => d.eur_per_hour)
      .sort((a, b) => a - b);

    let personalEurHourRef = baseEurHourRef;
    if (acceptedEurHours.length >= 8) {
      const p40idx = Math.floor(acceptedEurHours.length * 0.4);
      const observedRef = acceptedEurHours[p40idx];
      // Blend progressif : plus de confiance = plus de poids personal
      const blendWeight = Math.min(0.55, confidence * 0.55);
      personalEurHourRef = baseEurHourRef * (1 - blendWeight) + observedRef * blendWeight;
      // Clamp : jamais en dehors de ±40% du référentiel de base
      personalEurHourRef = Math.max(
        baseEurHourRef * 0.6,
        Math.min(baseEurHourRef * 1.4, personalEurHourRef),
      );
    }

    // ── Calibration du seuil d'acceptation ─────────────────────
    // On analyse la qualité des outcomes quand le chauffeur a suivi le conseil
    // outcome_score = actual_fare / estimated_fare (1.0 = parfait)
    const followedOutcomes = outcomes.filter(
      (o) => o.followed_advice && typeof o.outcome_score === 'number',
    );
    let personalThreshold = baseAcceptThreshold;

    if (followedOutcomes.length >= 5) {
      const meanOutcome =
        followedOutcomes.reduce((s, o) => s + o.outcome_score, 0) / followedOutcomes.length;

      if (meanOutcome > 0.85) {
        // Chauffeur performe bien → peut se permettre d'être plus sélectif (+3 pts max)
        const bonus = Math.min(3, ((meanOutcome - 0.85) / 0.15) * 3) * confidence;
        personalThreshold += bonus;
      } else if (meanOutcome < 0.65) {
        // Perf faibles → baisser légèrement pour accumuler volume (-4 pts max)
        const malus = Math.min(4, ((0.65 - meanOutcome) / 0.25) * 4) * confidence;
        personalThreshold -= malus;
      }

      // Hard clamp : jamais plus de ±10 pts autour du seuil de base
      personalThreshold = Math.max(
        baseAcceptThreshold - 10,
        Math.min(baseAcceptThreshold + 10, personalThreshold),
      );
    }

    const result: DriverCalibration = {
      eurHourRef: Math.round(personalEurHourRef * 10) / 10,
      acceptThreshold: Math.round(personalThreshold),
      confidence: Math.round(confidence * 100) / 100,
      sampleCount,
      computedAt: Date.now(),
    };

    _cache.set(driverId, result);
    return result;
  } catch (err: any) {
    console.error('[DriverCalib] Erreur calcul, fallback base:', err?.message);
    // Fallback non-bloquant : valeurs de base avec confiance 0
    const fallback: DriverCalibration = {
      eurHourRef: baseEurHourRef,
      acceptThreshold: baseAcceptThreshold,
      confidence: 0,
      sampleCount: 0,
      computedAt: Date.now(),
    };
    _cache.set(driverId, fallback);
    return fallback;
  }
}

/** Invalide le cache d'un driver (appeler après record-outcome) */
export function invalidateCalibration(driverId: string): void {
  _cache.delete(driverId);
}

export function getCalibCacheSize(): number {
  return _cache.size;
}
