/**
 * IDFMAdapter — IDFM/PRIM Siri Lite API → perturbations métro/RER pour Ajnaya
 *
 * API : PRIM (Plateforme Régionale d'Information Multimodale)
 * Gratuit avec inscription
 * Latence : ~300-500ms
 * Tokens ajoutés : ~30-50 tokens
 *
 * Surveille les perturbations sur les lignes critiques VTC :
 * Métro 1, 4, 6 et RER A, B, D
 */

// Cache simple en mémoire (5 min)
let transportCache: { data: string; expires: number } | null = null;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Lignes surveillées (impact fort sur la demande VTC)
const MONITORED_LINES = ['1', '4', '6', 'A', 'B', 'D'];

interface SiriMessage {
  InfoMessageIdentifier?: { value?: string };
  Content?: {
    Message?: Array<{
      MessageType?: string;
      MessageText?: { value?: string };
    }>;
  };
  InfoChannelRef?: { value?: string };
  ValidUntilTime?: string;
}

interface SiriResponse {
  Siri?: {
    ServiceDelivery?: {
      GeneralMessageDelivery?: Array<{
        InfoMessage?: SiriMessage[];
      }>;
    };
  };
}

interface Disruption {
  line: string;
  summary: string;
}

/**
 * Récupère les perturbations RATP/IDFM sur les lignes clés
 * et retourne un contexte compact.
 *
 * Exemples de sortie :
 * "TRANSPORT : Metro 1 perturbé (signal), RER A interrompu Chatelet-Nation. Afflux passagers prévu."
 * "TRANSPORT : Aucune perturbation majeure métro/RER. Trafic normal."
 */
export async function getTransportContext(): Promise<string> {
  // Check cache
  if (transportCache && Date.now() < transportCache.expires) {
    return transportCache.data;
  }

  const apiKey = process.env.IDFM_API_KEY;
  if (!apiKey) {
    console.warn('[IDFMAdapter] Pas de clé IDFM_API_KEY');
    return '';
  }

  try {
    const url = 'https://prim.iledefrance-mobilites.fr/marketplace/general-message';

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        apikey: apiKey,
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      console.warn(`[IDFMAdapter] HTTP ${res.status}`);
      return '';
    }

    const data: SiriResponse = await res.json();
    const context = formatTransportContext(data);

    // Cache
    transportCache = { data: context, expires: Date.now() + CACHE_TTL };
    if (context) console.log('[IDFMAdapter] ✅', context.substring(0, 80));

    return context;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[IDFMAdapter] Erreur:', message);
    return '';
  }
}

function formatTransportContext(data: SiriResponse): string {
  const disruptions: Disruption[] = [];

  const deliveries = data?.Siri?.ServiceDelivery?.GeneralMessageDelivery || [];

  for (const delivery of deliveries) {
    const messages = delivery.InfoMessage || [];

    for (const msg of messages) {
      const textContent = msg.Content?.Message?.[0]?.MessageText?.value || '';
      const textLower = textContent.toLowerCase();

      // Check if this disruption concerns a monitored line
      for (const line of MONITORED_LINES) {
        const linePatterns = [
          `ligne ${line.toLowerCase()}`,
          `metro ${line.toLowerCase()}`,
          `métro ${line.toLowerCase()}`,
          `rer ${line.toLowerCase()}`,
          `ligne${line.toLowerCase()}`,
        ];

        const matches = linePatterns.some((p) => textLower.includes(p));
        if (matches) {
          // Extract a short summary (first 60 chars)
          const shortSummary =
            textContent.length > 60 ? textContent.substring(0, 57) + '...' : textContent;

          disruptions.push({
            line,
            summary: shortSummary,
          });
          break;
        }
      }
    }
  }

  // Deduplicate by line
  const uniqueDisruptions = new Map<string, Disruption>();
  for (const d of disruptions) {
    if (!uniqueDisruptions.has(d.line)) {
      uniqueDisruptions.set(d.line, d);
    }
  }

  const disruptionList = [...uniqueDisruptions.values()];

  if (disruptionList.length === 0) {
    return 'TRANSPORT : Aucune perturbation majeure métro/RER. Trafic normal.';
  }

  const details = disruptionList
    .slice(0, 3) // Max 3 disruptions for compactness
    .map((d) => {
      const lineType = ['A', 'B', 'D'].includes(d.line) ? 'RER' : 'Metro';
      return `${lineType} ${d.line} perturbé`;
    })
    .join(', ');

  return `TRANSPORT : ${details}. Afflux passagers VTC prévu sur ces axes.`;
}
