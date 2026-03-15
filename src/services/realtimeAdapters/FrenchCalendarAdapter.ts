/**
 * FrenchCalendarAdapter — API Gouv jours fériés + vacances scolaires → contexte calendrier pour Ajnaya
 *
 * API : calendrier.api.gouv.fr (gratuit, pas de clé)
 * Vacances : Zone C (Paris) hardcodées pour 2025-2026
 * Latence : ~100-200ms
 * Tokens ajoutés : ~30-50 tokens
 */

// Cache simple en mémoire (24h — change une fois par jour)
let calendarCache: { data: string; expires: number } | null = null;
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 heures

interface JoursFeriesResponse {
  [date: string]: string; // "2026-01-01": "1er janvier"
}

// Vacances scolaires Zone C (Paris) 2025-2026
// Format: [start, end] inclusive dates
const VACANCES_ZONE_C: Array<{ name: string; start: string; end: string }> = [
  { name: 'Toussaint', start: '2025-10-18', end: '2025-11-03' },
  { name: 'Noël', start: '2025-12-20', end: '2026-01-05' },
  { name: 'Hiver', start: '2026-02-14', end: '2026-03-02' },
  { name: 'Printemps', start: '2026-04-11', end: '2026-04-27' },
  { name: 'Été', start: '2026-07-04', end: '2026-09-01' },
];

/**
 * Vérifie si aujourd'hui est un jour férié ou en vacances scolaires
 * et retourne un contexte compact.
 *
 * Exemples de sortie :
 * "CALENDRIER : Jour férié (Lundi de Pâques). Trafic réduit, aéroports actifs."
 * "CALENDRIER : Vacances scolaires zone C (Hiver). Aéroports CDG/Orly en forte demande."
 * "" (jour normal → pas de contexte ajouté)
 */
export async function getCalendarContext(): Promise<string> {
  // Check cache
  if (calendarCache && Date.now() < calendarCache.expires) {
    return calendarCache.data;
  }

  try {
    const now = new Date();
    const year = now.getFullYear();
    const todayStr = formatDate(now);

    // 1. Check jours fériés via API
    const jourFerie = await fetchJourFerie(year, todayStr);

    if (jourFerie) {
      const context = `CALENDRIER : Jour férié (${jourFerie}). Trafic réduit, aéroports actifs. Zones touristiques en demande.`;
      calendarCache = { data: context, expires: Date.now() + CACHE_TTL };
      console.log('[FrenchCalendarAdapter] ✅', context);
      return context;
    }

    // 2. Check vacances scolaires (hardcoded Zone C)
    const vacance = checkVacancesScolaires(todayStr);

    if (vacance) {
      const context = `CALENDRIER : Vacances scolaires zone C (${vacance}). Aéroports CDG/Orly en forte demande.`;
      calendarCache = { data: context, expires: Date.now() + CACHE_TTL };
      console.log('[FrenchCalendarAdapter] ✅', context);
      return context;
    }

    // 3. Jour normal — empty string
    calendarCache = { data: '', expires: Date.now() + CACHE_TTL };
    return '';
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[FrenchCalendarAdapter] Erreur:', message);
    return '';
  }
}

async function fetchJourFerie(year: number, todayStr: string): Promise<string | null> {
  try {
    const url = `https://calendrier.api.gouv.fr/jours-feries/metropole/${year}.json`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) {
      console.warn(`[FrenchCalendarAdapter] HTTP ${res.status}`);
      return null;
    }

    const data: JoursFeriesResponse = await res.json();
    return data[todayStr] || null;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[FrenchCalendarAdapter] API jours fériés:', message);
    return null;
  }
}

function checkVacancesScolaires(todayStr: string): string | null {
  for (const vacance of VACANCES_ZONE_C) {
    if (todayStr >= vacance.start && todayStr <= vacance.end) {
      return vacance.name;
    }
  }
  return null;
}

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = (date.getMonth() + 1).toString().padStart(2, '0');
  const d = date.getDate().toString().padStart(2, '0');
  return `${y}-${m}-${d}`;
}
