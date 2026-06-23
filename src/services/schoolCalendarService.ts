/**
 * schoolCalendarService.ts — Vacances scolaires françaises
 * Source : data.education.gouv.fr (gratuit, officiel)
 *
 * Impact VTC : vacances en cours → -30% demande parents/scolaire
 *              veille de vacances → +20% (retours anticipés)
 *
 * Cache 24h par zone académique (les données changent rarement).
 */

export interface SchoolCalendarContext {
  isVacation: boolean;
  vacationName: string | null;
  nextVacationDays: number;
  demandMultiplier: number;
}

// Zones académiques par city_slug (source MEN)
const CITY_TO_ZONE: Record<string, string> = {
  paris: 'Zone C',
  lyon: 'Zone A',
  marseille: 'Zone B',
  bordeaux: 'Zone A',
  toulouse: 'Zone A',
  nice: 'Zone B',
  strasbourg: 'Zone B',
  nantes: 'Zone A',
  rennes: 'Zone A',
  lille: 'Zone B',
};

const _calendarCache = new Map<string, { data: SchoolCalendarContext; expiresAt: number }>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const CALENDAR_BASE =
  'https://data.education.gouv.fr/api/explore/v2.1/catalog/datasets/fr-en-calendrier-scolaire/records';

export async function fetchSchoolCalendar(citySlug: string): Promise<SchoolCalendarContext | null> {
  const zone = CITY_TO_ZONE[citySlug] ?? 'Zone C';
  const cached = _calendarCache.get(zone);
  if (cached && Date.now() < cached.expiresAt) return cached.data;

  try {
    const where = encodeURIComponent(`location="${zone}"`);
    const url = `${CALENDAR_BASE}?where=${where}&limit=20&order_by=start_date`;

    const resp = (await fetch(url, {
      signal: AbortSignal.timeout(800),
    })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)) as any;

    if (!resp?.results?.length) return null;

    const now = new Date();
    const records = resp.results as any[];

    let isVacation = false;
    let vacationName: string | null = null;
    let nextVacationDays = 999;

    for (const rec of records) {
      const start = new Date(rec.start_date ?? rec.date_debut);
      const end = new Date(rec.end_date ?? rec.date_fin);
      const name: string = rec.description ?? rec.libelle ?? 'Vacances';

      if (now >= start && now <= end) {
        isVacation = true;
        vacationName = name;
        break;
      }

      if (start > now) {
        const days = Math.ceil((start.getTime() - now.getTime()) / 86_400_000);
        if (days < nextVacationDays) nextVacationDays = days;
      }
    }

    const isEve = !isVacation && nextVacationDays === 1;

    const ctx: SchoolCalendarContext = {
      isVacation,
      vacationName: isVacation ? vacationName : null,
      nextVacationDays: isVacation ? 0 : nextVacationDays,
      demandMultiplier: isVacation ? 0.7 : isEve ? 1.2 : 1.0,
    };

    _calendarCache.set(zone, { data: ctx, expiresAt: Date.now() + CACHE_TTL_MS });
    return ctx;
  } catch {
    return null;
  }
}
