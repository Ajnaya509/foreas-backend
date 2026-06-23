/**
 * CityProfileCache — Lecture des profils de ville adaptatifs
 * ===========================================================
 * Les profils sont seedés statiquement et mis à jour nuitamment par N8N
 * (workflow CityProfiles_DailyRefresh). Ce service lit uniquement.
 *
 * Fallback : si une ville est inconnue → 'paris' (jamais null).
 * TTL cache : 1h (les profils changent 1x/nuit max).
 *
 * Usage :
 *   const profile = await getCityProfile('lyon');
 *   const ref = getEurHourRef('VTC_STANDARD', profile);
 *   const threshold = getAcceptThreshold('BERLINE_T3', profile);
 *   const isRush = isRushHour(new Date().getHours(), profile);
 *
 * Commit v81 — 7 avril 2026
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

// ── Lazy Supabase client ──────────────────────────────────────────
let _supa: SupabaseClient | null = null;
function getSupa(): SupabaseClient | null {
  if (_supa) return _supa;
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  _supa = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  return _supa;
}

// ── Types ─────────────────────────────────────────────────────────

export interface CityProfile {
  city_slug: string;
  city_name: string;
  country_code: string;

  // Références €/h par catégorie véhicule
  eur_hour_vtc_standard: number;
  eur_hour_berline_t3: number;
  eur_hour_loti: number;
  eur_hour_taxi: number;

  // Déplacement à vide
  deadhead_min_per_km: number;

  // Créneaux rush
  rush_hour_slots: Array<{ from: number; to: number }>;

  // Nuit
  night_active_from: number;
  night_active_to: number;

  // H3
  h3_score_multiplier: number;

  // Seuils d'acceptation (0-100) par catégorie
  accept_threshold_vtc_standard: number;
  accept_threshold_berline_t3: number;
  accept_threshold_loti: number;
  accept_threshold_taxi: number;

  // Métriques calculées (mises à jour nuitamment)
  active_drivers_count: number;
  median_eur_hour_last_7d: number | null;
  median_fare_last_7d: number | null;
  total_rides_last_7d: number;
  last_computed_at: string | null;
}

export type VehicleCategory = 'VTC_STANDARD' | 'BERLINE_T3' | 'LOTI' | 'TAXI';

// Profil Paris par défaut (utilisé si Supabase indisponible)
// Recalibré 2026-04-21 : values unifiées avec src/types/vehicle.ts fallback
// pour cohérence client <-> backend. Sources : rapport IGR/UTP 2024 + marché VTC FR.
const PARIS_FALLBACK: CityProfile = {
  city_slug: 'paris',
  city_name: 'Paris',
  country_code: 'FR',
  eur_hour_vtc_standard: 26,
  eur_hour_berline_t3: 35,
  eur_hour_loti: 40, // Van Paris : airport + événement tirent vers haut
  eur_hour_taxi: 25,
  deadhead_min_per_km: 3.0,
  rush_hour_slots: [
    { from: 7, to: 9 },
    { from: 17, to: 20 },
    { from: 22, to: 2 },
  ],
  night_active_from: 22,
  night_active_to: 4,
  h3_score_multiplier: 1.0,
  accept_threshold_vtc_standard: 52,
  accept_threshold_berline_t3: 58,
  accept_threshold_loti: 62, // Van : sélectif, raréfaction courses
  accept_threshold_taxi: 45,
  active_drivers_count: 0,
  median_eur_hour_last_7d: null,
  median_fare_last_7d: null,
  total_rides_last_7d: 0,
  last_computed_at: null,
};

// ── Cache en mémoire ──────────────────────────────────────────────

interface CacheEntry {
  data: CityProfile;
  fetchedAt: number;
}

const _cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 3_600_000; // 1 heure

// ── API Publique ──────────────────────────────────────────────────

/**
 * Récupère le profil d'une ville avec cache 1h.
 * Fallback : paris → PARIS_FALLBACK (jamais null).
 */
export async function getCityProfile(citySlug: string = 'paris'): Promise<CityProfile> {
  const slug = (citySlug || 'paris').toLowerCase().trim();
  const now = Date.now();

  // Cache hit
  const cached = _cache.get(slug);
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  const supa = getSupa();
  if (!supa) {
    console.warn('[CityProfileCache] Supabase non configuré — fallback Paris');
    return PARIS_FALLBACK;
  }

  try {
    const { data, error } = await supa
      .from('city_profiles')
      .select('*')
      .eq('city_slug', slug)
      .eq('is_active', true)
      .single();

    if (error || !data) {
      // Ville inconnue → fallback Paris (avec cache pour éviter les requêtes répétées)
      if (slug !== 'paris') {
        console.warn(`[CityProfileCache] Ville "${slug}" inconnue — fallback Paris`);
        return getCityProfile('paris');
      }
      // Paris indisponible → hardcoded fallback
      console.warn('[CityProfileCache] Paris non trouvé en DB — fallback hardcodé');
      return PARIS_FALLBACK;
    }

    const profile = normalizeCityProfile(data);
    _cache.set(slug, { data: profile, fetchedAt: now });
    return profile;
  } catch (err: any) {
    console.error('[CityProfileCache] Erreur fetch:', err.message);
    return slug === 'paris' ? PARIS_FALLBACK : getCityProfile('paris');
  }
}

