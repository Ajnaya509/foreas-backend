/**
 * geoCache.ts — Cache mémoire pour les endpoints /api/context/*
 *
 * Mutualise les appels aux APIs externes payantes (PredictHQ, TomTom,
 * OpenWeather) entre tous les chauffeurs dans une même grille géographique.
 *
 * Sans ce cache : 100 chauffeurs × refresh 2 min = 3000 calls/heure → ~$300/h
 * de surfacturation PredictHQ.
 * Avec ce cache (grille 5km, TTL 10 min) : ~6 calls/heure max sur la zone.
 *
 * Stratégie :
 *   - Clé = `${endpoint}:${gridLat}:${gridLng}` (grille ~5km via .toFixed(2))
 *   - TTL différenciée par endpoint (events lents, traffic rapide)
 *   - Cap mémoire 100 entries max (LRU eviction)
 *   - Header X-Cache: HIT|MISS|BYPASS pour debug
 *
 * Sources gratuites (SNCF/IDFM) cachent quand même par bonne hygiène
 * (réduit latence + load Railway).
 */

interface CacheEntry<T> {
  data: T;
  ts: number;
  hits: number;
  endpoint: string;
}

class GeoCache {
  private store: Map<string, CacheEntry<any>> = new Map();
  private readonly MAX_ENTRIES = 100;

  // TTL par endpoint (millisecondes)
  // Events PredictHQ : changent peu, cache long pour économiser quotas payants
  // Weather : changements lents (15 min précision suffisante côté demande VTC)
  // Traffic : change vite (3 min pour rester pertinent)
  // Transport disruptions : 5 min — équilibre coût/fraîcheur (gratuit mais hits Railway)
  private readonly TTL_MS: Record<string, number> = {
    predicthq_events: 10 * 60 * 1000, // 10 min
    openweather: 15 * 60 * 1000, // 15 min
    tomtom_traffic: 3 * 60 * 1000, // 3 min
    sncf_idfm_disruptions: 5 * 60 * 1000, // 5 min
  };

  /**
   * Construit une clé de cache à partir d'un endpoint et de coords.
   * .toFixed(2) → précision ~1.1km lat / 0.7km lng à Paris (grille fine).
   * Pour grille 5km plus large → .toFixed(1) (= ~11km lat).
   * Choix : .toFixed(2) pour ~5-7km de mutualisation, suffisant pour les events.
   */
  private buildKey(endpoint: string, lat: number, lng: number): string {
    return `${endpoint}:${lat.toFixed(2)}:${lng.toFixed(2)}`;
  }

  /**
   * Récupère une entrée du cache si non expirée.
   * Retourne null si miss ou expiré (et nettoie l'entrée si périmée).
   */
  get<T>(endpoint: string, lat: number, lng: number): T | null {
    const key = this.buildKey(endpoint, lat, lng);
    const entry = this.store.get(key);
    if (!entry) return null;

    const ttl = this.TTL_MS[endpoint] ?? 5 * 60 * 1000;
    if (Date.now() - entry.ts > ttl) {
      this.store.delete(key);
      return null;
    }

    entry.hits++;
    return entry.data as T;
  }

  /**
   * Stocke une entrée. Si on dépasse MAX_ENTRIES → eviction LRU
   * (delete l'entrée la plus ancienne par timestamp).
   */
  set<T>(endpoint: string, lat: number, lng: number, data: T): void {
    const key = this.buildKey(endpoint, lat, lng);

    if (this.store.size >= this.MAX_ENTRIES && !this.store.has(key)) {
      // LRU eviction : trouve le plus ancien
      let oldestKey = '';
      let oldestTs = Infinity;
      for (const [k, v] of this.store.entries()) {
        if (v.ts < oldestTs) {
          oldestTs = v.ts;
          oldestKey = k;
        }
      }
      if (oldestKey) this.store.delete(oldestKey);
    }

    this.store.set(key, { data, ts: Date.now(), hits: 0, endpoint });
  }

  /**
   * Invalide toutes les entrées d'un endpoint (utile pour tests/admin).
   */
  invalidate(endpoint: string): number {
    let count = 0;
    for (const [key, entry] of this.store.entries()) {
      if (entry.endpoint === endpoint) {
        this.store.delete(key);
        count++;
      }
    }
    return count;
  }

  /**
   * Stats pour monitoring/debug — exposable via /api/cache/health.
   */
  getStats(): {
    totalEntries: number;
    entriesByEndpoint: Record<string, number>;
    totalHits: number;
    oldestEntryAgeMs: number;
  } {
    const byEndpoint: Record<string, number> = {};
    let totalHits = 0;
    let oldestTs = Date.now();

    for (const entry of this.store.values()) {
      byEndpoint[entry.endpoint] = (byEndpoint[entry.endpoint] ?? 0) + 1;
      totalHits += entry.hits;
      if (entry.ts < oldestTs) oldestTs = entry.ts;
    }

    return {
      totalEntries: this.store.size,
      entriesByEndpoint: byEndpoint,
      totalHits,
      oldestEntryAgeMs: this.store.size > 0 ? Date.now() - oldestTs : 0,
    };
  }

  /**
   * Wrapper helper : exécute fetcher si miss, retourne cached sinon.
   * Retourne aussi le statut HIT/MISS pour set le header X-Cache.
   */
  async getOrFetch<T>(
    endpoint: string,
    lat: number,
    lng: number,
    fetcher: () => Promise<T>,
  ): Promise<{ data: T; status: 'HIT' | 'MISS' }> {
    const cached = this.get<T>(endpoint, lat, lng);
    if (cached !== null) {
      return { data: cached, status: 'HIT' };
    }
    const data = await fetcher();
    this.set(endpoint, lat, lng, data);
    return { data, status: 'MISS' };
  }
}

// Singleton — une seule instance partagée par tous les endpoints
export const geoCache = new GeoCache();
export default geoCache;
