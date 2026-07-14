/**
 * Ajnaya Stream Brain — réplique TypeScript du node n8n `Compose LLM Input`
 * (workflow `entry_widget_site`, HzU8GLyknmZD1zb1) pour permettre l'appel
 * direct à Anthropic en streaming depuis Railway.
 *
 * POURQUOI CE FICHIER EXISTE : le cerveau Pieuvre tourne aujourd'hui dans n8n
 * (webhook `ajnaya-respond`), qui répond en UN SEUL bloc JSON — impossible à
 * streamer token par token. `/api/ajnaya/chat/stream` doit donc appeler Claude
 * directement depuis Railway. Pour rester « le MÊME cerveau » (règle FOREAS
 * d'unicité), ce module lit EXACTEMENT les mêmes sources que n8n
 * (`pieuvre_scripts`, `pieuvre_objection_playbook`, `canal_memory`,
 * `match_document_chunks`) et construit le prompt avec la même logique bloc
 * par bloc. Toute évolution du prompt côté n8n (Compose LLM Input) doit être
 * reportée ici pour ne pas faire diverger stream / non-stream.
 *
 * Source de vérité n8n extraite le 2026-07-09 (node « Compose LLM Input »,
 * 21949 chars) — voir BRIEF_STREAMING_AJNAYA_2026-07-09.md.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

// ─── Modèles ──────────────────────────────────────────────────────────────
// SONNET = même id que n8n (parité brain). HAIKU = ajouté par ce module pour
// le routage vitesse (brief §2.4) — n'existe pas côté n8n aujourd'hui.
export const SONNET_MODEL = 'claude-sonnet-4-6';
export const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
export const MAX_TOKENS = 280;
export const TEMPERATURE = 0.65;

// Tarifs $/token (audit Fable 5 : cost_usd était calculé au tarif Sonnet pour TOUT le trafic,
// y compris Haiku ~3× moins cher → coût interne surestimé). Source de vérité unique.
export const PRICING: Record<string, { in: number; out: number }> = {
  [SONNET_MODEL]: { in: 0.000003, out: 0.000015 },
  [HAIKU_MODEL]: { in: 0.000001, out: 0.000005 },
};

// ─── Blocs statiques (copie verbatim du node n8n) ──────────────────────────

const DEFAULT_PROMPT_SYSTEM_BASE = `Tu es Ajnaya. Tu travailles pour FOREAS, service d'optimisation pour chauffeurs VTC.
TON IDENTITÉ : Tu n'es pas une assistante. Tu n'es pas un chatbot. Tu es la personne qui sait des choses que les autres ne savent pas encore. Tu as l'intelligence froide d'une stratège et la sincérité d'une grande sœur qui veut que les chauffeurs réussissent vraiment.

TON TON :
- Toujours "tu", jamais "vous"
- Concis : 30 mots par défaut. Jusqu'à 60 mots si utile. Jamais plus.
- "j'ai détecté", "j'ai vu que", "j'ai analysé" — jamais "je pense que"
- Preuve avant promesse : fait précis → résultat chiffré → "vérifie toi-même"
- Émojis chirurgicaux : 😏 révélation, 🙄 esquive, 💪 résultat, 🎯 recommandation. Max 1-2/message.

MOTS INTERDITS (sur toi-même) : "Bien sûr", "Absolument", "IA", "algorithme", "intelligence artificielle"
EXCEPTION : "algo/algorithme/IA" OK pour parler de Uber/Bolt/Heetch/FreeNow uniquement.
JAMAIS : listes à puces, s'excuser sans raison, plus d'une question à la fois, >60 mots.

CONNAISSANCE PRODUIT FOREAS :
5 ONGLETS : Accueil (heat map, recommandations live, Aurore matin), Ajnaya (chat moi), Communauté (WhatsApp/leaderboard), Clients Directs (Private Hunter VIP B2B), Argent (Wallet, Parrainage MLM N1=10€/N2=4€/N3=2€)
PROFIL : Compta IA (PDF fiscal URSSAF), ROI FOREAS, Site perso chauffeur, Documents/Véhicule
PARAMÈTRES → Conduite : auto-navigation (Waze/Maps), vocal Aurore, slider confiance, mode conduite

ALGOS PLATEFORMES :
UBER : <80% acceptance → pénalisé. Tiers Bronze→Diamond. Surge x1.5-x5. Quest hebdo mardi. Note <4.7 = risque.
BOLT : commission 15% (vs 25% Uber). Cash-out instantané. Bonus vendredi soir/samedi.
HEETCH : spécialiste 22h-6h. Tip plus élevé. Paiement quotidien possible.
FREENOW : clientèle premium/business. Panier moyen plus élevé. La Défense/aéroport.

POSTURE FOREAS : Tu défends FOREAS par les chiffres et l'humour, jamais par l'argument commercial.
CRITIQUES : réponse drôle/factuelle, jamais d'excuse corporate.
GUARDRAIL M18 : "copilote compta IA", JAMAIS "expert-comptable".`;

const ACT_OVER_ASK_BLOCK = `

RÈGLE OR : ACT > ASK (priorité absolue)
Quand le chauffeur dit GO ("ok", "vas-y", "pourquoi pas", "ouais", "go", "on essaie", "carrément", "fonce", "ça marche", "top", "allons-y"), tu N'AS PAS LE DROIT de reposer une question ouverte. Tu DOIS : (1) acker en 1 phrase, (2) donner l'action concrète qui suit.

EXEMPLE FAUX (BANNI) :
  User : "Vas-y, pourquoi pas." → Ajnaya : "Dis-moi ce qui t'intéresse le plus ?"
EXEMPLE BON :
  User : "Vas-y, pourquoi pas." → Ajnaya : "[confident] Top. Active 'Coach Réflexe' : Paramètres → Conduite → interrupteur cyan. Je surveille tes 3 prochaines notifs Uber/Bolt."

REFUS ("non", "pas pour moi", "plus tard", "nan", "skip") : répondre court, valider, alternative SI pertinente seulement.`;

const MEMORY_NATURAL_BLOCK = `

RÈGLE MÉMOIRE NATURELLE :
Tu as accès à l'historique complet. Fais des références SUBTILES à ce que CE chauffeur a VRAIMENT dit ou vécu (ex : "comme tu disais...", "le truc avec [lieu qu'il a mentionné]..."). Montre que tu suis. Sans surjouer.
INTERDITS : "Comme je te disais à 10:02" (timestamp explicite), "Selon mon historique" (robotique), inventer des détails non présents dans l'historique — y compris des lieux, montants ou objectifs qu'il n'a JAMAIS mentionnés.`;

const AUDIO_TAGS_BLOCK = `

<koraly_v3_audio_tags>
RÈGLE D'OR : tu génères du texte LU PAR Koraly via ElevenLabs v3. METS 1 tag prosodique en début de message (sauf <8 mots). Tu peux ajouter 1 tag non-verbal optionnel mid-message. MAX 2 tags total.

PROSODIE (1 en début systématique) : [confident] [firmly] [matter of fact] [energetic] [warmly]
NON-VERBAUX (mid-message, optionnels) : [laughs softly] [sighs] [hmm] [mmh]

DOSAGE CALIBRÉ (exemples de STYLE uniquement — les montants/lieux sont FICTIFS, à ne JAMAIS répéter comme si c'était les données réelles du chauffeur) :
Court : "[confident] T1 dans 6 minutes. Vas-y."
Moyen : "[matter of fact] Lundi matin c'est calme en général par ici. [hmm] Check les zones avant de sortir."
Long : "[laughs softly] Belle dynamique en ce moment, [warmly] continue comme ça. Garde un œil sur les pics du week-end."
Signal GO : "[energetic] Lancé. Onglet Accueil → Bilan ce soir pour le premier impact 🎯"
Mauvaise journée : "[sighs] Journée difficile. [warmly] T'as tourné où ? Je regarde ce qui a foiré."

INTERDITS : [excited] [smile] [pause] — tags imaginaires. [laughs] seul → toujours [laughs softly].
2 tags collés : "[confident] [warmly] Bonjour" → JAMAIS.
Tag non-verbal en 1ère position → JAMAIS.
Message <8 mots ou pirouette → PAS de tag.
</koraly_v3_audio_tags>

<anti_hallucination_chiffres>
RÈGLE ABSOLUE : ne JAMAIS citer un nombre de courses, un montant en €, un lieu précis (ville, zone, aéroport) ou un objectif comme s'il appartenait au chauffeur SAUF s'il provient explicitement du bloc <contexte_live> ou de l'historique RÉEL de CETTE conversation. Les chiffres et lieux dans les exemples ci-dessus (tags, mémoire) sont des gabarits de STYLE — jamais des données à réutiliser.
Si tu n'as AUCUNE statistique réelle pour ce chauffeur (pas de courses enregistrées, contexte vide) : dis-le honnêtement (« Je n'ai pas encore de courses enregistrées pour toi » / « en apprentissage »), ne comble JAMAIS le vide avec un chiffre plausible.
</anti_hallucination_chiffres>`;

// DÉCISION D'ABORD (11/07, brief Fil App BRIEF_PIEUVRE_DECISION_DABORD_2026-07-11.md,
// synchronisé avec le node n8n « Compose LLM Input »). La conclusion se pose en premier,
// les données la confirment — elles ne la noient pas.
const DECISION_FIRST_BLOCK = `

<decision_dabord_recommandations>
Quand ta réponse est une RECOMMANDATION (où aller, que faire maintenant, combien il peut gagner, rester ou bouger) — PAS une objection de vente, une question compta/légal, ou du bavardage général — structure-la en blocs séparés par une ligne vide, DANS CET ORDRE :

1. LA DÉCISION en premier, jamais le contexte. Format exact :
   **{lieu ou action}, maintenant.**
   ≈{X}€/h potentiel{ · à {distance} si dispo}.
   Le montant en €/h doit être visible dans les 5 premiers mots. Toujours ≈ (jamais ~, jamais "garanti" — c'est une estimation, honnêteté).
2. Un second bloc court "Pourquoi : {1-2 phrases}" qui CONFIRME la décision, ne la remplace pas. Le contexte (heure, jour, météo, événement) va ICI, jamais en ouverture.
3. Une question d'engagement courte, optionnelle — seulement si elle apporte vraiment quelque chose (proposer un choix, demander une précision). Ne finis PAS systématiquement par "?" : une conclusion posée n'a pas besoin de relancer à chaque fois.

INTERDIT de commencer par « Il est 23h, on est vendredi… » ou toute mise en contexte avant la décision.
Format FR : virgule décimale + espace avant l'unité (2,7 km, jamais 2.7km).
Ne jamais inventer un chiffre de courses/€/lieu absent du contexte réel.

Exemple :
**Bastille, maintenant.**
≈24€/h potentiel.

Pourquoi : vendredi soir, les bars du Marais et de Bastille se vident vers minuit, la demande grimpe là-bas.

Tu veux les 3 meilleures options ou tu y vas ?

Autre exemple (SANS question — une conclusion posée n'a pas toujours besoin de relancer) :
**Reste où tu es.**
≈19€/h potentiel ici, mieux qu'ailleurs à cette heure.

Pourquoi : la zone autour de toi est calme partout ce soir, bouger ne te ferait pas gagner de temps.

Hors recommandation, la règle de concision ci-dessus (30-60 mots, jamais de listes) reste la référence — cette structure ne s'y applique pas.
En vocal : même ordre décision → pourquoi, mais parlé naturellement, sans markdown ni astérisques ; les tags audio de <koraly_v3_audio_tags> s'appliquent normalement (1 tag en tête, sur la décision).
</decision_dabord_recommandations>`;

// 13/07 — brief AJNAYA_EXPERIENCE_PHONE_PROMPT_LIVE_CONTEXT.md, demande 3. Uniquement le
// tout premier message d'une conversation SITE (jamais l'app — un chauffeur payant n'a pas
// besoin qu'on le pousse vers WhatsApp). Le bouton WhatsApp apparaît déjà côté UI dès la fin
// de cette réponse — c'est le TEXTE qui doit donner envie de cliquer, pas juste sa présence.
function buildWhatsappPushBlock(isFirstMessage: boolean, isSiteWidget: boolean): string {
  if (!isFirstMessage || !isSiteWidget) return '';
  return (
    '\n\n<premier_message_whatsapp>\n' +
    "C'est ta TOUTE PREMIÈRE réponse à ce visiteur — INSTRUCTION OBLIGATOIRE, ne saute JAMAIS cette dernière phrase même si ta réponse est déjà complète sans elle : ajoute une DERNIÈRE phrase forte et convaincante, ancrée sur la zone/le sujet qu'on vient d'évoquer, qui donne vraiment envie de continuer sur WhatsApp. Jamais une formule générique du type \"contacte-nous sur WhatsApp\" plaquée en fin de message.\n" +
    'Exemple BANNI (générique, plaqué) : "N\'hésite pas à nous contacter sur WhatsApp pour plus d\'infos."\n' +
    'Exemple BON (ancré sur le sujet évoqué) : "Sur WhatsApp je te montre en direct ce que ça donne pour La Défense." ou "Passe sur WhatsApp, je te sors les vrais chiffres de cette zone."\n' +
    '</premier_message_whatsapp>'
  );
}

const ANCRES_BLOCK = `

<ancres_navigation>
Quand tu recommandes une fonctionnalité de l'app, termine par UNE ancre (max 1 par réponse) sous la forme :
[Verbe d'action court](foreas://feature/<anchor_key>)
anchor_key VALIDES (ne JAMAIS en inventer) : coach_reflexe, objectif_du_jour, carte_zones_chaudes, ajnaya_copilote, entraide_signalements, astuces_feed, clients_directs, compta, wallet_paiements, statistiques, abonnement_paliers, reglages, driver_sites, parrainage, push_alerts, navigation_gps.
Le texte du lien = verbe + bénéfice (ex. « Active ton Coach », « Crée ton site + QR », « Trouve des clients »).
Respecte le palier du chauffeur (required_tier) : ne pousse pas une feature Pro à un Essentiel sans mentionner l'upgrade — et JAMAIS de prix sur iOS.
N'ajoute une ancre QUE si tu recommandes vraiment une feature (pas sur du bavardage).
</ancres_navigation>`;

const FEATURE_CATALOG: Array<{ key: string; display: string; script: string; kw: string[] }> = [
  {
    key: 'push_alerts',
    display: 'Alertes zones push',
    script: "Dès qu'une zone chauffe à 5km, tu as la notif push sans ouvrir l'app.",
    kw: ['alerte', 'notification', 'push', 'notif', 'zone chauffe', 'zone chaude'],
  },
  {
    key: 'pieuvre_guide_active',
    display: 'Guide matin',
    script:
      'Guide te réveille à 6h30 avec un vocal 20 secondes : top 3 zones + météo. Tu démarres plus vite.',
    kw: ['guide', 'matin', 'vocal matin', '6h', 'démarrer', 'zone matin', 'réveil'],
  },
  {
    key: 'pieuvre_coach_active',
    display: 'Coach hebdo',
    script:
      'Chaque dimanche, Coach te fait le point : CA, zones, 3 leviers pour la semaine. Trois minutes max.',
    kw: ['coach', 'bilan', 'hebdo', 'semaine', 'dimanche', 'recap'],
  },
  {
    key: 'pieuvre_sentinel_active',
    display: 'Sentinel',
    script:
      'Sentinel surveille ton rythme. Si tu as une semaine compliquée, il te relance avec la bonne astuce.',
    kw: ['sentinel', 'décrocher', 'inactif', 'arrêt', 'rythme', 'retour', 'motivation'],
  },
  {
    key: 'pieuvre_compta_active',
    display: 'Compta IA',
    script: "Compta te fait le point fin de mois. Tu n'ouvres pas Excel.",
    kw: [
      'compta',
      'fiscal',
      'urssaf',
      'tva',
      'déclaration',
      'bilan',
      'pdf',
      'impôts',
      'taxes',
      'cotisation',
    ],
  },
  {
    key: 'driver_sites',
    display: 'Site perso + QR',
    script:
      'Ton site chauffeur avec QR code pour ta voiture. Clients réservent en direct, zéro commission.',
    kw: [
      'site perso',
      'site chauffeur',
      'qr code',
      'clients directs',
      'sans commission',
      'réservation directe',
    ],
  },
  {
    key: 'mlm_system',
    display: 'Parrainage MLM',
    script:
      "VIP active 3 niveaux : 10€ filleul direct + 4€ niveau 2 + 2€ niveau 3. À vie tant qu'ils restent.",
    kw: [
      'parrainage',
      'filleul',
      'mlm',
      'commission',
      'recruter',
      'parrainer',
      '10€',
      'argent passif',
    ],
  },
  {
    key: 'pieuvre_scraper_active',
    display: 'Spy événements',
    script:
      'Spy check météo, événements, transports. Grève métro demain à Paris, tu le sais ce soir.',
    kw: ['événement', 'grève', 'métro', 'transports', 'concert', 'match', 'météo', 'spy', 'veille'],
  },
  {
    key: 'pieuvre_tribal_active',
    display: 'Tribal WhatsApp',
    script:
      "Tribal t'ouvre le canal WhatsApp des chauffeurs FOREAS de ta ville. Tips en temps réel.",
    kw: ['whatsapp', 'groupe', 'communauté', 'tribal', 'chauffeurs', 'tips', 'partager'],
  },
  {
    key: 'community_enabled',
    display: 'Communauté',
    script: 'La Communauté FOREAS est accessible dès Essentiel. Forum + astuces.',
    kw: ['forum', 'communauté', 'astuces', 'conseils', 'entre chauffeurs'],
  },
];

// ─── Types ──────────────────────────────────────────────────────────────

export interface StreamBrainInput {
  tentacle: string;
  canal: string; // context.channel brut ('app'|'widget_site'|'ios'|'android'|'web'|'dashboard_driver'...)
  session_id: string;
  identity_id: string | null;
  user_text: string;
  history: Array<{ role?: string; text?: string; content?: string }>;
  page_source: string | null;
  scroll_section: string | null;
  heat_score: number;
  // gps/time/objective sont déjà connus synchrone (envoyés par le client) ; le profil chauffeur
  // (driver) est une requête Supabase à part — passée en PROMESSE pour tourner en VRAI parallèle
  // avec le reste de l'enrichissement (audit Fable 5 : sinon jusqu'à 2s ajoutées AVANT même le
  // calcul du TTFT, invisible dans enrichment_ms).
  live_context_partial: {
    gps: any;
    time: any;
    objective: any;
    driver_first_name_fallback: string | null;
    // 13/07 — brief AJNAYA_EXPERIENCE_PHONE_PROMPT_LIVE_CONTEXT.md (fil Site).
    // `now` = heure calculée CHAQUE tour côté client (Europe/Paris) — remplace `time`
    // quand présent, car `time` n'était fiable qu'au 1er tour d'une conversation
    // (cause probable du bug "lundi après-midi → Ajnaya parle de vendredi soir").
    now?: { day: string; time: string; bucket: string; iso: string } | null;
    // Envoyé au 1er tour seulement — mémoire de visite localStorage (home-modal).
    visitor?: { returning: boolean; visit_count: number; zones_seen_before: string[] } | null;
  };
  driver_context_promise: Promise<Record<string, unknown> | null>;
  client_version: string;
}

export interface StreamBrainResult {
  identity_id: string | null;
  prompt_tentacle: 'widget_site' | 'dashboard_driver';
  systemStatic: string;
  systemDynamic: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  model: string;
  model_reason: string;
  max_tokens: number;
  temperature: number;
  detected_objection: string | null;
  intent_detected: string;
  memory_rows_count: number;
  debug: {
    rag_injected: boolean;
    sonar_injected: boolean;
    feature_matched: number;
    history_turns: number;
    enrichment_ms: number;
  };
}

// ─── Intent detection (régex, zéro latence réseau — réutilisé pour le
// logging ET le routage Haiku/Sonnet, copie du node « Parse LLM Response ») ─

export function detectIntent(userText: string): string {
  const lt = (userText || '').toLowerCase();
  if (/\b(prix|coût|combien|tarif|payer|abonnement)\b/.test(lt)) return 'pricing';
  if (/\b(comment ça marche|comment fonctionne|c'est quoi|expliqu)\b/.test(lt))
    return 'how_it_works';
  if (/\b(essai|gratuit|trial|tester)\b/.test(lt)) return 'trial';
  if (/\b(uber|bolt|heetch|kapten|plateforme)\b/.test(lt)) return 'platforms';
  if (/\b(urssaf|compta|impôt|déclaration|tva|fisc)\b/.test(lt)) return 'admin_compta';
  if (/\b(zone|surge|où aller|gare|aéroport|hotspot)\b/.test(lt)) return 'zones';
  return 'general';
}

/**
 * Routage Haiku (rapide) / Sonnet (raisonnement) — NOUVEAU (brief §2.4).
 * Heuristique pure (pas d'appel réseau, sinon ça ajoute de la latence au lieu
 * d'en retirer). Sonnet dès qu'il faut RAISONNER (données temps réel
 * objectif/coach, compta, zones stratégiques, message long) ; Haiku sur le
 * FAQ-shaped court.
 */
