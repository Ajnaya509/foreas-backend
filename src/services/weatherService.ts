/**
 * weatherService.ts — Open-Meteo (modèle Météo-France AROME, JSON gratuit)
 *
 * Open-Meteo consomme les données AROME de Météo-France et les expose
 * en JSON simple — pas besoin de parser le GRIB binaire de l'API WCS AROME-PI.
 * La clé METEO_FRANCE_API_KEY est conservée pour un usage WCS avancé futur.
 *
 * Données historiques VTC France :
 *   CLEAR/CLOUDY ×1.0 | RAIN ×1.35 | HEAVY_RAIN/STORM ×1.6
 *
 * Cache 10 min par coordonnées (arrondi 0.02°).
 *
 * WMO weather_code → nowCode :
 *   0-1 → CLEAR | 2-3 → CLOUDY | 51-67, 80-82 → RAIN/HEAVY_RAIN
 *   71-77 → CLOUDY (neige, pas d'impact VTC majeur)
 *   95-99 → STORM
 */

export interface WeatherContext {
  nowCode: 'CLEAR' | 'CLOUDY' | 'RAIN' | 'HEAVY_RAIN' | 'STORM';
  rainIn30min: boolean;
  tempC: number;
  demandMultiplier: number;
}

const _weatherCache = new Map<string, { data: WeatherContext; expiresAt: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000;

// WMO 4677 weather codes → nowCode
function wmoToCode(code: number, precipMm: number): WeatherContext['nowCode'] {
  if (code >= 95) return 'STORM';
  if (code >= 80 || (code >= 61 && code <= 67)) {
    return precipMm > 5 ? 'HEAVY_RAIN' : 'RAIN';
  }
  if (code >= 51 && code <= 57) return 'RAIN';
  if (code === 2 || code === 3) return 'CLOUDY';
  if (precipMm > 5) return 'HEAVY_RAIN';
  if (precipMm > 0.5) return 'RAIN';
  return 'CLEAR';
}

function codeToMultiplier(code: WeatherContext['nowCode']): number {
  if (code === 'STORM' || code === 'HEAVY_RAIN') return 1.6;
  if (code === 'RAIN') return 1.35;
  return 1.0;
}

const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/meteofrance';

export async function fetchWeather(lat: number, lng: number): Promise<WeatherContext | null> {
  const cacheKey = `${lat.toFixed(2)}_${lng.toFixed(2)}`;
  const cached = _weatherCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.data;

  try {
    const url =
      `${OPEN_METEO_URL}?latitude=${lat}&longitude=${lng}` +
      `&current=precipitation,temperature_2m,weather_code,wind_speed_10m` +
      `&hourly=precipitation&forecast_days=1&timezone=Europe%2FParis`;

    const resp = (await fetch(url, { signal: AbortSignal.timeout(800) })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)) as any;

    if (!resp?.current) return null;

    const cur = resp.current;
    const precipNow: number = cur.precipitation ?? 0;
    const tempC: number = cur.temperature_2m ?? 15;
    const wmoCode: number = cur.weather_code ?? 0;
    const windKmh: number = cur.wind_speed_10m ?? 0;

    // Précipitations dans l'heure suivante (approx. "dans 30 min")
    const nowHour = new Date().getHours();
    const hourlyPrecip: number[] = resp.hourly?.precipitation ?? [];
    const nextPrecip = hourlyPrecip[nowHour + 1] ?? 0;

    let nowCode = wmoToCode(wmoCode, precipNow);
    if (windKmh > 80 && nowCode !== 'STORM') nowCode = 'STORM';

    const weather: WeatherContext = {
      nowCode,
      rainIn30min: precipNow > 0.1 || nextPrecip > 0.1,
      tempC: Math.round(tempC),
      demandMultiplier: codeToMultiplier(nowCode),
    };

    _weatherCache.set(cacheKey, { data: weather, expiresAt: Date.now() + CACHE_TTL_MS });
    return weather;
  } catch {
    return null;
  }
}
