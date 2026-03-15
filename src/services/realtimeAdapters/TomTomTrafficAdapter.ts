/**
 * TomTomTrafficAdapter — TomTom Traffic Flow API → contexte trafic compact pour Ajnaya
 *
 * API : TomTom Traffic Flow (2 500 req/jour gratuit)
 * Latence : ~200-400ms
 * Tokens ajoutés : ~30-50 tokens
 */

// Cache simple en mémoire (3 min)
let trafficCache: { data: string; expires: number } | null = null;
const CACHE_TTL = 3 * 60 * 1000; // 3 minutes

const DEFAULT_LAT = 48.8566;
const DEFAULT_LNG = 2.3522;

interface TomTomFlowResponse {
  flowSegmentData: {
    frc: string;
    currentSpeed: number;
    freeFlowSpeed: number;
    currentTravelTime: number;
    freeFlowTravelTime: number;
    confidence: number;
    roadClosure: boolean;
  };
}

/**
 * Récupère le trafic autour de la position du chauffeur
 * et retourne un contexte compact.
 *
 * Exemples de sortie :
 * "TRAFIC : Fluide sur les axes principaux. Vitesse normale."
 * "TRAFIC : Ralentissements détectés (~15min de retard). Vitesse 22km/h (normal 50km/h)."
 */
export async function getTrafficContext(lat?: number, lng?: number): Promise<string> {
  // Check cache
  if (trafficCache && Date.now() < trafficCache.expires) {
    return trafficCache.data;
  }

  const apiKey = process.env.TOMTOM_API_KEY;
  if (!apiKey) {
    console.warn('[TomTomTrafficAdapter] Pas de clé TOMTOM_API_KEY');
    return '';
  }

  try {
    const useLat = lat ?? DEFAULT_LAT;
    const useLng = lng ?? DEFAULT_LNG;

    const url = `https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json?point=${useLat},${useLng}&key=${apiKey}&unit=KMPH`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);

    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) {
      console.warn(`[TomTomTrafficAdapter] HTTP ${res.status}`);
      return '';
    }

    const data: TomTomFlowResponse = await res.json();
    const context = formatTrafficContext(data);

    // Cache
    trafficCache = { data: context, expires: Date.now() + CACHE_TTL };
    console.log('[TomTomTrafficAdapter] ✅', context);

    return context;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[TomTomTrafficAdapter] Erreur:', message);
    return '';
  }
}

function formatTrafficContext(data: TomTomFlowResponse): string {
  const flow = data.flowSegmentData;

  if (flow.roadClosure) {
    return 'TRAFIC : Route fermée détectée à proximité. Contourne la zone.';
  }

  const currentSpeed = Math.round(flow.currentSpeed);
  const freeFlowSpeed = Math.round(flow.freeFlowSpeed);
  const ratio = freeFlowSpeed > 0 ? currentSpeed / freeFlowSpeed : 1;

  if (ratio >= 0.85) {
    return `TRAFIC : Fluide (${currentSpeed}km/h, normal ${freeFlowSpeed}km/h). Conditions optimales.`;
  } else if (ratio >= 0.6) {
    const delayMin = Math.round((flow.currentTravelTime - flow.freeFlowTravelTime) / 60);
    return `TRAFIC : Ralentissements (${currentSpeed}km/h au lieu de ${freeFlowSpeed}km/h, +${delayMin}min). Demande VTC en hausse.`;
  } else {
    const delayMin = Math.round((flow.currentTravelTime - flow.freeFlowTravelTime) / 60);
    return `TRAFIC : Très chargé (${currentSpeed}km/h au lieu de ${freeFlowSpeed}km/h, +${delayMin}min). Surge probable, courses courtes rentables.`;
  }
}
