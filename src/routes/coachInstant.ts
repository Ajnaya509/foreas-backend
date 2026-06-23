/**
 * POST /api/coach/instant-decision — Verdict instantané <200ms
 * POST /api/coach/record-outcome — Feedback loop post-course
 * POST /api/coach/refresh-bolt-commission — Rafraîchir taux Bolt (N8N)
 * GET  /api/coach/weekly-summary/:driverId — Récap hebdo
 * GET  /api/coach/health — Health check
 *
 * SYSTÈME RÉFLEXE INDÉPENDANT — PAS DE LANGGRAPH, PAS DE LLM
 *
 * Signaux du score (10) :
 *  1. €/h vs référentiel personnalisé       (×0.30) — auto-calibré
 *  2. Score zone destination personnalisé   (×0.22) — H3 + historique perso
 *  3. Retard sur rythme objectif (temps)    (×0.16) — aware de l'heure
 *  4. Bonus horaire (rush/nuit/surge zone)  (×0.10)
 *  5. Bonus surge plateforme                (×0.08)
 *  6. Bonus jour de semaine                 (×0.06) — vendredi soir, weekend
 *  7. Bonus/malus zone de départ            (×0.06) — fuir zone morte, rester zone chaude
 *  8. Pénalité distance à récupérer         (-0.12)
 *  9. Pénalité longue course > 30km         (-0.05)
 * 10. Seuil ajusté selon fatigue shift      (nb courses aujourd'hui)
 */

import { Router, Request, Response } from 'express';
import * as h3 from 'h3-js';
import { z } from 'zod';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  getZoneScore,
  getPersonalizedZoneScore,
  isCircuitOpen,
  getCacheSize,
} from '../services/ZoneScoreCache';
import {
  getCityProfile,
  getEurHourRef,
  getAcceptThreshold,
  isRushHour,
  isNightActive,
  estimateDeadheadMinutes,
  VehicleCategory,
} from '../services/CityProfileCache';
import {
  getDriverCalibration,
  invalidateCalibration,
  getCalibCacheSize,
} from '../services/DriverCalibrationCache';
import { getBayesianCalibration, invalidateBayesianCache } from '../services/BayesianCalibration';
import { fetchWeather, WeatherContext } from '../services/weatherService.js';
import { fetchSchoolCalendar, SchoolCalendarContext } from '../services/schoolCalendarService.js';

const router = Router();

// ── ZONE_INTEL — HotZone ────────────────────────────────────────
interface HotZone {
  name: string;
  lat: number;
  lng: number;
  score: number; // 0-100
  waitMin: number;
}

const CITY_CENTERS: Record<string, [number, number]> = {
  paris: [48.8566, 2.3522],
  lyon: [45.764, 4.8357],
  marseille: [43.2965, 5.3698],
  bordeaux: [44.8378, -0.5792],
  toulouse: [43.6047, 1.4442],
  nice: [43.7102, 7.262],
};

const _SELF_BASE = process.env.SELF_BASE_URL || `http://localhost:${process.env.PORT || 3001}`;

async function fetchHotZones(lat: number, lng: number): Promise<HotZone[]> {
  try {
    const resp = (await fetch(`${_SELF_BASE}/api/context/events?lat=${lat}&lng=${lng}`, {
      signal: AbortSignal.timeout(2000),
    })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)) as any;

    if (!resp?.results?.length) return [];

    const zones: HotZone[] = [];
    for (const evt of (resp.results as any[]).slice(0, 8)) {
      const loc = evt.location as [number, number] | undefined;
      if (!loc) continue;
      const [evtLng, evtLat] = loc; // PredictHQ: [lng, lat]
      const attendance = (evt.phq_attendance ?? 500) as number;
      // log10(500)≈2.7→~40, log10(5k)≈3.7→~67, log10(50k)≈4.7→~90
      const score = Math.min(
        100,
        Math.max(10, Math.round(Math.log10(Math.max(attendance, 100)) * 27)),
      );
      zones.push({
        name: ((evt.title as string) ?? 'Événement').slice(0, 40),
        lat: evtLat,
        lng: evtLng,
        score,
        waitMin: score >= 70 ? 2 : score >= 50 ? 5 : 12,
      });
    }
    return zones.sort((a, b) => b.score - a.score);
  } catch {
    return [];
  }
}

