/**
 * GET /api/zones/live — Moteur de décision zones chaudes temps réel
 *
 * Consomme AjnayaFusionEngine (10 sources réelles : OpenWeather, PredictHQ,
 * SNCF, TomTom, IDFM, Twitter, Bolt, Perplexity Sonar, RAG, Supabase learning)
 * pour retourner un ranking des zones avec score, niveau, raisons, sources.
 *
 * C'est le point de consommation pour le HomeScreen Mapbox côté driver app.
 *
 * OPTIMISATIONS :
 *   - Cache mémoire 30s (évite hammer des APIs externes si polling driver)
 *   - Pas de driverId requis (mode générique) mais supporté (learning loop)
 *   - Fallback graceful : si fuse() échoue, retourne zones pattern temporel
 *
 * SÉCURITÉ : Aucune donnée sensible retournée (zones publiques + scores agrégés).
 */
import { Router, Request, Response } from 'express';
import { fuse } from '../services/AjnayaFusionEngine.js';

const router = Router();

// ── Cache 30s in-memory (stale-while-revalidate) ─────────────────────────────
interface CachedZones {
  zones: any[];
  sources: string[];
  dataQuality: 'live' | 'cached' | 'simulated';
  refreshedAt: number;
  alerts: string[];
  opportunities: string[];
}

let zoneCache: CachedZones | null = null;
const CACHE_TTL_MS = 30_000;

// ── Mapping zone name → level (cohérent avec driver) ─────────────────────────
function scoreToLevel(score: number): 'SURGE' | 'HIGH' | 'MEDIUM' | 'LOW' {
  if (score >= 80) return 'SURGE';
  if (score >= 60) return 'HIGH';
  if (score >= 35) return 'MEDIUM';
  return 'LOW';
}

function scoreToMultiplier(score: number): number {
  if (score >= 85) return 2.0;
  if (score >= 70) return 1.5;
  if (score >= 55) return 1.25;
  if (score >= 40) return 1.1;
  return 1.0;
}

function scoreToEarnings(score: number): string {
  if (score >= 85) return '€45-60/h';
  if (score >= 70) return '€35-50/h';
  if (score >= 55) return '€28-40/h';
  if (score >= 40) return '€22-32/h';
  return '€18-25/h';
}

// ── GET /api/zones/live ──────────────────────────────────────────────────────
router.get('/live', async (req: Request, res: Response) => {
  const driverId = (req.query.driverId as string) || undefined;
  const bypassCache = req.query.nocache === '1';

  // Cache hit
  const now = Date.now();
  if (!bypassCache && zoneCache && now - zoneCache.refreshedAt < CACHE_TTL_MS) {
    return res.json({
      zones: zoneCache.zones,
      sourcesUsed: zoneCache.sources,
      dataQuality: zoneCache.dataQuality === 'live' ? 'cached' : zoneCache.dataQuality,
      refreshedAt: new Date(zoneCache.refreshedAt).toISOString(),
      cacheAgeMs: now - zoneCache.refreshedAt,
      alerts: zoneCache.alerts,
      opportunities: zoneCache.opportunities,
    });
  }

  // Cache miss ou bypass : fusion complète
  try {
    const fusionContext = await fuse('', driverId);

    const zones = fusionContext.demandZones.map((z) => ({
      name: z.zone,
      score: z.score,
      level: scoreToLevel(z.score),
      surgeMultiplier: scoreToMultiplier(z.score),
      estimatedEarnings: scoreToEarnings(z.score),
      reasons: z.reasons.slice(0, 3),
      sources: z.sources,
    }));

    const dataQuality: 'live' | 'simulated' = fusionContext.sourcesUsed.some((s) =>
      ['openweather', 'predicthq', 'sncf', 'tomtom', 'idfm', 'bolt'].includes(s),
    )
      ? 'live'
      : 'simulated';

    zoneCache = {
      zones,
      sources: fusionContext.sourcesUsed,
      dataQuality,
      refreshedAt: now,
      alerts: fusionContext.alerts,
      opportunities: fusionContext.opportunities,
    };

    return res.json({
      zones,
      sourcesUsed: fusionContext.sourcesUsed,
      dataQuality,
      refreshedAt: new Date(now).toISOString(),
      cacheAgeMs: 0,
      latencyMs: fusionContext.totalLatency,
      alerts: fusionContext.alerts,
      opportunities: fusionContext.opportunities,
    });
  } catch (err: any) {
    console.error('[zones.live] fuse() failed:', err?.message || err);

    // Fallback : si on a un cache même stale, on le sert pour ne pas casser l'UI
    if (zoneCache) {
      return res.json({
        zones: zoneCache.zones,
        sourcesUsed: zoneCache.sources,
        dataQuality: 'cached',
        refreshedAt: new Date(zoneCache.refreshedAt).toISOString(),
        cacheAgeMs: now - zoneCache.refreshedAt,
        alerts: zoneCache.alerts,
        opportunities: zoneCache.opportunities,
        warning: 'stale cache — fusion engine failed',
      });
    }

    // Pas de cache du tout → réponse minimale (driver gère fallback local)
    return res.status(503).json({
      error: 'Fusion engine unavailable',
      zones: [],
      sourcesUsed: [],
      dataQuality: 'simulated',
      refreshedAt: new Date(now).toISOString(),
    });
  }
});

// ── GET /api/zones/health ────────────────────────────────────────────────────
router.get('/health', (req: Request, res: Response) => {
  const now = Date.now();
  return res.json({
    ok: true,
    cacheAgeMs: zoneCache ? now - zoneCache.refreshedAt : null,
    lastSourcesUsed: zoneCache?.sources || [],
    lastDataQuality: zoneCache?.dataQuality || 'unknown',
  });
});

export default router;