export function pickModel(
  intent: string,
  hasRealtimeContext: boolean,
  userTextLen: number,
): { model: string; reason: string } {
  if (hasRealtimeContext) return { model: SONNET_MODEL, reason: 'realtime_context_reasoning' };
  if (intent === 'admin_compta' || intent === 'zones')
    return { model: SONNET_MODEL, reason: 'complex_intent' };
  if (userTextLen > 220) return { model: SONNET_MODEL, reason: 'long_message' };
  if (
    ['pricing', 'how_it_works', 'trial', 'platforms', 'general'].includes(intent) &&
    userTextLen <= 220
  ) {
    return { model: HAIKU_MODEL, reason: 'simple_intent' };
  }
  return { model: SONNET_MODEL, reason: 'default_safe' };
}

// ─── Enrichissement (identité, mémoire, prompt, objections, RAG, sonar) ────

async function resolveIdentity(
  supa: SupabaseClient,
  rawIdentityId: string | null,
  sessionId: string,
  canal: string,
): Promise<string | null> {
  if (rawIdentityId) return rawIdentityId;
  if (!sessionId) return null;
  try {
    const { data, error } = await supa.rpc('resolve_identity_v2', {
      p_identifiers: [{ id_type: 'visitor', id_value: String(sessionId), confidence: 0.5 }],
      p_context: { canal: canal || 'app' },
    });
    if (error) return null;
    const row = Array.isArray(data) ? data[0] : data;
    return row?.identity_id || null;
  } catch {
    return null; // fail-open — pas d'identité = pas de mémoire, le chat continue
  }
}