// ── FRIGO_ENRICHI — Grèves SNCF/RATP ───────────────────────────
interface StrikeAlert {
  isStrike: boolean;
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
  lines: string[];
  demandMultiplier: number;
}

async function fetchStrikeAlert(): Promise<StrikeAlert | null> {
  try {
    const resp = (await fetch(`${_SELF_BASE}/api/context/transport-disruptions`, {
      signal: AbortSignal.timeout(800),
    })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)) as any;

    if (!resp) return null;

    const disruptions = (resp.disruptions ?? resp.results ?? resp.data ?? []) as any[];

    if (!disruptions.length) {
      return { isStrike: false, severity: 'LOW', lines: [], demandMultiplier: 1.0 };
    }

    // Filtre grèves (vs pannes/travaux)
    const strikes = disruptions.filter((d: any) => {
      const cause = (d.cause ?? d.type ?? d.title ?? '').toLowerCase();
      return (
        cause.includes('grève') || cause.includes('strike') || cause.includes('mouvement social')
      );
    });

    const active = strikes.length > 0 ? strikes : disruptions;

    const lines = [
      ...new Set<string>(
        active
          .map((d: any) => d.line ?? d.lines?.[0] ?? d.name ?? d.title ?? '')
          .filter(Boolean)
          .slice(0, 10),
      ),
    ];

    const count = active.length;
    const severity: StrikeAlert['severity'] = count >= 5 ? 'HIGH' : count >= 2 ? 'MEDIUM' : 'LOW';

    return {
      isStrike: count > 0,
      severity,
      lines,
      demandMultiplier: severity === 'HIGH' ? 2.2 : severity === 'MEDIUM' ? 1.5 : 1.0,
    };
  } catch {
    return null;
  }
}

