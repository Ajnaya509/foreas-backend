/**
 * SNCFAdapter — API SNCF Open Data → trains en approche gares parisiennes
 *
 * Gratuit : 150 000 req/mois
 * Latence : ~200-400ms
 * Tokens ajoutés : ~50-100 tokens
 *
 * On surveille les 5 gares principales de Paris pour les arrivées
 * dans les 30 prochaines minutes = flux de passagers = courses VTC.
 */

// Cache simple (5 min — les trains bougent vite)
let trainsCache: { data: string; expires: number } | null = null;
const CACHE_TTL = 5 * 60 * 1000;

// Gares parisiennes principales (stop_area SNCF)
const PARIS_GARES = [
  { id: 'stop_area:SNCF:87686006', name: 'Gare du Nord', short: 'Nord' },
  { id: 'stop_area:SNCF:87686667', name: 'Gare de Lyon', short: 'Lyon' },
  { id: 'stop_area:SNCF:87391003', name: 'Gare Montparnasse', short: 'Montparnasse' },
  { id: 'stop_area:SNCF:87384008', name: 'Gare Saint-Lazare', short: 'St-Lazare' },
  { id: 'stop_area:SNCF:87113001', name: "Gare de l'Est", short: 'Est' },
];

interface SNCFDeparture {
  display_informations: {
    direction: string;
    commercial_mode: string;
    label: string;
    network: string;
  };
  stop_date_time: {
    arrival_date_time: string;
    departure_date_time: string;
  };
}

interface TrainArrival {
  gare: string;
  type: string; // TGV, TER, Eurostar...
  origine: string;
  heure: string; // "18h42"
  minutesRestantes: number;
}

/**
 * Récupère les arrivées de trains dans les 30 prochaines minutes
 * aux gares parisiennes et retourne un contexte compact.
 *
 * Exemples de sortie :
 * "TRAINS : 3 TGV arrivent dans 15-25min (Nord: Lyon 18h42, Est: Strasbourg 18h55, Lyon: Marseille 19h01). Flux passagers = courses."
 * "TRAINS : Aucun train majeur dans les 30 prochaines minutes."
 */
export async function getTrainContext(): Promise<string> {
  // Check cache
  if (trainsCache && Date.now() < trainsCache.expires) {
    return trainsCache.data;
  }

  const apiKey = process.env.SNCF_API_KEY;
  if (!apiKey) {
    console.warn('[SNCFAdapter] Pas de clé SNCF_API_KEY');
    return '';
  }

  try {
    // Requêter les arrivées des 2 plus grosses gares en parallèle
    // (On limite à 2 pour rester rapide, Nord et Lyon = 60% du trafic)
    const garesToCheck = PARIS_GARES.slice(0, 3);

    const results = await Promise.allSettled(
      garesToCheck.map((gare) => fetchArrivals(apiKey, gare)),
    );

    const allArrivals: TrainArrival[] = [];

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        allArrivals.push(...result.value);
      }
    }

    // Trier par minutes restantes
    allArrivals.sort((a, b) => a.minutesRestantes - b.minutesRestantes);

    // Garder les 5 plus proches
    const upcoming = allArrivals.filter((a) => a.minutesRestantes <= 30).slice(0, 5);

    const context = formatTrainContext(upcoming);

    // Cache
    trainsCache = { data: context, expires: Date.now() + CACHE_TTL };
    if (context) console.log('[SNCFAdapter] ✅', context.substring(0, 80));

    return context;
  } catch (err: any) {
    console.warn('[SNCFAdapter] Erreur:', err.message);
    return '';
  }
}

async function fetchArrivals(
  apiKey: string,
  gare: (typeof PARIS_GARES)[number],
): Promise<TrainArrival[]> {
  try {
    const url = `https://api.sncf.com/v1/coverage/sncf/${gare.id}/arrivals?count=10&duration=1800`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);

    const res = await fetch(url, {
      headers: {
        Authorization: `Basic ${Buffer.from(apiKey + ':').toString('base64')}`,
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      console.warn(`[SNCFAdapter] ${gare.short}: HTTP ${res.status}`);
      return [];
    }

    const data = await res.json();
    const arrivals = data.arrivals || [];

    const now = new Date();

    return arrivals
      .filter((a: SNCFDeparture) => {
        // Filtrer TGV, Eurostar, TER longue distance (pas les transilien)
        const mode = a.display_informations.commercial_mode?.toLowerCase() || '';
        return (
          mode.includes('tgv') ||
          mode.includes('eurostar') ||
          mode.includes('thalys') ||
          mode.includes('intercit') ||
          mode.includes('inoui')
        );
      })
      .map((a: SNCFDeparture): TrainArrival => {
        const arrTime = parseSNCFDate(a.stop_date_time.arrival_date_time);
        const minutesRestantes = Math.round((arrTime.getTime() - now.getTime()) / 60000);
        const heure = `${arrTime.getHours()}h${arrTime.getMinutes().toString().padStart(2, '0')}`;

        return {
          gare: gare.short,
          type: a.display_informations.commercial_mode || 'Train',
          origine: a.display_informations.direction?.split(' (')[0] || 'inconnu',
          heure,
          minutesRestantes: Math.max(0, minutesRestantes),
        };
      })
      .filter((a: TrainArrival) => a.minutesRestantes > 0 && a.minutesRestantes <= 30);
  } catch (err: any) {
    console.warn(`[SNCFAdapter] ${gare.short}: ${err.message}`);
    return [];
  }
}

function parseSNCFDate(sncfDate: string): Date {
  // Format SNCF : "20260314T184200" → Date
  const year = parseInt(sncfDate.substring(0, 4));
  const month = parseInt(sncfDate.substring(4, 6)) - 1;
  const day = parseInt(sncfDate.substring(6, 8));
  const hours = parseInt(sncfDate.substring(9, 11));
  const minutes = parseInt(sncfDate.substring(11, 13));
  const seconds = parseInt(sncfDate.substring(13, 15));
  return new Date(year, month, day, hours, minutes, seconds);
}

function formatTrainContext(arrivals: TrainArrival[]): string {
  if (arrivals.length === 0) {
    return 'TRAINS : Aucun TGV/grande ligne dans les 30 prochaines minutes aux gares parisiennes.';
  }

  const details = arrivals
    .map((a) => `${a.gare}: ${a.type} de ${a.origine} à ${a.heure} (${a.minutesRestantes}min)`)
    .join(', ');

  const garesUniques = [...new Set(arrivals.map((a) => a.gare))];

  return `TRAINS : ${arrivals.length} train(s) grande ligne arrivent bientôt (${details}). Gares à cibler : ${garesUniques.join(', ')}. Flux passagers = courses garanties.`;
}