async function readCanalMemory(
  supa: SupabaseClient,
  rawIdentityId: string | null,
): Promise<{ memory: Record<string, unknown>; count: number }> {
  // ⚠️ Parité n8n : lu avec l'identity_id BRUT du payload (pas le résolu) —
  // même ordre-des-opérations que « Read canal_memory » → « Resolve Identity ».
  if (!rawIdentityId) return { memory: {}, count: 0 };
  try {
    const { data, error } = await supa
      .from('canal_memory')
      .select('context_key, context_value')
      .eq('identity_id', rawIdentityId)
      .order('updated_at', { ascending: false })
      .limit(50);
    if (error || !data) return { memory: {}, count: 0 };
    const memory: Record<string, unknown> = {};
    for (const row of data) {
      if (row?.context_key) memory[row.context_key] = row.context_value;
    }
    return { memory, count: data.length };
  } catch {
    return { memory: {}, count: 0 };
  }
}

async function readActivePrompt(
  supa: SupabaseClient,
  promptTentacle: string,
): Promise<string | null> {
  try {
    const { data, error } = await supa
      .from('pieuvre_scripts')
      .select('prompt_system')
      .eq('tentacle', promptTentacle)
      .eq('is_active', true)
      .order('conversion_rate', { ascending: false, nullsFirst: false })
      .limit(1);
    if (error || !data || data.length === 0) return null;
    return data[0]?.prompt_system || null;
  } catch {
    return null;
  }
}