/**
 * Précharge plusieurs villes en parallèle (utile au démarrage du backend).
 */
export async function warmupCityCache(
  slugs: string[] = ['paris', 'lyon', 'marseille'],
): Promise<void> {
  await Promise.allSettled(slugs.map((s) => getCityProfile(s)));
  console.log(`[CityProfileCache] ✅ Cache préchauffé pour: ${slugs.join(', ')}`);
}

/**
 * Invalide le cache pour une ville (ex: après mise à jour manuelle).
 */
export function invalidateCityCache(citySlug?: string): void {
  if (citySlug) {
    _cache.delete(citySlug.toLowerCase());
  } else {
    _cache.clear();
    console.log('[CityProfileCache] Cache entier invalidé');
  }
}

// ── Helpers métier ────────────────────────────────────────────────

/**
 * €/h de référence selon la catégorie de véhicule et le profil ville.
 */
export function getEurHourRef(vehicleCategory: string, profile: CityProfile): number {
  switch (vehicleCategory?.toUpperCase()) {
    case 'BERLINE_T3':
      return profile.eur_hour_berline_t3;
    case 'LOTI':
      return profile.eur_hour_loti;
    case 'TAXI':
      return profile.eur_hour_taxi;
    default:
      return profile.eur_hour_vtc_standard;
  }
}

/**
 * Seuil d'acceptation (0-100) selon la catégorie et le profil ville.
 */
export function getAcceptThreshold(vehicleCategory: string, profile: CityProfile): number {
  switch (vehicleCategory?.toUpperCase()) {
    case 'BERLINE_T3':
      return profile.accept_threshold_berline_t3;
    case 'LOTI':
      return profile.accept_threshold_loti;
    case 'TAXI':
      return profile.accept_threshold_taxi;
    default:
      return profile.accept_threshold_vtc_standard;
  }
}

/**
 * True si l'heure est dans un créneau rush du profil ville.
 * Gère le cas des créneaux nocturnes qui traversent minuit (ex: {from:22, to:2}).
 */
export function isRushHour(hour: number, profile: CityProfile): boolean {
  return profile.rush_hour_slots.some((slot) => {
    if (slot.from < slot.to) {
      // Créneau normal : 7 → 9
      return hour >= slot.from && hour < slot.to;
    } else {
      // Créneau nocturne traverse minuit : 22 → 2
      return hour >= slot.from || hour < slot.to;
    }
  });
}

/**
 * True si l'heure est en période nocturne active selon le profil ville.
 */
export function isNightActive(hour: number, profile: CityProfile): boolean {
  const from = profile.night_active_from;
  const to = profile.night_active_to;
  if (from > to) {
    // Traverse minuit : ex 22 → 4
    return hour >= from || hour <= to;
  }
  return hour >= from && hour <= to;
}

/**
 * Calcule le temps à vide estimé (minutes) selon la distance (km) et le profil ville.
 */
export function estimateDeadheadMinutes(distanceKm: number, profile: CityProfile): number {
  return Math.round(distanceKm * profile.deadhead_min_per_km);
}

// ── Normalisation ─────────────────────────────────────────────────

function normalizeCityProfile(raw: any): CityProfile {
  return {
    city_slug: raw.city_slug,
    city_name: raw.city_name,
    country_code: raw.country_code || 'FR',
    eur_hour_vtc_standard: parseFloat(raw.eur_hour_vtc_standard) || 28,
    eur_hour_berline_t3: parseFloat(raw.eur_hour_berline_t3) || 38,
    eur_hour_loti: parseFloat(raw.eur_hour_loti) || 32,
    eur_hour_taxi: parseFloat(raw.eur_hour_taxi) || 25,
    deadhead_min_per_km: parseFloat(raw.deadhead_min_per_km) || 3.0,
    rush_hour_slots: parseRushSlots(raw.rush_hour_slots),
    night_active_from: raw.night_active_from ?? 22,
    night_active_to: raw.night_active_to ?? 4,
    h3_score_multiplier: parseFloat(raw.h3_score_multiplier) || 1.0,
    accept_threshold_vtc_standard: raw.accept_threshold_vtc_standard ?? 52,
    accept_threshold_berline_t3: raw.accept_threshold_berline_t3 ?? 58,
    accept_threshold_loti: raw.accept_threshold_loti ?? 55,
    accept_threshold_taxi: raw.accept_threshold_taxi ?? 45,
    active_drivers_count: raw.active_drivers_count ?? 0,
    median_eur_hour_last_7d: raw.median_eur_hour_last_7d
      ? parseFloat(raw.median_eur_hour_last_7d)
      : null,
    median_fare_last_7d: raw.median_fare_last_7d ? parseFloat(raw.median_fare_last_7d) : null,
    total_rides_last_7d: raw.total_rides_last_7d ?? 0,
    last_computed_at: raw.last_computed_at || null,
  };
}

function parseRushSlots(raw: any): Array<{ from: number; to: number }> {
  if (!raw)
    return [
      { from: 7, to: 9 },
      { from: 17, to: 20 },
    ];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  } catch {
    // ignore
  }
  return [
    { from: 7, to: 9 },
    { from: 17, to: 20 },
  ];
}
