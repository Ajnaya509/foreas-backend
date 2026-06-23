/**
 * ApolloEnrichmentService — Enrichit places_directory via Apollo.io
 * Ajnaya2026v88
 *
 * Flux : places sans email → Apollo Org Search → People Search → enrich DB
 * Coût : ~1 crédit/enrichissement personne
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

const APOLLO_API_KEY = () => process.env.APOLLO_API_KEY;
const APOLLO_BASE = 'https://api.apollo.io/api/v1';

const DECISION_MAKER_TITLES = [
  'directeur',
  'directrice',
  'gérant',
  'gérante',
  'manager',
  'responsable',
  'concierge',
  'chef concierge',
  'réceptionniste',
  'directeur général',
  'general manager',
  'front office manager',
  'guest relations',
  'operations manager',
  'owner',
  'propriétaire',
  'fondateur',
  'fondatrice',
];

async function searchApolloOrganization(
  placeName: string,
  city: string,
): Promise<{ org_id: string; domain: string | null; phone: string | null } | null> {
  const key = APOLLO_API_KEY();
  if (!key) return null;

  try {
    const res = await fetch(`${APOLLO_BASE}/mixed_companies/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': key },
      body: JSON.stringify({
        q_organization_name: placeName,
        organization_locations: [city],
        per_page: 3,
        page: 1,
      }),
    });
    if (!res.ok) {
      console.warn(`[ApolloEnrich] Org search failed: ${res.status}`);
      return null;
    }
    const data = await res.json();
    const org = data?.organizations?.[0];
    if (!org) return null;
    return {
      org_id: org.id,
      domain: org.primary_domain || org.website_url || null,
      phone: org.phone || org.corporate_phone || null,
    };
  } catch (err: any) {
    console.error('[ApolloEnrich] Org search error:', err.message);
    return null;
  }
}

async function searchApolloDecisionMaker(
  orgId: string,
  city: string,
): Promise<{
  person_id: string;
  email: string | null;
  name: string | null;
  title: string | null;
  linkedin: string | null;
  seniority: string | null;
  phone: string | null;
} | null> {
  const key = APOLLO_API_KEY();
  if (!key) return null;

  try {
    const res = await fetch(`${APOLLO_BASE}/mixed_people/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': key },
      body: JSON.stringify({
        organization_ids: [orgId],
        person_titles: DECISION_MAKER_TITLES,
        person_locations: [city],
        per_page: 5,
        page: 1,
      }),
    });
    if (!res.ok) {
      console.warn(`[ApolloEnrich] People search failed: ${res.status}`);
      return null;
    }
    const data = await res.json();
    const people = data?.people || [];
    const ranked = people.sort(
      (a: any, b: any) =>
        getSeniorityScore(b.seniority || b.title || '') -
        getSeniorityScore(a.seniority || a.title || ''),
    );
    const best = ranked[0];
    if (!best) return null;
    return {
      person_id: best.id,
      email: best.email || null,
      name: [best.first_name, best.last_name].filter(Boolean).join(' ') || null,
      title: best.title || null,
      linkedin: best.linkedin_url || null,
      seniority: best.seniority || null,
      phone: best.phone_numbers?.[0]?.sanitized_number || null,
    };
  } catch (err: any) {
    console.error('[ApolloEnrich] People search error:', err.message);
    return null;
  }
}

function getSeniorityScore(t: string): number {
  const l = t.toLowerCase();
  if (
    l.includes('owner') ||
    l.includes('propriétaire') ||
    l.includes('fondateur') ||
    l.includes('c_suite')
  )
    return 100;
  if (
    l.includes('director') ||
    l.includes('directeur') ||
    l.includes('directrice') ||
    l.includes('vp')
  )
    return 90;
  if (l.includes('general manager') || l.includes('gérant')) return 80;
  if (l.includes('manager') || l.includes('responsable')) return 70;
  if (l.includes('chef concierge') || l.includes('head concierge')) return 65;
  if (l.includes('concierge')) return 60;
  if (l.includes('senior')) return 55;
  return 30;
}

export async function enrichPlacesBatch(
  city: string,
  limit: number = 20,
): Promise<{ enriched: number; noResult: number; errors: number }> {
  const supa = getSupa();
  const result = { enriched: 0, noResult: 0, errors: 0 };

  if (!APOLLO_API_KEY()) {
    console.warn('[ApolloEnrich] APOLLO_API_KEY not set — skipping');
    return result;
  }

  const { data: places } = await supa
    .from('places_directory')
    .select('id, name, city, contact_email, phone')
    .eq('city', city)
    .in('enrichment_status', ['PENDING', 'NO_EMAIL'])
    .is('contact_email', null)
    .order('quality_score', { ascending: false, nullsFirst: false })
    .limit(limit);

  if (!places || places.length === 0) {
    console.log(`[ApolloEnrich] No PENDING places without email for ${city}`);
    return result;
  }

  for (const place of places as any[]) {
    try {
      const org = await searchApolloOrganization(place.name, place.city);
      if (!org) {
        await supa
          .from('places_directory')
          .update({ enrichment_status: 'NO_EMAIL', enriched_at: new Date().toISOString() })
          .eq('id', place.id);
        await logApolloCall(place.id, city, 'mixed_companies/search', 0, 'NO_RESULT', null);
        result.noResult++;
        continue;
      }

      const person = await searchApolloDecisionMaker(org.org_id, place.city);
      if (!person || !person.email) {
        await supa
          .from('places_directory')
          .update({
            apollo_org_id: org.org_id,
            phone: org.phone || place.phone,
            enrichment_status: 'NO_EMAIL',
            enriched_at: new Date().toISOString(),
          })
          .eq('id', place.id);
        await logApolloCall(place.id, city, 'mixed_people/search', 1, 'NO_RESULT', { org });
        result.noResult++;
        continue;
      }

      await supa
        .from('places_directory')
        .update({
          contact_email: person.email,
          contact_name: person.name,
          contact_title: person.title,
          contact_linkedin: person.linkedin,
          contact_seniority: person.seniority,
          phone: person.phone || org.phone || place.phone,
          apollo_org_id: org.org_id,
          apollo_person_id: person.person_id,
          enrichment_status: 'ENRICHED',
          enrichment_source: 'APOLLO',
          enriched_at: new Date().toISOString(),
          apollo_credits_used: 1,
        })
        .eq('id', place.id);

      await logApolloCall(place.id, city, 'mixed_people/search', 1, 'SUCCESS', { org, person });
      result.enriched++;
      console.log(`[ApolloEnrich] ✅ ${place.name} → ${person.email} (${person.title})`);
      await new Promise((r) => setTimeout(r, 700)); // Apollo rate limit: 100 req/min
    } catch (err: any) {
      console.error(`[ApolloEnrich] ❌ ${place.name}: ${err.message}`);
      await supa
        .from('places_directory')
        .update({ enrichment_status: 'FAILED', enriched_at: new Date().toISOString() })
        .eq('id', place.id);
      result.errors++;
    }
  }

  console.log(
    `[ApolloEnrich] Batch ${city}: ${result.enriched} enriched, ${result.noResult} no result, ${result.errors} errors`,
  );
  return result;
}

async function logApolloCall(
  placeId: string,
  city: string,
  endpoint: string,
  credits: number,
  status: string,
  data: any,
): Promise<void> {
  try {
    await getSupa().from('apollo_enrichment_log').insert({
      place_id: placeId,
      city,
      api_endpoint: endpoint,
      credits_used: credits,
      result_status: status,
      result_data: data,
    });
  } catch (err: any) {
    console.warn('[ApolloEnrich] Log insert failed:', err.message);
  }
}

export async function runEnrichmentBeforeFinder(city: string): Promise<void> {
  const supa = getSupa();
  const { count: withEmail } = await supa
    .from('places_directory')
    .select('*', { count: 'exact', head: true })
    .eq('city', city)
    .not('contact_email', 'is', null);
  const { count: pending } = await supa
    .from('places_directory')
    .select('*', { count: 'exact', head: true })
    .eq('city', city)
    .is('contact_email', null)
    .in('enrichment_status', ['PENDING', 'NO_EMAIL']);
  console.log(`[ApolloEnrich] ${city}: ${withEmail ?? 0} with email, ${pending ?? 0} pending`);
  if ((withEmail ?? 0) < 50 && (pending ?? 0) > 0) {
    await enrichPlacesBatch(city, Math.min(20, pending ?? 0));
  }
}