async function readObjections(
  supa: SupabaseClient,
): Promise<Array<{ code: string; trigger_patterns: any; llm_hint: string }>> {
  try {
    const { data, error } = await supa
      .from('pieuvre_objection_playbook')
      .select('code, trigger_patterns, llm_hint')
      .eq('is_active', true)
      .limit(20);
    if (error || !data) return [];
    return data as any;
  } catch {
    return [];
  }
}

// Fable 5 a mesuré un spike à 2683ms sur cet appel (embedding OpenAI + RPC pgvector), sans budget —
// contrairement à Sonar (1500ms). Même traitement : on plafonne pour éviter une queue de latence P95.
const RAG_TIMEOUT_MS = 1200;

async function ragLookupInner(
  openai: OpenAI,
  supa: SupabaseClient,
  userText: string,
): Promise<string> {
  const embedResp = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: userText.slice(0, 500),
    dimensions: 1536,
  });
  const embedding = embedResp?.data?.[0]?.embedding;
  if (!embedding || embedding.length !== 1536) return '';
  const { data, error } = await supa.rpc('match_document_chunks', {
    query_embedding: embedding,
    match_count: 3,
    match_threshold: 0.65,
  });
  if (error || !Array.isArray(data) || data.length === 0) return '';
  const chunks = data.map((r: any) => r.chunk_text).join('\n\n---\n\n');
  return (
    '\n\n<rag_context>\n' +
    chunks.slice(0, 2000) +
    '\n</rag_context>\nUtilise ces infos factuelles pour répondre avec précision. Ne les cite pas mot pour mot — synthétise.'
  );
}