// ── Lazy Supabase ───────────────────────────────────────────────
let _supa: SupabaseClient | null = null;
function getSupabase(): SupabaseClient {
  if (_supa) return _supa;
  _supa = createClient(
    process.env.SUPABASE_URL || '',
    process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  return _supa;
}

// ── Commission par plateforme ───────────────────────────────────
const PLATFORM_COMMISSION: Record<string, number> = {
  UBER: 0.75,
  BOLT: 0.8,
  HEETCH: 0.82,
  FREENOW: 0.85,
  MARCEL: 0.82,
  LECAB: 0.8,
  PRIVATE: 1.0,
  OTHER: 0.8,
};

const _boltCommissionCache = { rate: 0.8, updatedAt: 0 };

function getCommissionRate(source: string): number {
  if (source === 'BOLT' && Date.now() - _boltCommissionCache.updatedAt < 86_400_000) {
    return _boltCommissionCache.rate;
  }
  return PLATFORM_COMMISSION[source] ?? 0.8;
}

// ── Rate limit (10 req/min par driver) ──────────────────────────
const _rateMap = new Map<string, { count: number; resetAt: number }>();
function checkRateLimit(driverId: string): boolean {
  const now = Date.now();
  const entry = _rateMap.get(driverId);
  if (!entry || now > entry.resetAt) {
    _rateMap.set(driverId, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  entry.count++;
  return entry.count <= 10;
}

// ── Zod schema ──────────────────────────────────────────────────
const InstantDecisionSchema = z.object({
  driverId: z.string().min(1),
  estimatedFare: z.number().min(0).max(1000),
  estimatedDistance: z.number().min(0).max(500),
  estimatedDuration: z.number().min(0).max(600),
  distanceToPickup: z.number().min(0).max(100),
  driverLat: z.number().min(-90).max(90),
  driverLng: z.number().min(-180).max(180),
  destinationLat: z.number().min(-90).max(90).optional(),
  destinationLng: z.number().min(-180).max(180).optional(),
  source: z.enum(['UBER', 'BOLT', 'HEETCH', 'FREENOW', 'MARCEL', 'LECAB', 'PRIVATE', 'OTHER']),
  surgeMultiplier: z.number().min(0.5).max(5).optional(),
  citySlug: z.string().optional(),
});

// ── POST /instant-decision ──────────────────────────────────────
router.post('/instant-decision', async (req: Request, res: Response) => {
  const start = Date.now();

  const parsed = InstantDecisionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid input', details: parsed.error.issues });
  }
  const body = parsed.data;

  if (!checkRateLimit(body.driverId)) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  try {
    // 1. Commission et fare net
    const commissionRate = getCommissionRate(body.source);
    const netFare = body.estimatedFare * commissionRate;

    // 2. Calculs H3 avant le Promise.all
    const supabase = getSupabase();
    const today = new Date().toISOString().split('T')[0];
    const now = new Date();
    const hour = now.getHours();
    const dayOfWeek = now.getDay(); // 0=dim, 6=sam

    let destH3Parent: string | null = null;
    if (body.destinationLat && body.destinationLng) {
      const destH3 = h3.latLngToCell(body.destinationLat, body.destinationLng, 9);
      destH3Parent = h3.cellToParent(destH3, 8);
    }
    // Zone de départ du chauffeur (signal "fuir zone morte / rester zone chaude")
    const originH3 = h3.cellToParent(h3.latLngToCell(body.driverLat, body.driverLng, 9), 8);

    // 3. Phase 1 — toutes les requêtes en parallèle
    const [zoneResult, prefsResult, ridesResult, profileResult, cityProfile, originZoneRaw] =
      await Promise.all([
        destH3Parent
          ? getPersonalizedZoneScore(body.driverId, destH3Parent, hour)
          : Promise.resolve(0.5),
        supabase
          .from('user_preferences')
          .select('daily_objective_enabled, daily_objective_amount, course_coach_enabled')
          .eq('user_id', body.driverId)
          .single(),
        supabase
          .from('rides')
          .select('fare:estimated_fare')
          .eq('driver_id', body.driverId)
          .gte('created_at', `${today}T00:00:00`)
          .not('fare', 'is', null),
        supabase
          .from('user_profiles')
          .select('vehicle_category, city_slug, first_name')
          .eq('user_id', body.driverId)
          .single(),
        getCityProfile(body.citySlug ?? 'paris'),
        getZoneScore(originH3).catch(() => null),
      ]);

    // 4. Vehicle × ville — référentiel de base
    const vehicleCategory = (profileResult.data?.vehicle_category ??
      'VTC_STANDARD') as VehicleCategory;
    const firstName = (profileResult.data?.first_name ?? '') as string;
    const name = firstName ? `${firstName}, ` : '';
    const resolvedCitySlug = body.citySlug ?? profileResult.data?.city_slug ?? 'paris';

    const baseEurHourRef = getEurHourRef(vehicleCategory, cityProfile);
    const baseAcceptThreshold = getAcceptThreshold(vehicleCategory, cityProfile);

    // 5. Phase 2 — calibration personnelle (cache chaud <1ms, froid ~40ms)
    const calibration = await getDriverCalibration(
      supabase,
      body.driverId,
      baseEurHourRef,
      baseAcceptThreshold,
    );

    // 5b. S7 — Calibration bayésienne multi-niveau (perso + collectif + city)
    // Gated via FOREAS_BAYESIAN_ENABLED=true : rollout progressif
    // En mode log-only par défaut (observabilité sans changer verdicts)
    let bayesianOverride: { eurHourRef: number; acceptThreshold: number } | null = null;
    try {
      const bayesian = await getBayesianCalibration({
        driverId: body.driverId,
        vehicleCategory,
        cityProfile,
        h3Zone: originH3 || 'unknown',
        hourSlot: hour,
      });
      console.log(
        `[Bayesian] driver=${body.driverId.substring(0, 8)} eurH=${bayesian.eurHourRef} ` +
          `thresh=${bayesian.acceptThreshold} conf=${bayesian.confidence.toFixed(2)} ` +
          `wPers=${bayesian.breakdown.weightPersonal.toFixed(2)} ` +
          `wColl=${bayesian.breakdown.weightCollective.toFixed(2)} ` +
          `wCity=${bayesian.breakdown.weightCity.toFixed(2)} ` +
          `(perso=${bayesian.breakdown.personalSamples}, coll=${bayesian.breakdown.collectiveSamples})`,
      );
      if (process.env.FOREAS_BAYESIAN_ENABLED === 'true') {
        bayesianOverride = {
          eurHourRef: bayesian.eurHourRef,
          acceptThreshold: bayesian.acceptThreshold,
        };
      }
    } catch (e: any) {
      console.warn('[Bayesian] failed (non-blocking):', e?.message);
    }

    // 6. Créneaux horaires (city profile)
    const rushHour = isRushHour(hour, cityProfile);
    const nightActive = isNightActive(hour, cityProfile);
    const deadheadMin = estimateDeadheadMinutes(body.distanceToPickup, cityProfile);

    // 7. €/h réel (deadhead inclus)
    const totalMin = deadheadMin + body.estimatedDuration;
    const eurPerHour = totalMin > 0 ? (netFare / totalMin) * 60 : 0;

    // 8. Score zone destination + objectif
    const destZoneScore = typeof zoneResult === 'number' ? zoneResult : 0.5;
    const prefs = prefsResult.data;
    const objectiveActive = prefs?.daily_objective_enabled ?? false;
    const objectiveAmount = prefs?.daily_objective_amount ?? 250;
    const caToday =
      (ridesResult.data as any[])?.reduce((sum: number, r: any) => sum + (r.fare ?? 0), 0) ?? 0;
    const ridesToday = (ridesResult.data as any[])?.length ?? 0;

    // 9. SIGNAL 3 — Retard sur rythme objectif, aware de l'heure
    // Modèle : shift type 8h→22h (14h). À 15h = 50% du shift = 50% de l'objectif attendu.
    const SHIFT_START = 8;
    const SHIFT_END = 22;
    const shiftProgress = Math.min(
      1,
      Math.max(0, (hour - SHIFT_START) / (SHIFT_END - SHIFT_START)),
    );
    const objectiveProgress =
      objectiveActive && objectiveAmount > 0 ? caToday / objectiveAmount : shiftProgress;
    // paceRatio < 1 = en retard, > 1 = en avance
    const paceRatio = objectiveActive ? objectiveProgress / Math.max(0.05, shiftProgress) : 1;
    const paceUrgencyWeight = objectiveActive ? Math.max(0, Math.min(1, (1 - paceRatio) * 1.8)) : 0;

    // 9b. Objectif comme boussole — ajuste le SEUIL d'acceptation (bidirectionnel)
    // En retard → baisser le seuil (accepter plus pour rattraper le CA)
    // En avance → monter le seuil (être sélectif, garder le rythme qualité)
    // Quasi atteint → seuil max (protéger les gains, uniquement les meilleures)
    let objectiveThresholdDelta = 0;
    if (objectiveActive && shiftProgress > 0.15) {
      if (objectiveProgress > 0.92) {
        // Objectif presque atteint → mode "premium only"
        objectiveThresholdDelta = +8;
      } else if (paceRatio < 0.55) {
        // Très en retard (moins de 55% du rythme attendu) → accepte tout ce qui est rentable
        objectiveThresholdDelta = -10;
      } else if (paceRatio < 0.75) {
        objectiveThresholdDelta = -6;
      } else if (paceRatio < 0.9) {
        objectiveThresholdDelta = -2;
      } else if (paceRatio > 1.4) {
        objectiveThresholdDelta = +6;
      } else if (paceRatio > 1.2) {
        objectiveThresholdDelta = +3;
      }
    }

    // 10. SIGNAL 6 — Bonus jour de semaine
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    const isFridayEvening = dayOfWeek === 5 && hour >= 17 && hour <= 23;
    const dayOfWeekBonus = isWeekend || isFridayEvening ? 0.1 : 0;

    // 11. SIGNAL 7 — Zone de départ
    // score: 0-1 depuis ZoneScoreCache. surgeActive comme proxy si score absent.
    const originScore =
      typeof (originZoneRaw as any)?.score === 'number'
        ? ((originZoneRaw as any).score as number)
        : (originZoneRaw as any)?.surgeActive
          ? 0.75
          : 0.4;
    // Zone morte (<0.30) → bonus pour accepter et fuir. Zone chaude (>0.70) → malus pour quitter.
    const originZoneBonus = originScore < 0.3 ? 0.08 : originScore > 0.7 ? -0.06 : 0;

    // 12. SIGNAL 4+5 — Surge zone destination + surge plateforme
    let destSurgeActive = false;
    if (destH3Parent) {
      const rawZone = await getZoneScore(destH3Parent);
      destSurgeActive = rawZone?.surgeActive ?? false;
    }
    const timeBonus = destSurgeActive ? 0.15 : nightActive || rushHour ? 0.08 : 0;
    const surgeBonus = (body.surgeMultiplier ?? 1) > 1.2 ? 0.2 : 0;

    // 13. Pénalité longue course
    const isLongRide = body.estimatedDistance > 30;
    const longRidePenalty = isLongRide ? 0.05 : 0;

    // 14. Seuil final — calibration + fatigue shift + objectif (boussole principale)
    // Ordre de priorité : calibration perso → objectif (dominant) → fatigue shift
    const fatigueDelta = ridesToday > 20 ? -3 : ridesToday > 15 ? -2 : 0;
    // S7 — Override avec bayésien si flag activé, sinon legacy DriverCalibrationCache
    const finalEurHourRef = bayesianOverride?.eurHourRef ?? calibration.eurHourRef;
    const finalAcceptThreshold = Math.max(
      30,
      (bayesianOverride?.acceptThreshold ?? calibration.acceptThreshold) +
        objectiveThresholdDelta +
        fatigueDelta,
    );

    // 15. Score composite (10 signaux)
    const scoreRaw =
      (eurPerHour / finalEurHourRef) * 0.3 + // €/h personnalisé
      destZoneScore * 0.22 + // zone destination (perso)
      paceUrgencyWeight * 0.16 + // retard sur rythme (time-aware)
      timeBonus * 0.1 + // rush/nuit/surge zone
      surgeBonus * 0.08 + // surge plateforme
      dayOfWeekBonus * 0.06 + // jour de semaine
      originZoneBonus * 0.06 - // zone de départ
      (body.distanceToPickup / 15) * 0.12 - // deadhead
      longRidePenalty; // longue course

    const score = Math.min(100, Math.max(0, Math.round(scoreRaw * 100)));

    // 16. Verdict + raison avec prénom
    const verdict: 'ACCEPT' | 'DECLINE' = score > finalAcceptThreshold ? 'ACCEPT' : 'DECLINE';

    // Pourcentage de l'objectif atteint (pour les messages contextuels)
    const objPct = Math.round(objectiveProgress * 100);

    let reason: string;
    if (verdict === 'ACCEPT') {
      if (objectiveProgress > 0.92) reason = `${name}presque à l'objectif, prends du bon.`;
      else if (destSurgeActive) reason = `${name}zone en demande maintenant.`;
      else if (paceRatio < 0.6 && objectiveActive)
        reason = `${name}${objPct}% de l'objectif, accélère.`;
      else if (eurPerHour > finalEurHourRef * 1.2)
        reason = `${name}${Math.round(eurPerHour)}€/h net, très bon.`;
      else if (vehicleCategory === 'BERLINE_T3' && eurPerHour > finalEurHourRef)
        reason = `${name}course premium, prends-la.`;
      else if (paceUrgencyWeight > 0.5) reason = `${name}en retard sur l'objectif, prends-la.`;
      else if (isFridayEvening || isWeekend) reason = `${name}bonne période, profites-en.`;
      else reason = `${name}équilibre correct, prends-la.`;
    } else {
      if (objectiveProgress > 0.92) reason = `${name}objectif quasi atteint, attends mieux.`;
      else if (body.distanceToPickup > 8) reason = `${name}trop loin pour récupérer.`;
      else if (eurPerHour < finalEurHourRef * 0.5)
        reason = `${name}${Math.round(eurPerHour)}€/h, pas rentable.`;
      else if (vehicleCategory === 'BERLINE_T3')
        reason = `${name}en dessous de ton standard berline.`;
      else if (destZoneScore < 0.25) reason = `${name}zone calme à l'arrivée.`;
      else if (originScore > 0.7) reason = `${name}ta zone actuelle est meilleure.`;
      else reason = `${name}mieux à proximité bientôt.`;
    }

    // 17. Log scoring
    console.log(
      `[CoachScoring] ${vehicleCategory} @${resolvedCitySlug} | ` +
        `€/h=${eurPerHour.toFixed(1)} ref=${finalEurHourRef}(base=${baseEurHourRef}) ` +
        `calib_conf=${calibration.confidence.toFixed(2)} ` +
        `threshold=${finalAcceptThreshold}(base=${baseAcceptThreshold}) ` +
        `score=${score} verdict=${verdict} ` +
        `day=${dayOfWeek} origin=${originScore.toFixed(2)} pace=${paceUrgencyWeight.toFixed(2)}`,
    );

    // 18. Log async (fire & forget)
    supabase
      .from('pieuvre_screen_reader_events')
      .insert({
        driver_id: body.driverId,
        source_platform: body.source,
        estimated_fare: body.estimatedFare,
        net_fare: netFare,
        distance_to_pickup: body.distanceToPickup,
        coach_verdict: verdict,
        coach_score: score,
        coach_reason: reason,
        eur_per_hour: eurPerHour,
        vehicle_category: vehicleCategory,
        eur_hour_reference: finalEurHourRef,
        accept_threshold_used: finalAcceptThreshold,
        created_at: new Date().toISOString(),
      })
      .then(
        () => {},
        (e: any) => console.error('[CoachLog]', e.message),
      );

    return res.json({
      verdict,
      reason,
      eurPerHour: Math.round(eurPerHour * 10) / 10,
      score,
      confidenceMs: Date.now() - start,
    });
  } catch (err: any) {
    console.error('[CoachInstant] Error:', err?.message);
    return res.json({
      verdict: 'ACCEPT',
      reason: 'Décide toi-même.',
      eurPerHour: 0,
      score: 50,
      confidenceMs: Date.now() - start,
    });
  }
});

// ── POST /record-outcome ────────────────────────────────────────
router.post('/record-outcome', async (req: Request, res: Response) => {
  const { driverId, h3Index, hourSlot, verdict, actualFare, estimatedFare, followedAdvice } =
    req.body;
  if (!driverId || !h3Index) return res.status(400).json({ error: 'Missing fields' });

  const outcomeScore = followedAdvice ? Math.min(1, actualFare / Math.max(estimatedFare, 1)) : 0.4;

  const supabase = getSupabase();
  await supabase
    .from('ajnaya_learning_data')
    .insert({
      driver_id: driverId,
      h3_zone: h3Index,
      hour_slot: hourSlot,
      verdict_given: verdict,
      outcome_score: outcomeScore,
      actual_fare: actualFare,
      estimated_fare: estimatedFare,
      followed_advice: followedAdvice,
      created_at: new Date().toISOString(),
    })
    .then(
      () => {},
      (e: any) => console.error('[CoachOutcome]', e.message),
    );

  // Invalide le cache de calibration → prochain verdict recalibré immédiatement
  invalidateCalibration(driverId);
  // S7 — Invalide aussi la calibration bayésienne (perso samples +1)
  invalidateBayesianCache(driverId);

  return res.json({ ok: true });
});

// ── POST /refresh-bolt-commission ───────────────────────────────
router.post('/refresh-bolt-commission', async (req: Request, res: Response) => {
  const internalKey = req.headers['x-internal-key'];
  if (internalKey !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { fetchBoltCommissionRate } = await import('../services/BoltApiService.js');
    const result = await fetchBoltCommissionRate(req.body?.city || 'paris');

    if (result) {
      _boltCommissionCache.rate = result.commissionRate;
      _boltCommissionCache.updatedAt = Date.now();

      const supabase = getSupabase();
      await supabase.from('pieuvre_platform_commissions').upsert(
        {
          platform: 'BOLT',
          city: result.city,
          commission_rate: result.commissionRate,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'platform,city' },
      );
    }

    return res.json({ ok: true, rate: result?.commissionRate ?? _boltCommissionCache.rate });
  } catch (e: any) {
    return res.json({ ok: false, rate: _boltCommissionCache.rate, error: e?.message });
  }
});

// ── GET /weekly-summary/:driverId ───────────────────────────────
router.get('/weekly-summary/:driverId', async (req: Request, res: Response) => {
  const { driverId } = req.params;
  const supabase = getSupabase();
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();

  const [decisions, outcomes] = await Promise.all([
    supabase
      .from('pieuvre_screen_reader_events')
      .select('coach_verdict, coach_score, eur_per_hour, source_platform')
      .eq('driver_id', driverId)
      .gte('created_at', weekAgo),
    supabase
      .from('ajnaya_learning_data')
      .select('outcome_score, actual_fare, followed_advice')
      .eq('driver_id', driverId)
      .gte('created_at', weekAgo),
  ]);

  const totalDecisions = decisions.data?.length ?? 0;
  const acceptRate =
    totalDecisions > 0
      ? (decisions.data!.filter((d: any) => d.coach_verdict === 'ACCEPT').length / totalDecisions) *
        100
      : 0;
  const avgScore =
    totalDecisions > 0
      ? decisions.data!.reduce((s: number, d: any) => s + d.coach_score, 0) / totalDecisions
      : 0;
  const followedAdviceRate = outcomes.data?.length
    ? ((outcomes.data as any[]).filter((o: any) => o.followed_advice).length /
        outcomes.data.length) *
      100
    : 0;
  const totalEarned =
    (outcomes.data as any[])?.reduce((s: number, o: any) => s + (o.actual_fare ?? 0), 0) ?? 0;

  return res.json({
    period: { from: weekAgo, to: new Date().toISOString() },
    totalDecisions,
    acceptRate: Math.round(acceptRate),
    avgScore: Math.round(avgScore),
    followedAdviceRate: Math.round(followedAdviceRate),
    totalEarned: Math.round(totalEarned),
  });
});

// ── GET /health ─────────────────────────────────────────────────
router.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    supabaseCircuitOpen: isCircuitOpen(),
    cacheSize: getCacheSize(),
    calibrationCacheSize: getCalibCacheSize(),
    boltCommissionAge: Date.now() - _boltCommissionCache.updatedAt,
    uptimeSeconds: Math.floor(process.uptime()),
  });
});

