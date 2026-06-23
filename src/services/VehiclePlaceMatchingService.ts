/**
 * VehiclePlaceMatchingService — matching véhicule ↔ place_type depuis la DB
 * Ajnaya2026v87.1
 *
 * Remplace le mapping hardcodé frontend (src/utils/vehicleTypeSuggestion.ts).
 * Les règles vivent maintenant dans `public.vehicle_place_matching`
 * (seed SQL : 20260415_clientfinder_v87_1.sql).
 */

import { getSupabase } from '../lib/supabase.js';

export type VehicleCategory = 'BERLINE_T3' | 'VTC_STANDARD' | 'LOTI' | 'TAXI';

export interface VehicleMatchingRule {
  vehicle_category: VehicleCategory;
  place_type: string;
  suggested: boolean;
  priority: number;
}

// ── Cache mémoire (les règles changent rarement) ─────────────────
let _cache: { rows: VehicleMatchingRule[]; at: number } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

async function loadAllRules(): Promise<VehicleMatchingRule[]> {
  if (_cache && Date.now() - _cache.at < CACHE_TTL_MS) return _cache.rows;
  try {
    const supa = getSupabase();
    const { data, error } = await supa
      .from('vehicle_place_matching')
      .select('vehicle_category, place_type, suggested, priority')
      .eq('suggested', true)
      .order('priority', { ascending: false });

    if (error) {
      console.warn('[VehicleMatching] load error:', error.message);
      return _cache?.rows ?? [];
    }
    _cache = { rows: (data || []) as VehicleMatchingRule[], at: Date.now() };
    return _cache.rows;
  } catch (err: any) {
    console.warn('[VehicleMatching] load exception:', err?.message);
    return _cache?.rows ?? [];
  }
}

/**
 * Retourne les `place_type` suggérés pour une catégorie de véhicule,
 * triés par priorité décroissante.
 */
export async function getMatchingPlaceTypes(category: VehicleCategory): Promise<string[]> {
  const rules = await loadAllRules();
  return rules
    .filter((r) => r.vehicle_category === category)
    .sort((a, b) => b.priority - a.priority)
    .map((r) => r.place_type);
}

/**
 * Retourne la priorité du matching pour un couple (vehicle, place_type).
 * 0 si aucun match.
 */
export async function getMatchPriority(
  category: VehicleCategory,
  placeType: string,
): Promise<number> {
  const rules = await loadAllRules();
  const match = rules.find((r) => r.vehicle_category === category && r.place_type === placeType);
  return match?.priority ?? 0;
}

/**
 * Invalide manuellement le cache (utile après admin update via SQL).
 */
export function invalidateVehicleMatchingCache(): void {
  _cache = null;
}