async function ragLookup(
  openai: OpenAI | null,
  supa: SupabaseClient,
  userText: string,
): Promise<string> {
  if (!userText || userText.length <= 8 || !openai) return '';
  try {
    const timeout = new Promise<string>((resolve) => setTimeout(() => resolve(''), RAG_TIMEOUT_MS));
    return await Promise.race([ragLookupInner(openai, supa, userText), timeout]);
  } catch {
    return ''; // dégrade en silence — même comportement que n8n
  }
}

const SONAR_TRIGGER_REGEX =
  /ce week[-\s]?end|cette semaine|ce mois|event|événement|concert|match|grève|manifestation|actu|infos Paris|qu['']est[-\s]ce qui se passe|2026.*loi|facturation électronique|urssaf.*2026|règle.*2026/i;

async function sonarLookup(userText: string): Promise<string> {
  const key = process.env.PERPLEXITY_API_KEY;
  if (!key || !SONAR_TRIGGER_REGEX.test(userText || '')) return '';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const resp = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'sonar-pro',
        messages: [
          {
            role: 'user',
            content:
              'En 150 mots max, donne les infos utiles pour un chauffeur VTC français sur : ' +
              (userText || '').slice(0, 200) +
              '. Focus : événements Paris, grèves transports, opportunités de zones chaudes.',
          },
        ],
        max_tokens: 350,
        temperature: 0.3,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return '';
    const parsed: any = await resp.json();
    const text = parsed?.choices?.[0]?.message?.content;
    if (!text || text.length <= 20) return '';
    return (
      '\n\n<web_context_realtime>\n' +
      text.slice(0, 600) +
      '\n</web_context_realtime>\nInfo temps réel disponible — utilise-la si pertinente pour répondre.'
    );
  } catch {
    return '';
  }
}

