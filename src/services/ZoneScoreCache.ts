/**
 * ZoneScoreCache — Lecture des scores de zone H3 dynamiques
 * Scores calculés/mis à jour toutes les 5min par N8N (background).
 * Ce service lit uniquement — jamais il ne calcule.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

// ── Lazy Supabase client ────────────────────────────────────────
let _supa: SupabaseClient | null = null;
function getSupa(): SupabaseClient | null {
  if (_supa) return _supa;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  _supa = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  return _supa;
}

export interface ZoneScore {
  h3Index: string;
  score: number;
  surgeActive: boolean;
  updatedAt: Date;
  staleSec: number;
}

// ── Cache mémoire local ─────────────────────────────────────────
const _cache = new Map<string, { data: ZoneScore; fetchedAt: number }>();
const CACHE_TTL_MS = 30_000;
const CACHE_MAX_SIZE = 500;

// Nettoyage périodique toutes les 5min
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of _cache) {
    if (now - val.fetchedAt > CACHE_TTL_MS * 2) _cache.delete(key);
  }
}, 300_000);

// ── Circuit breaker Supabase ────────────────────────────────────
let _failCount = 0;
let _circuitOpen = false;
let _circuitOpenAt = 0;

export function isCircuitOpen(): boolean {
  return _circuitOpen;
}
export function getCacheSize(): number {
  return _cache.size;
}

function checkCircuit(): boolean {
  if (!_circuitOpen) return true;
  if (Date.now() - _circuitOpenAt > 30_000) {
    _circuitOpen = false;
    _failCount = 0;
    return true;
  }
  return false;
}

function recordFailure() {
  _failCount++;
  if (_failCount >= 5) {
    _circuitOpen = true;
    _circuitOpenAt = Date.now();
    console.warn('[CircuitBreaker] Supabase circuit OPEN — 5 failures in a row');
  }
}

function recordSuccess() {
  _failCount = 0;
}

// ── Public API ──────────────────────────────────────────────────

export async function getZoneScore(h3Index: string): Promise<ZoneScore | null> {
  const now = Date.now();
  const cached = _cache.get(h3Index);
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return cached.data;

  if (!checkCircuit()) return cached?.data ?? null;

  const supa = getSupa();
  if (!supa) return null;

  try {
    const { data, error } = await supa
      .from('pieuvre_h3_demand_zones')
      .select('h3_index, score, surge_active, updated_at')
      .eq('h3_index', h3Index)
      .single();

    if (error || !data) return null;

    recordSuccess();

    const result: ZoneScore = {
      h3Index: data.h3_index,
      score: data.score ?? 0,
      surgeActive: data.surge_active ?? false,
      updatedAt: new Date(data.updated_at),
      staleSec: Math.floor((now - new Date(data.updated_at).getTime()) / 1000),
    };

    if (_cache.size >= CACHE_MAX_SIZE) {
      const oldestKey = _cache.keys().next().value;
      if (oldestKey) _cache.delete(oldestKey);
    }
    _cache.set(h3Index, { data: result, fetchedAt: now });
    return result;
  } catch (e: any) {
    recordFailure();
    console.error('[ZoneScoreCache]', e?.message);
    return cached?.data ?? null;
  }
}

export async function getMultipleZoneScores(h3Indices: string[]): Promise<Map<string, ZoneScore>> {
  const result = new Map<string, ZoneScore>();
  if (!checkCircuit()) return result;

  const supa = getSupa();
  if (!supa) return result;

  try {
    const { data } = await supa
      .from('pieuvre_h3_demand_zones')
      .select('h3_index, score, surge_active, updated_at')
      .in('h3_index', h3Indices);

    recordSuccess();
    if (data) {
      for (const row of data) {
        result.set(row.h3_index, {
          h3Index: row.h3_index,
          score: row.score ?? 0,
          surgeActive: row.surge_active ?? false,
          updatedAt: new Date(row.updated_at),
          staleSec: Math.floor((Date.now() - new Date(row.updated_at).getTime()) / 1000),
        });
      }
    }
  } catch (e: any) {
    recordFailure();
    console.error('[ZoneScoreCache] batch error:', e?.message);
  }
  return result;
}

export async function getPersonalizedZoneScore(
  driverId: string,
  h3Index: string,
  hour: number,
): Promise<number> {
  const baseScore = (await getZoneScore(h3Index))?.score ?? 0.5;

  const supa = getSupa();
  if (!supa || !checkCircuit()) return baseScore;

  try {
    const { data } = await supa
      .from('ajnaya_learning_data')
      .select('outcome_score, created_at')
      .eq('driver_id', driverId)
      .eq('h3_zone', h3Index)
      .gte('hour_slot', hour - 1)
      .lte('hour_slot', hour + 1)
      .order('created_at', { ascending: false })
      .limit(20);

    recordSuccess();

    if (!data || data.length < 5) return baseScore;

    const personalAvg =
      data.reduce((sum: number, d: any, i: number) => {
        const weight = 1 / (i + 1);
        return sum + d.outcome_score * weight;
      }, 0) / data.reduce((sum: number, _: any, i: number) => sum + 1 / (i + 1), 0);

    return personalAvg * 0.6 + baseScore * 0.4;
  } catch (e: any) {
    recordFailure();
    return baseScore;
  }
}
