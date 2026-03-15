/**
 * PredictHQAdapter — Événements Paris → contexte compact pour Ajnaya
 *
 * Plan Trial gratuit (puis payant ~$50/mois)
 * Latence : ~300-500ms
 * Tokens ajoutés : ~50-120 tokens
 *
 * Surveille les événements à fort impact dans un rayon de 20km
 * autour de Paris : concerts, sports, conférences, salons.
 * Un événement = flux de personnes = courses VTC garanties.
 */

// Cache 30 min (les événements ne changent pas toutes les 5 min)
let eventsCache: { data: string; expires: number } | null = null;
const CACHE_TTL = 30 * 60 * 1000;

const PARIS_LAT = 48.8566;
const PARIS_LNG = 2.3522;
const RADIUS_KM = 20;

// Seuil d'attendance minimum pour être pertinent VTC
const MIN_ATTENDANCE = 500;

interface PredictHQEvent {
  id: string;
  title: string;
  category: string;
  start_local: string;
  end_local: string;
  predicted_end_local?: string;
  phq_attendance?: number;
  rank: number;
  local_rank: number;
  entities: Array<{
    name: string;
    type: string;
    formatted_address?: string;
  }>;
  location: [number, number]; // [lng, lat]
}

interface ParsedEvent {
  title: string;
  venue: string;
  heure: string;
  heureFin: string;
  attendance: number;
  category: string;
}

/**
 * Récupère les événements majeurs à Paris dans les prochaines 6h
 * et retourne un contexte compact pour Ajnaya.
 *
 * Exemples de sortie :
 * "ÉVÉNEMENTS : Concert Coldplay à Stade de France (80 000 pers) fin prévue 23h30 — surge massif Saint-Denis. Match PSG à Parc des Princes (48 000 pers) fin ~22h45."
 * "ÉVÉNEMENTS : Aucun événement majeur dans les prochaines heures."
 */
export async function getEventsContext(): Promise<string> {
  // Check cache
  if (eventsCache && Date.now() < eventsCache.expires) {
    return eventsCache.data;
  }

  const apiKey = process.env.PREDICTHQ_API_KEY;
  if (!apiKey) {
    console.warn('[PredictHQAdapter] Pas de clé PREDICTHQ_API_KEY');
    return '';
  }

  try {
    const now = new Date();
    // Chercher les événements qui se passent maintenant ou dans les 6 prochaines heures
    const sixHoursLater = new Date(now.getTime() + 6 * 60 * 60 * 1000);

    const startAfter = now.toISOString().split('.')[0] + 'Z';
    const startBefore = sixHoursLater.toISOString().split('.')[0] + 'Z';

    // On cherche aussi les événements EN COURS (qui ont commencé mais pas fini)
    const params = new URLSearchParams({
      'location_around.origin': `${PARIS_LAT},${PARIS_LNG}`,
      'location_around.offset': `${RADIUS_KM}km`,
      category: 'concerts,sports,conferences,expos,performing-arts,community,festivals',
      'start.gte': new Date(now.getTime() - 4 * 60 * 60 * 1000).toISOString().split('.')[0] + 'Z', // commencé il y a max 4h
      'start.lte': startBefore,
      'rank.gte': '40', // Événements significatifs seulement
      limit: '10',
      sort: '-rank', // Les plus gros en premier
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(`https://api.predicthq.com/v1/events/?${params}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      console.warn(`[PredictHQAdapter] HTTP ${res.status}`);
      return '';
    }

    const data = await res.json();
    const events: PredictHQEvent[] = data.results || [];

    // Filtrer par attendance
    const significantEvents = events.filter((e) => (e.phq_attendance || 0) >= MIN_ATTENDANCE);

    const context = formatEventsContext(significantEvents, now);

    // Cache
    eventsCache = { data: context, expires: Date.now() + CACHE_TTL };
    if (context) console.log('[PredictHQAdapter] ✅', context.substring(0, 100));

    return context;
  } catch (err: any) {
    console.warn('[PredictHQAdapter] Erreur:', err.message);
    return '';
  }
}

function formatEventsContext(events: ParsedEvent[] | PredictHQEvent[], now: Date): string {
  if (events.length === 0) {
    return 'ÉVÉNEMENTS : Aucun événement majeur à Paris dans les prochaines heures.';
  }

  const parsed: ParsedEvent[] = (events as PredictHQEvent[]).map((e) => {
    // Trouver le venue
    const venueEntity = e.entities?.find((ent) => ent.type === 'venue');
    const venue = venueEntity?.name || 'lieu inconnu';

    // Heures
    const start = new Date(e.start_local);
    const endStr = e.predicted_end_local || e.end_local;
    const end = endStr ? new Date(endStr) : null;

    const heureStart = `${start.getHours()}h${start.getMinutes().toString().padStart(2, '0')}`;
    const heureFin = end
      ? `${end.getHours()}h${end.getMinutes().toString().padStart(2, '0')}`
      : '?';

    return {
      title: e.title.length > 40 ? e.title.substring(0, 40) + '...' : e.title,
      venue,
      heure: heureStart,
      heureFin,
      attendance: e.phq_attendance || 0,
      category: e.category,
    };
  });

  // Trier par attendance
  parsed.sort((a, b) => b.attendance - a.attendance);

  // Garder les 3 plus gros
  const top = parsed.slice(0, 3);

  const details = top
    .map((e) => {
      const attendStr =
        e.attendance >= 10000 ? `${Math.round(e.attendance / 1000)}k` : `${e.attendance}`;
      return `${e.title} à ${e.venue} (${attendStr} pers, fin ~${e.heureFin})`;
    })
    .join('. ');

  const totalAttendance = top.reduce((sum, e) => sum + e.attendance, 0);

  let impact = '';
  if (totalAttendance >= 30000) {
    impact =
      ' ⚠️ Surge MASSIF garanti aux alentours à la sortie. Positionne-toi 30min avant la fin.';
  } else if (totalAttendance >= 5000) {
    impact = ' Surge probable à la sortie, anticipe le positionnement.';
  }

  return `ÉVÉNEMENTS : ${details}.${impact}`;
}