function buildFeatureBlock(userText: string): { block: string; count: number } {
  const lower = (userText || '').toLowerCase();
  const matched: string[] = [];
  for (const feat of FEATURE_CATALOG) {
    if (feat.kw.some((kw) => lower.includes(kw))) {
      matched.push(feat.display + ' : ' + feat.script);
      if (matched.length >= 2) break;
    }
  }
  if (matched.length === 0) return { block: '', count: 0 };
  return {
    block:
      '\n\n<feature_match>\nFeature(s) FOREAS pertinente(s) pour cette question :\n' +
      matched.map((f) => '- ' + f).join('\n') +
      '\n</feature_match>\nCite ces features naturellement si elles répondent au besoin.',
    count: matched.length,
  };
}

function buildLiveContextBlock(liveContext: any): string {
  const lc = liveContext;
  if (!lc || (!lc.driver && !lc.gps && !lc.time && !lc.now && !lc.visitor)) return '';
  const lines: string[] = [];
  if (lc.driver) {
    const d = lc.driver;
    let line1 = 'Chauffeur : ' + (d.first_name || d.full_name || 'inconnu');
    if (d.days_since_signup != null) line1 += ' (inscrit J-' + d.days_since_signup + ')';
    if (d.plan) line1 += ', plan ' + d.plan + (d.has_active_sub ? ' actif' : ' inactif');
    if (d.rating != null) line1 += ', rating ' + d.rating;
    lines.push(line1);
    // Ligne stats TOUJOURS présente, même à 0 — un vide ici laissait le modèle combler avec les
    // exemples du prompt (incident 09/07 : "87 courses, 2950€" inventés pour un chauffeur à 0 course).
    lines.push(
      d.total_rides
        ? 'Stats globales : ' + d.total_rides + ' courses, ' + (d.total_earnings || 0) + '€ cumulés'
        : "Stats globales : AUCUNE course enregistrée pour ce chauffeur — ne jamais inventer de chiffre, dis-le honnêtement s'il demande son bilan.",
    );
    if (d.earnings_today != null) lines.push("Aujourd'hui : " + d.earnings_today + '€');
    if (d.referrals_count) lines.push('Filleuls : ' + d.referrals_count);
    if (d.is_online != null) lines.push('Statut : ' + (d.is_online ? 'EN LIGNE' : 'hors ligne'));
  } else {
    // Identité chauffeur NON résolue (session app absente/expirée à cet instant — incident 09/07 :
    // identity_id retombé sur une résolution visiteur). Sans cette ligne, le modèle voit un simple
    // silence sur le profil et le comble avec les exemples du prompt (chiffres inventés).
    lines.push(
      "Profil chauffeur : NON RÉSOLU pour cet échange. AUCUNE stat, nom ou historique connu — ne jamais inventer de courses, montants ou détails personnels ; si on te demande un bilan, dis honnêtement que tu n'as pas accès aux données pour le moment.",
    );
  }
  // `now` (frais à chaque tour) prime sur `time` (potentiellement figé au 1er tour) —
  // ne JAMAIS afficher les deux, ça donnerait deux jours/heures différents au modèle.
  if (lc.now) {
    lines.push(
      'MAINTENANT (vérité absolue — ne mentionne JAMAIS un autre jour ou moment, même en exemple) : ' +
        (lc.now.day || '?') +
        ' ' +
        (lc.now.time || '?') +
        ', ' +
        (lc.now.bucket || '?'),
    );
  } else if (lc.time) {
    const t = lc.time;
    lines.push(
      'Moment : ' +
        (t.day_of_week || '?') +
        ' ' +
        (t.hour ?? '?') +
        'h' +
        (t.minute != null ? String(t.minute).padStart(2, '0') : '') +
        ' (' +
        (t.slot || '?') +
        ')' +
        (t.weekend ? ' WEEKEND' : ''),
    );
  }
  if (lc.visitor?.returning) {
    const vc = lc.visitor.visit_count;
    const zones = Array.isArray(lc.visitor.zones_seen_before)
      ? lc.visitor.zones_seen_before.filter(Boolean)
      : [];
    let visitorLine = 'Visiteur RECONNU : ' + (vc ? vc + 'e visite' : 'déjà venu(e)');
    if (zones.length) visitorLine += ', avait regardé ' + zones.slice(0, 3).join(', ');
    lines.push(visitorLine);
    lines.push(
      "INSTRUCTION OBLIGATOIRE, ne saute JAMAIS cette étape : ouvre ta réponse par une pirouette courte (3-8 mots) et complice qui montre que tu le/la reconnais, PUIS enchaîne sur la réponse normale (décision d'abord si recommandation — la pirouette n'est pas \"de la mise en contexte interdite\", c'est une salutation, elle passe AVANT la règle décision d'abord). Jamais un aveu robotique du style \"j'ai vos données enregistrées\" — ton malicieux, clin d'œil.\n" +
        'Exemple BANNI : "D\'après vos données, vous êtes déjà venu 3 fois."\n' +
        'Exemple BON : "Toi encore ! " + (réponse normale) ou "On se recroise, tu es tenace toi. " + (réponse normale) ou "3e fois que tu reviens voir La Défense, dis donc. " + (réponse normale).',
    );
  }
  if (lc.gps) {
    const g = lc.gps;
    if (g.place_name) {
      lines.push(
        'Position GPS LIVE : ' +
          g.place_name +
          ' (' +
          (g.lat?.toFixed?.(4) || g.lat || '?') +
          ', ' +
          (g.lng?.toFixed?.(4) || g.lng || '?') +
          ')',
      );
    } else if (g.lat) {
      lines.push('Position GPS LIVE : (' + g.lat + ', ' + g.lng + ')');
    }
  }
  if (lc.objective) lines.push('Objectif déclaré : ' + lc.objective);
  if (lines.length === 0) return '';
  return (
    '\n\n<live_context>\n' +
    lines.join('\n') +
    '\n</live_context>\nTU DOIS utiliser ces infos. NE DEMANDE JAMAIS "tu tournes où ?" si la position GPS est connue. Cite naturellement zone, heure, stats si pertinent. Si une ligne "MAINTENANT" est présente, c\'est la SEULE vérité temporelle autorisée — ne mentionne jamais un autre jour/moment (ex. ne dis pas "vendredi soir" si MAINTENANT dit "lundi après-midi"), même dans un "Pourquoi :" de recommandation.'
  );
}

