/**
 * XTwitterAdapter — X/Twitter API v2 → signaux sociaux grèves/perturbations pour Ajnaya
 *
 * API : X/Twitter v2 Recent Search
 * Latence : ~300-500ms
 * Tokens ajoutés : ~30-50 tokens
 *
 * Recherche les signaux sociaux pertinents VTC :
 * grèves, perturbations RATP/SNCF, manifestations Paris
 */

// Cache simple en mémoire (10 min)
let socialCache: { data: string; expires: number } | null = null;
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

const SEARCH_QUERY = '#greve OR #RATP OR #SNCF OR perturbation OR manifestation';

interface TwitterTweet {
  id: string;
  text: string;
  created_at?: string;
}

interface TwitterSearchResponse {
  data?: TwitterTweet[];
  meta?: {
    result_count: number;
    newest_id?: string;
    oldest_id?: string;
  };
}

interface SignalCount {
  greve: number;
  ratp: number;
  sncf: number;
  manifestation: number;
  perturbation: number;
}

/**
 * Recherche les signaux sociaux sur X/Twitter liés aux perturbations
 * transport et manifestations à Paris.
 *
 * Exemples de sortie :
 * "SOCIAL : #greve RATP tendance (47 tweets/h). Manifestation signalée Bastille-Nation."
 * "" (rien de notable → pas de contexte ajouté)
 */
export async function getSocialContext(): Promise<string> {
  // Check cache
  if (socialCache && Date.now() < socialCache.expires) {
    return socialCache.data;
  }

  const bearerToken = process.env.X_BEARER_TOKEN;
  if (!bearerToken) {
    console.warn('[XTwitterAdapter] Pas de clé X_BEARER_TOKEN');
    return '';
  }

  try {
    const url = buildSearchUrl();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${bearerToken}`,
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      console.warn(`[XTwitterAdapter] HTTP ${res.status}`);
      return '';
    }

    const data: TwitterSearchResponse = await res.json();
    const context = formatSocialContext(data);

    // Cache
    socialCache = { data: context, expires: Date.now() + CACHE_TTL };
    if (context) console.log('[XTwitterAdapter] ✅', context.substring(0, 80));

    return context;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[XTwitterAdapter] Erreur:', message);
    return '';
  }
}

function buildSearchUrl(): string {
  // Search tweets from the last hour
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const startTime = oneHourAgo.toISOString();

  const params = new URLSearchParams({
    query: `(${SEARCH_QUERY}) lang:fr`,
    'tweet.fields': 'created_at',
    max_results: '100',
    start_time: startTime,
  });

  return `https://api.twitter.com/2/tweets/search/recent?${params.toString()}`;
}

function formatSocialContext(data: TwitterSearchResponse): string {
  const tweets = data.data || [];
  const totalCount = data.meta?.result_count || tweets.length;

  if (totalCount < 5) {
    // Not enough signal — return empty
    return '';
  }

  // Count signal types
  const signals: SignalCount = {
    greve: 0,
    ratp: 0,
    sncf: 0,
    manifestation: 0,
    perturbation: 0,
  };

  for (const tweet of tweets) {
    const text = tweet.text.toLowerCase();
    if (text.includes('greve') || text.includes('grève')) signals.greve++;
    if (text.includes('ratp')) signals.ratp++;
    if (text.includes('sncf')) signals.sncf++;
    if (text.includes('manifestation') || text.includes('manif')) signals.manifestation++;
    if (text.includes('perturbation')) signals.perturbation++;
  }

  const parts: string[] = [];

  // Build compact summary
  if (signals.greve >= 3) {
    const target = signals.ratp > signals.sncf ? 'RATP' : 'SNCF';
    parts.push(`#greve ${target} tendance (${totalCount} tweets/h)`);
  }

  if (signals.manifestation >= 3) {
    parts.push('Manifestation signalée Paris');
  }

  if (signals.perturbation >= 5 && parts.length === 0) {
    parts.push(`Perturbations transport signalées (${signals.perturbation} mentions)`);
  }

  if (parts.length === 0) {
    // Some activity but not significant enough
    if (totalCount >= 20) {
      parts.push(`Activité transport élevée sur X (${totalCount} tweets/h)`);
    } else {
      return '';
    }
  }

  return `SOCIAL : ${parts.join('. ')}. Demande VTC potentiellement en hausse.`;
}
