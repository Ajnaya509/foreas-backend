/**
 * WeatherAdapter — OpenWeather API → contexte compact pour Ajnaya
 *
 * Gratuit : 1 000 appels/jour (largement suffisant avec cache 10min)
 * Latence : ~100-200ms
 * Tokens ajoutés : ~30-50 tokens
 */

// Cache simple en mémoire (10 min)
let weatherCache: { data: string; expires: number } | null = null;
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

const PARIS_LAT = 48.8566;
const PARIS_LNG = 2.3522;

interface OpenWeatherResponse {
  weather: Array<{ main: string; description: string }>;
  main: { temp: number; feels_like: number; humidity: number };
  wind: { speed: number };
  rain?: { '1h'?: number };
  snow?: { '1h'?: number };
  visibility: number;
}

/**
 * Récupère la météo Paris et retourne un contexte compact
 * pour injection dans le system prompt Ajnaya.
 *
 * Exemples de sortie :
 * "MÉTÉO : 9°C nuageux, vent 4km/h. Pas de pluie."
 * "MÉTÉO : 3°C pluie forte (2.5mm/h), vent 25km/h. ⚠️ Demande VTC +25-30%."
 */
export async function getWeatherContext(): Promise<string> {
  // Check cache
  if (weatherCache && Date.now() < weatherCache.expires) {
    return weatherCache.data;
  }

  const apiKey = process.env.OPENWEATHER_KEY;
  if (!apiKey) {
    console.warn('[WeatherAdapter] Pas de clé OPENWEATHER_KEY');
    return '';
  }

  try {
    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${PARIS_LAT}&lon=${PARIS_LNG}&appid=${apiKey}&units=metric&lang=fr`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) {
      console.warn(`[WeatherAdapter] HTTP ${res.status}`);
      return '';
    }

    const data: OpenWeatherResponse = await res.json();
    const context = formatWeatherContext(data);

    // Cache
    weatherCache = { data: context, expires: Date.now() + CACHE_TTL };
    console.log('[WeatherAdapter] ✅', context);

    return context;
  } catch (err: any) {
    console.warn('[WeatherAdapter] Erreur:', err.message);
    return '';
  }
}

function formatWeatherContext(data: OpenWeatherResponse): string {
  const temp = Math.round(data.main.temp);
  const feelsLike = Math.round(data.main.feels_like);
  const description = data.weather[0]?.description || 'inconnu';
  const windKmh = Math.round(data.wind.speed * 3.6);
  const rainMm = data.rain?.['1h'] || 0;
  const snowMm = data.snow?.['1h'] || 0;

  let context = `MÉTÉO : ${temp}°C (ressenti ${feelsLike}°C) ${description}, vent ${windKmh}km/h.`;

  if (rainMm > 0) {
    context += ` Pluie ${rainMm}mm/h.`;
    if (rainMm > 1) {
      context += ' ⚠️ Forte pluie = demande VTC +25-30%, surge probable.';
    } else {
      context += ' Pluie légère = demande VTC +10-15%.';
    }
  } else if (snowMm > 0) {
    context += ` Neige ${snowMm}mm/h. ⚠️ Demande VTC explosive, routes glissantes.`;
  } else {
    context += ' Pas de pluie.';
  }

  if (windKmh > 40) {
    context += ' Vent fort, attention conduite.';
  }

  if (data.visibility < 1000) {
    context += ' Visibilité réduite (<1km).';
  }

  return context;
}