// ── GET /decision-context?driver_id=X ──────────────────────────
// Pré-charge le contexte du chauffeur en cache 5min.
// Réponse < 5ko. Jamais bloquant (timeout 800ms, fallback vide).
const _ctxCache = new Map<string, { data: object; expiresAt: number }>();

router.get('/decision-context', async (req: Request, res: Response) => {
  const driverId = String(req.query.driver_id ?? '').trim();
  if (!driverId) return res.status(400).json({ error: 'driver_id requis' });

  const cached = _ctxCache.get(driverId);
  if (cached && Date.now() < cached.expiresAt) {
    return res.json({ ...cached.data, from_cache: true });
  }

  const supabase = getSupabase();
  const today = new Date().toISOString().split('T')[0];
  const timeout = (ms: number) =>
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms));

  try {
    const [prefsRaw, ridesRaw, profileRaw, driverGeoRaw] = await Promise.all([
      Promise.race([
        supabase
          .from('user_preferences')
          .select('daily_objective_enabled,daily_objective_amount,course_coach_enabled')
          .eq('user_id', driverId)
          .single(),
        timeout(800),
      ]),
      Promise.race([
        supabase
          .from('rides')
          .select('fare:estimated_fare')
          .eq('driver_id', driverId)
          .gte('created_at', `${today}T00:00:00`)
          .not('fare', 'is', null),
        timeout(800),
      ]),
      Promise.race([
        supabase
          .from('user_profiles')
          .select('vehicle_category,city_slug,first_name')
          .eq('user_id', driverId)
          .single(),
        timeout(800),
      ]),
      // ZONE_INTEL: dernière position connue du chauffeur (optionnel)
      Promise.race([
        supabase.from('drivers').select('lat,lng').eq('id', driverId).single(),
        timeout(800),
      ]),
    ]);

    const prefs = (prefsRaw as any)?.data ?? {};
    const rides = (ridesRaw as any)?.data ?? [];
    const profile = (profileRaw as any)?.data ?? {};
    const driverGeo = (driverGeoRaw as any)?.data;

    const earnedToday = (rides as any[]).reduce((s: number, r: any) => s + (r.fare ?? 0), 0);

    const vehicleCategory = (profile.vehicle_category ?? 'VTC_STANDARD') as VehicleCategory;
    const citySlug = profile.city_slug ?? 'paris';
    const cityProfile = await getCityProfile(citySlug);
    const eurHourRef = getEurHourRef(vehicleCategory, cityProfile);
    const acceptThreshold = getAcceptThreshold(vehicleCategory, cityProfile);

    // ZONE_INTEL: coordonnées effectives (position driver ou centre ville)
    const [cityLat, cityLng] = CITY_CENTERS[citySlug] ?? CITY_CENTERS.paris;
    const effLat = (typeof driverGeo?.lat === 'number' ? driverGeo.lat : null) ?? cityLat;
    const effLng = (typeof driverGeo?.lng === 'number' ? driverGeo.lng : null) ?? cityLng;

    // FRIGO_ENRICHI — lancer tous les appels externes en parallèle (non-bloquants)
    const hotZonesPromise = fetchHotZones(effLat, effLng).catch((): HotZone[] => []);
    const weatherPromise = fetchWeather(effLat, effLng).catch((): WeatherContext | null => null);
    const calendarPromise = fetchSchoolCalendar(citySlug).catch(
      (): SchoolCalendarContext | null => null,
    );
    const strikePromise = fetchStrikeAlert().catch((): StrikeAlert | null => null);

    const calibration = await Promise.race([
      getDriverCalibration(supabase, driverId, eurHourRef, acceptThreshold),
      timeout(800),
    ]);

    // Collecter toutes les données externes — budget 1500ms max pour l'ensemble
    const [hotZones, weather, schoolCalendar, strikeAlert] = await Promise.all([
      Promise.race([hotZonesPromise, new Promise<HotZone[]>((r) => setTimeout(() => r([]), 1500))]),
      Promise.race([
        weatherPromise,
        new Promise<WeatherContext | null>((r) => setTimeout(() => r(null), 1500)),
      ]),
      Promise.race([
        calendarPromise,
        new Promise<SchoolCalendarContext | null>((r) => setTimeout(() => r(null), 1500)),
      ]),
      Promise.race([
        strikePromise,
        new Promise<StrikeAlert | null>((r) => setTimeout(() => r(null), 1500)),
      ]),
    ]);

    const ctx = {
      driver_id: driverId,
      city_slug: citySlug,
      vehicle_category: vehicleCategory,
      first_name: profile.first_name ?? '',
      eur_hour_ref: (calibration as any)?.eurHourRef ?? eurHourRef,
      accept_threshold: (calibration as any)?.acceptThreshold ?? acceptThreshold,
      calibration_confidence: (calibration as any)?.confidence ?? 0,
      daily_objective: {
        enabled: prefs.daily_objective_enabled ?? false,
        amount: prefs.daily_objective_amount ?? 0,
        earned_today: Math.round(earnedToday * 100) / 100,
        rides_today: (rides as any[]).length,
      },
      coach_enabled: prefs.course_coach_enabled ?? true,
      // ZONE_INTEL
      hot_zones: hotZones,
      hot_zones_source: hotZones.length > 0 ? 'predicthq' : 'none',
      hot_zones_at: new Date().toISOString(),
      // FRIGO_ENRICHI
      weather,
      school_calendar: schoolCalendar,
      strike_alert: strikeAlert,
      cached_at: new Date().toISOString(),
      ttl_seconds: 300,
      from_cache: false,
    };

    _ctxCache.set(driverId, { data: ctx, expiresAt: Date.now() + 300_000 });
    return res.json(ctx);
  } catch (err: any) {
    console.error('[DecisionContext] error:', err?.message);
    return res.json({
      driver_id: driverId,
      cached_at: new Date().toISOString(),
      ttl_seconds: 0,
      from_cache: false,
      error: 'context_unavailable',
    });
  }
});

export default router;
