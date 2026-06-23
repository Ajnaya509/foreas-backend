/**
 * Perplexity Sonar — Recherche temps réel pour Ajnaya
 * ====================================================
 * Enrichit le cerveau d'Ajnaya avec des données live :
 * - Trafic / événements / météo Paris
 * - Infos VTC / réglementation
 * - Tendances de demande en temps réel
 *
 * Appelé AVANT GPT-4o pour injecter du contexte frais.
 */

const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY || '';
const SONAR_MODEL = 'sonar'; // modèle par défaut (rapide + web search)
const SONAR_TIMEOUT_MS = 8000; // 8s — laisser le temps a Sonar (la reponse est plus riche)

// ── Mots-clés qui déclenchent une recherche Sonar ──
const SEARCH_TRIGGERS = [
  // Zones & demande
  'zone',
  'quartier',
  'arrondissement',
  'demande',
  'rentable',
  'affluence',
  'hotspot',
  'clients',
  'passagers',
  'courses',
  // Trafic & conditions
  'trafic',
  'bouchon',
  'embouteillage',
  'accident',
  'travaux',
  'circulation',
  'manifestation',
  'grève',
  'greve',
  'route fermée',
  'déviation',
  // Événements
  'concert',
  'match',
  'salon',
  'festival',
  'événement',
  'evenement',
  'spectacle',
  'stade',
  'bercy',
  'la défense arena',
  'parc des princes',
  'roland garros',
  // Aéroports & gares
  'cdg',
  'orly',
  'roissy',
  'aéroport',
  'gare',
  'train',
  'tgv',
  'eurostar',
  // Météo
  'météo',
  'meteo',
  'pluie',
  'neige',
  'verglas',
  'chaleur',
  'canicule',
  // Réglementation VTC
  'réglementation',
  'loi',
  'amende',
  'contrôle',
  'vtc',
  'uber',
  'bolt',
  'heetch',
  'tarif',
  'prix',
  'surge',
  'majoration',
  // Tendances
  'ce soir',
  'cette nuit',
  'demain',
  'week-end',
  'weekend',
  'maintenant',
  'en ce moment',
  "aujourd'hui",
  'actuellement',
  // Questions generales qui beneficient de donnees live
  'ou aller',
  'quelle zone',
  'quel quartier',
  'meilleur endroit',
  'combien',
  'gagner plus',
  'rentabilite',
  'optimiser',
  'info',
  'actualite',
  'nouveau',
  'nouvelle',
  // Comptabilité & Fiscal
  'urssaf',
  'cotisation',
  'tva',
  'impôt',
  'impot',
  'déclaration',
  'declaration',
  'bic',
  'micro-entreprise',
  'micro entreprise',
  'bnc',
  'cfe',
  'cipav',
  'frais déductibles',
  'frais deductibles',
  'charges',
  'bilan',
  'fiscal',
  'auto-entrepreneur',
  'acre',
  'exonération',
  'plafond',
  'abattement',
  'versement libératoire',
  'régime',
  'regime',
  'sasu',
  'eurl',
];

// Exclusions : questions purement conversationnelles qui n'ont pas besoin de data live
const SKIP_SONAR = [
  'bonjour',
  'salut',
  'hello',
  'merci',
  'ok',
  'oui',
  'non',
  'au revoir',
  'bonne nuit',
  'ca va',
  'comment tu vas',
];

/**
 * Détecte si le message nécessite une recherche temps réel.
 * LOGIQUE INVERSÉE : Sonar ON par défaut, OFF uniquement pour le small talk.
 * Le cerveau décisionnel Ajnaya doit avoir accès aux données live naturellement.
 */
export function needsSonarSearch(message: string): boolean {
  if (!PERPLEXITY_API_KEY) return false;
  const lower = message
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();

  // Skip les messages très courts (1-2 mots) purement conversationnels
  if (lower.length < 8 && SKIP_SONAR.some((s) => lower.includes(s))) return false;

  // Skip les messages type "oui", "non", "ok" (confirmations)
  if (lower.length < 5) return false;

  // Tout le reste → Sonar activé naturellement
  return true;
}

/**
 * Appelle Perplexity Sonar et retourne un contexte structuré
 */
export async function querySonar(userMessage: string): Promise<string | null> {
  if (!PERPLEXITY_API_KEY) {
    console.warn('[Sonar] Clé API absente — recherche skippée');
    return null;
  }

  const searchQuery = buildSearchQuery(userMessage);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SONAR_TIMEOUT_MS);

    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${PERPLEXITY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: SONAR_MODEL,
        messages: [
          {
            role: 'system',
            content: `Tu es un assistant de recherche pour un copilote IA de chauffeurs VTC à Paris.
Fournis UNIQUEMENT des faits vérifiés et récents :
- Événements en cours ou prévus (concerts, matchs, salons)
- Conditions de trafic actuelles
- Zones de forte demande VTC
- Météo si pertinent
- Infos réglementaires VTC si demandé

FORMAT : Bullet points courts. Pas de prose. Données factuelles uniquement.
LANGUE : Français.
MAX : 150 mots.`,
          },
          {
            role: 'user',
            content: searchQuery,
          },
        ],
        max_tokens: 200,
        temperature: 0.1, // très factuel
        return_citations: false,
        search_context_size: 'medium',
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      console.warn(`[Sonar] HTTP ${response.status}`);
      return null;
    }

    const data: any = await response.json();
    const content = data?.choices?.[0]?.message?.content;

    if (!content || content.length < 10) return null;

    console.log(
      `[Sonar] ✅ Recherche réussie (${content.length} chars, ${data.usage?.total_tokens || '?'} tokens)`,
    );
    return content;
  } catch (err: any) {
    if (err.name === 'AbortError') {
      console.warn('[Sonar] Timeout 4s — réponse sans recherche');
    } else {
      console.warn('[Sonar] Erreur:', err.message);
    }
    return null;
  }
}

/**
 * Construit une requête de recherche optimisée pour le contexte VTC Paris
 */
function buildSearchQuery(userMessage: string): string {
  const now = new Date();
  const day = now.toLocaleDateString('fr-FR', { weekday: 'long' });
  const hour = now.getHours();
  const date = now.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

  return `${userMessage}

Contexte : chauffeur VTC à Paris, ${day} ${date}, ${hour}h.
Recherche les informations les plus récentes et pertinentes pour un chauffeur VTC en activité.`;
}

/**
 * Formate le résultat Sonar pour injection dans le prompt GPT
 */
export function formatSonarContext(sonarResult: string): string {
  return `📡 DONNÉES TEMPS RÉEL (Perplexity Sonar — ${new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}):
${sonarResult}

Utilise ces données factuelles pour enrichir ta réponse. Ne cite pas Perplexity.`;
}
