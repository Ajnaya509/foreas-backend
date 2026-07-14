/**
 * ApifyPlacesScraperService — trouve de VRAIES entreprises (hôtels, conciergeries,
 * etc.) via le Google Maps Scraper Apify et remplit `places_directory`.
 *
 * C'est la pièce manquante de la pipeline client privé : ApolloEnrichmentService
 * enrichit déjà `places_directory` (email du décideur) mais la table était vide
 * depuis toujours — rien n'allait jamais la remplir. Ce service = l'étape 0.
 *
 * Flux complet : ce service (Apify → places_directory) → ApolloEnrichmentService
 * (places_directory → email décideur) → ClientFinderService (email → outreach).
 *
 * Actor utilisé : compass/crawler-google-places ("Google Maps Scraper"), le plus
 * utilisé sur Apify (30M+ runs). Coût : quelques centimes pour un run modeste,
 * largement dans le plan gratuit 5$/mois de ce compte.
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js';

let _supa: SupabaseClient | null = null;
function getSupa(): SupabaseClient {
  if (_supa) return _supa;
  _supa = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return _supa;
}

const APIFY_TOKEN = () => process.env.APIFY_API_TOKEN || process.env.APIFY_API_KEY;
const ACTOR_ID = 'compass~crawler-google-places';

export type PlaceTypeFamily =
  | 'HOSPITALITY'
  | 'HIGH_INCOME'
  | 'EVENT'
  | 'GASTRONOMY'
  | 'CORPORATE'
  | 'HEALTH_LUXURY'
  | 'REAL_ESTATE'
  | 'DIPLOMATIC';

/** Termes de recherche par famille — élargir ici plutôt qu'ailleurs. */
const SEARCH_TERMS_BY_FAMILY: Record<PlaceTypeFamily, string[]> = {
  HOSPITALITY: ['hôtel', 'conciergerie'],
  GASTRONOMY: ['restaurant gastronomique'],
  EVENT: ['salle de réception', 'wedding planner'],
  HIGH_INCOME: [],
  CORPORATE: [],
  HEALTH_LUXURY: [],
  REAL_ESTATE: [],
  DIPLOMATIC: [],
};

interface ApifyPlaceResult {
  title?: string;
  address?: string;
  city?: string;
  phone?: string;
  phoneUnformatted?: string;
  website?: string;
  placeId?: string;
  location?: { lat?: number; lng?: number };
  categoryName?: string;
  totalScore?: number;
}

export interface ScrapeResult {
  found: number;
  inserted: number;
  skippedDuplicate: number;
  errors: number;
}

/**
 * Lance le scraper pour une famille de lieux dans une ville, et upsert les
 * résultats dans places_directory (enrichment_status='PENDING' → Apollo prend
 * le relai automatiquement au prochain passage).
 */
export async function scrapePlacesForFamily(
  family: PlaceTypeFamily,
  city: string,
  maxPerTerm: number = 15,
): Promise<ScrapeResult> {
  const result: ScrapeResult = { found: 0, inserted: 0, skippedDuplicate: 0, errors: 0 };
  const token = APIFY_TOKEN();
  if (!token) {
    console.warn('[ApifyPlaces] APIFY_API_TOKEN not set — skipping');
    return result;
  }

  const terms = SEARCH_TERMS_BY_FAMILY[family];
  if (!terms.length) {
    console.warn(`[ApifyPlaces] Aucun terme de recherche défini pour ${family}`);
    return result;
  }

  const searchStringsArray = terms.map((t) => `${t} ${city}`);

  try {
    const runRes = await fetch(
      `https://api.apify.com/v2/acts/${ACTOR_ID}/run-sync-get-dataset-items?token=${token}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          searchStringsArray,
          locationQuery: `${city}, France`,
          maxCrawledPlacesPerSearch: maxPerTerm,
          language: 'fr',
          skipClosedPlaces: true,
        }),
      },
    );

    if (!runRes.ok) {
      console.error(
        `[ApifyPlaces] Run failed: ${runRes.status} ${await runRes.text().catch(() => '')}`,
      );
      result.errors++;
      return result;
    }

    const places = (await runRes.json()) as ApifyPlaceResult[];
    result.found = places.length;

    const supa = getSupa();
    for (const p of places) {
      if (!p.placeId || !p.title) continue;
      try {
        const { error } = await supa
          .from('places_directory')
          .upsert(
            {
              google_place_id: p.placeId,
              name: p.title,
              place_type: p.categoryName || family,
              place_type_family: family,
              address: p.address || null,
              city,
              lat: p.location?.lat ?? null,
              lng: p.location?.lng ?? null,
              phone: p.phone || p.phoneUnformatted || null,
              // 'GOOGLE_PLACES' — la seule valeur admise par places_directory_enrichment_source_check
              // (CHECK constraint : GOOGLE_PLACES | MANUAL | N8N). Le detail "via Apify" reste
              // implicite au service, pas dans la colonne — la contrainte ne connaît pas Apify.
              enrichment_source: 'GOOGLE_PLACES',
              enrichment_status: 'PENDING',
              quality_score: p.totalScore ? Math.round(p.totalScore * 20) : null,
            },
            { onConflict: 'google_place_id', ignoreDuplicates: true },
          )
          .select('id');

        if (error) {
          result.errors++;
        } else {
          result.inserted++;
        }
      } catch {
        result.errors++;
      }
    }

    console.log(
      `[ApifyPlaces] ${family}/${city}: ${result.found} trouvés, ${result.inserted} insérés, ${result.errors} erreurs`,
    );
    return result;
  } catch (err: any) {
    console.error('[ApifyPlaces] Scrape error:', err.message);
    result.errors++;
    return result;
  }
}