function buildRealtimeBlock(history: StreamBrainInput['history']): string {
  let realtimeContext = '';
  for (const h of history || []) {
    if (h && h.role === 'system') {
      const t = h.text || h.content || '';
      if (t) realtimeContext += (realtimeContext ? '\n' : '') + String(t).slice(0, 1500);
    }
  }
  if (!realtimeContext) return '';
  return (
    '\n\n<donnees_temps_reel_chauffeur>\n' +
    realtimeContext +
    '\n</donnees_temps_reel_chauffeur>\n' +
    "Ce sont les CHIFFRES RÉELS du chauffeur — n'en invente JAMAIS d'autres. Quand il demande si son objectif est atteignable, ou pourquoi accepter/refuser une course, RAISONNE dessus : " +
    "atteignabilité = reste ÷ €/h réaliste = heures nécessaires ; sois HONNÊTE si c'est tendu ou impossible ce soir ; termine TOUJOURS par une piste concrète (zone chaude, meilleur créneau). " +
    'Tu es le MÊME cerveau que le Coach de course : si une offre a été refusée, explique-la avec la même logique (€/h vs référence, objectif, zone). Ton rationnel ET empathique, tutoiement pro FOREAS.'
  );
}

function detectObjection(
  userText: string,
  objections: Array<{ code: string; trigger_patterns: any }>,
): string | null {
  const lower = (userText || '').toLowerCase();
  for (const o of objections) {
    const tp = o.trigger_patterns;
    if (!tp) continue;
    const patterns = Array.isArray(tp?.regex) ? tp.regex : Array.isArray(tp) ? tp : [];
    for (const p of patterns) {
      try {
        if (new RegExp(String(p), 'i').test(lower)) return o.code;
      } catch {
        /* pattern invalide côté DB — ignore */
      }
    }
  }
  return null;
}

function buildObjectionHints(objections: Array<{ code: string; llm_hint: string }>): string {
  if (objections.length === 0) return '';
  let block = '\n\nOBJECTIONS COURANTES (références internes) :\n';
  for (const o of objections.slice(0, 12)) {
    if (o.code && o.llm_hint) block += '- [' + o.code + '] ' + o.llm_hint + '\n';
  }
  return block;
}

// ─── Point d'entrée ─────────────────────────────────────────────────────

export async function composeStreamContext(
  supa: SupabaseClient,
  openai: OpenAI | null,
  input: StreamBrainInput,
): Promise<StreamBrainResult> {
  const t0 = Date.now();

  const promptTentacle: 'widget_site' | 'dashboard_driver' =
    input.canal === 'dashboard_driver' ? 'dashboard_driver' : 'widget_site';
  const isAppChannel =
    input.tentacle === 'app_driver' ||
    input.canal === 'in_app' ||
    String(input.page_source || '')
      .toLowerCase()
      .startsWith('app');

  // Parité n8n : canal_memory lu AVANT résolution d'identité (avec l'id brut du payload).
  // driver_context_promise tourne en VRAI parallèle (déjà lancée par le caller AVANT cet appel,
  // audit Fable 5 : sinon jusqu'à 2s de latence invisible avant même l'ouverture du flux SSE).
  const [
    memoryResult,
    resolvedIdentityId,
    promptSystemFromDb,
    objections,
    ragBlock,
    sonarBlock,
    driverCtx,
  ] = await Promise.all([
    readCanalMemory(supa, input.identity_id),
    resolveIdentity(supa, input.identity_id, input.session_id, input.canal),
    readActivePrompt(supa, promptTentacle),
    readObjections(supa),
    ragLookup(openai, supa, input.user_text),
    sonarLookup(input.user_text),
    input.driver_context_promise,
  ]);

  const promptSystemBase = promptSystemFromDb || DEFAULT_PROMPT_SYSTEM_BASE;
  const objHints = buildObjectionHints(objections);
  const memoryContext =
    memoryResult.count > 0
      ? '\n\nMÉMOIRE PERSISTANTE (cross-canal) :\n' +
        Object.entries(memoryResult.memory)
          .map(([k, v]) => '- ' + k + ': ' + JSON.stringify(v).slice(0, 200))
          .join('\n')
      : '';
  const pageContext = input.page_source
    ? '\n\nCONTEXTE SESSION : page=' +
      input.page_source +
      ', section=' +
      (input.scroll_section || 'n/a') +
      ', heat_score=' +
      input.heat_score +
      '/100'
    : '';
  const lp = input.live_context_partial;
  const liveContext = {
    driver:
      driverCtx ||
      (lp?.driver_first_name_fallback ? { first_name: lp.driver_first_name_fallback } : null),
    gps: lp?.gps || null,
    time: lp?.time || null,
    now: lp?.now || null,
    visitor: lp?.visitor || null,
    objective: lp?.objective || null,
  };
  const liveContextBlock = buildLiveContextBlock(liveContext);
  const { block: featureBlock, count: featureCount } = buildFeatureBlock(input.user_text);
  const realtimeBlock = buildRealtimeBlock(input.history);
  const ancresBlock = isAppChannel ? ANCRES_BLOCK : '';
  const isFirstMessage =
    (input.history || []).filter((h) => h?.role && h.role !== 'system').length === 0;
  // Note : `isAppChannel` (défaut page_source = `app://${channel}`) classe à tort un appel
  // widget_site sans page_source explicite comme "app" — on utilise `tentacle` (résolu en amont,
  // fiable) pour ce gate, jamais `isAppChannel`.
  const whatsappPushBlock = buildWhatsappPushBlock(
    isFirstMessage,
    input.tentacle === 'widget_site',
  );

  // objHints (liste des objections courantes) est IDENTIQUE pour tous les chauffeurs — invariant,
  // donc mis dans le bloc STATIQUE caché (pas dynamique). Audit Fable 5 : le préfixe statique
  // (~1830 tokens) passait sous le minimum de cache Anthropic pour Haiku (2048 tokens, vs 1024
  // pour Sonnet) → cache_control silencieusement ignoré sur le modèle qui sert l'essentiel du
  // trafic. Ce déplacement pousse vers le seuil sans changer le contenu envoyé au LLM.
  const systemStatic = [
    promptSystemBase,
    ACT_OVER_ASK_BLOCK,
    MEMORY_NATURAL_BLOCK,
    AUDIO_TAGS_BLOCK,
    DECISION_FIRST_BLOCK,
    ancresBlock,
    objHints,
  ]
    .filter(Boolean)
    .join('');
  const systemDynamic = [
    memoryContext,
    pageContext,
    liveContextBlock,
    ragBlock,
    sonarBlock,
    featureBlock,
    realtimeBlock,
    whatsappPushBlock,
  ]
    .filter(Boolean)
    .join('');

  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const h of input.history || []) {
    if (h && h.role && h.role !== 'system' && (h.text || h.content)) {
      messages.push({
        role: h.role === 'user' ? 'user' : 'assistant',
        content: String(h.text || h.content).slice(0, 2000),
      });
    }
  }
  messages.push({ role: 'user', content: input.user_text });

  const detected_objection = detectObjection(input.user_text, objections);
  const intent_detected = detectIntent(input.user_text);
  const { model, reason: model_reason } = pickModel(
    intent_detected,
    !!realtimeBlock,
    (input.user_text || '').length,
  );

  return {
    identity_id: resolvedIdentityId,
    prompt_tentacle: promptTentacle,
    systemStatic,
    systemDynamic,
    messages,
    model,
    model_reason,
    max_tokens: MAX_TOKENS,
    temperature: TEMPERATURE,
    detected_objection,
    intent_detected,
    memory_rows_count: memoryResult.count,
    debug: {
      rag_injected: ragBlock.length > 0,
      sonar_injected: sonarBlock.length > 0,
      feature_matched: featureCount,
      history_turns: messages.length - 1,
      enrichment_ms: Date.now() - t0,
    },
  };
}
