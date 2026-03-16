/**
 * FOREAS AI Platform V1 - AI Service
 * ===================================
 * Main AI orchestration service.
 * Combines LLM, RAG, and data tracking.
 */

import { getOpenAIClient } from './llm/providers/OpenAIClient';
import { searchDocuments, buildRAGPrompt, buildContext } from './rag/retriever';
import {
  getWeatherContext,
  getTrainContext,
  getEventsContext,
  getTrafficContext,
  getTransportContext,
  getCalendarContext,
  getSocialContext,
} from '../services/realtimeAdapters';
import {
  createConversation,
  getConversation,
  updateConversationStatus,
  logMessage,
  buildMessageHistory,
} from '../data/conversationLog';
import { getDriverContext, buildContextSummary } from '../data/featureStore';
import { recordOutcomeAsync } from '../data/outcomes';
import { trackEventAsync } from '../data/eventStore';
import type { LLMMessage, LLMCompletionResponse } from './llm/types';
import type { Conversation, ConversationContextType, SearchResult } from '../data/types';
import { estimateCost } from './llm/types';

// ============================================
// CONFIGURATION
// ============================================

const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_TEMPERATURE = 0.7;
const MAX_CONTEXT_MESSAGES = 10;
const RAG_MAX_RESULTS = 5;

// ============================================
// SYSTEM PROMPTS
// ============================================

const AJNAYA_SYSTEM_PROMPT = `Tu es Ajnaya. 15 ans de terrain VTC à Paris. Tu connais chaque rue, chaque algorithme, chaque piège. T'es pas une IA générique — t'es LA référence que les anciens appellent quand ils doutent.

═══ FORMAT OBLIGATOIRE ═══
⚠️ RÈGLE #1 : 2 À 4 PHRASES MAX. JAMAIS PLUS. C'EST NON NÉGOCIABLE.
- Phrase 1 : le conseil direct, l'action, le lieu
- Phrase 2 : le POURQUOI en quelques mots (algorithme, data, expérience)
- Phrase 3 (si utile) : l'astuce terrain que personne connaît
- Phrase 4 (si utile) : la mise en garde ou le bonus
- Si ça tient en 2 phrases → 2 phrases. T'es pas prof, t'es copilote.
- ZÉRO liste à puces. ZÉRO pavé. Tu parles comme sur le siège passager.

═══ TA PERSONNALITÉ ═══
- Tu TUTOIES toujours. T'es un ancien du terrain, pas un chatbot corporate.
- Tu parles CASH. Pas méchant, mais direct. "Reste pas là" pas "je te suggérerais éventuellement de..."
- Légèrement sarcastique quand c'est mérité : "Tu veux rester à Roissy un vendredi à 15h ? Bon courage, t'es le 47ème en file."
- Tu donnes des NOMS DE LIEUX précis, pas des généralités. "Va à Porte Maillot" pas "dirige-toi vers une zone à forte demande".
- Tu cites les plateformes par leur nom : Uber, Bolt, Heetch, FreeNow, Marcel.
- T'es obsédé par le €/h net. Tout se ramène à ça.

═══ CE QUE TU MAÎTRISES (même si c'est simulé, ça doit être CRÉDIBLE) ═══

ALGORITHMES PLATEFORMES :
- Uber : L'algo priorise le taux d'acceptation (>85%) + la proximité au client. Refuser 3 courses de suite → tu tombes en bas de la pile pendant 15-20 min. Le surge est déclenché quand le ratio demande/chauffeurs dépasse 1.5x dans un rayon de 800m. Uber Pro : Diamond = 3% de réduction sur l'essence chez BP, accès aux courses longues.
- Bolt : Moins de chauffeurs = meilleur positionnement. L'algo Bolt favorise ceux qui restent connectés longtemps sans pause. Commission 15% vs 25% Uber → plus rentable sur les petites courses. Bolt envoie des notifs "zone chaude" mais c'est souvent du retard de 10-15 min sur la réalité.
- Heetch : Spécialisé soirée/nuit (22h-6h). Clientèle jeune, courses courtes mais enchaînement rapide. L'algo donne la priorité aux chauffeurs qui se connectent régulièrement vs ceux qui viennent que le week-end.
- FreeNow : Courses premium, clientèle business. Pourboires plus fréquents. Moins de volume mais meilleur panier moyen.

ZONES PARIS — TA CARTE MENTALE :
- Matin 7h-10h semaine : Gares (Nord, Lyon, Saint-Lazare) + La Défense. Les TGV de 7h30-8h30 = gold.
- Midi 12h-14h : Quartiers d'affaires (Opéra, Madeleine, 8ème). Déjeuners clients = courses courtes mais rapides.
- Soir 17h-20h : Champs, Châtelet, Bastille. Le retour bureau + début de soirée.
- Nuit 22h-2h : Oberkampf, Pigalle, Bastille, Marais. Enchaînement rapide.
- Week-end jour : Touristes = Trocadéro, Champs, Montmartre.
- Week-end nuit : Bastille, Pigalle, Oberkampf, Canal Saint-Martin.
- Événements : Bercy/Accor Arena, Stade de France, Parc des Princes, Zénith, Porte de Versailles (salons).
- Aéroports : CDG = 55-70€ la course, mais 45 min de file d'attente. Rentable que si t'y vas avec une course aller. Orly = plus rapide, 35-50€.
- PIÈGE : Roissy un vendredi après-midi, La Défense un dimanche, les Champs à 3h du mat (que des touristes qui marchent).

STRATÉGIES TERRAIN :
- Multi-app : Allume Uber + Bolt en parallèle, prends la première qui tombe, coupe l'autre. Sur Heetch la nuit c'est souvent plus rentable que Uber sans surge.
- Enchaînement : Accepte la course même si elle est courte SI elle t'emmène vers une zone chaude. Refuser une course à 5€ qui t'emmène à Gare du Nord → erreur de débutant.
- Positionnement : Gare-toi à 200-300m des gares, pas devant. L'algo cherche le chauffeur LE PLUS PROCHE du client, pas celui dans le parking VTC.
- Surge : Quand tu vois le surge monter dans une zone, y va AVANT qu'il peak. Le temps que t'arrives, le surge est souvent redescendu si t'attends.
- Fatigue : Au-delà de 10h de conduite, ton €/h chute. Mieux vaut 8h bien placées que 12h en roue libre.

═══ COMMENT TU FORMULES ═══

Exemples parfaits :
- "Va à Porte Maillot, c'est à 800m. L'algo Uber te priorisera pas ici, trop de chauffeurs. Fais-moi confiance, tu gagneras plus là-bas."
- "Gare du Nord dans 20 min, y'a un Thalys qui arrive. Place-toi rue de Dunkerque, pas dans la file VTC."
- "Coupe Uber, garde que Bolt ce soir. Moins de concurrence, commission plus basse, tu sors gagnant."
- "T'es à 12€/h net là. En te décalant sur Bastille tu passes à 18-20€/h, c'est vendredi soir."
- "Reste pas à CDG un mardi à 14h. File d'attente 50 min pour une course à Villepinte. Rentre sur Paris."

═══ REFUSER ═══
Hors VTC → "Je suis calée VTC, pas là-dessus. Comment je peux t'aider pour tes courses ?"
JAMAIS de conseil médical, juridique, ou sujet non-VTC.
Français uniquement. Tutoiement uniquement.`;

const SUPPORT_SYSTEM_PROMPT = `Tu es l'assistant support FOREAS.
Aide les utilisateurs avec leurs questions sur l'application FOREAS.
Sois professionnel, patient et précis dans tes réponses.
Utilise les guides et FAQ fournis en contexte.`;

const ONBOARDING_SYSTEM_PROMPT = `Tu es l'assistant d'onboarding FOREAS.
Guide les nouveaux chauffeurs dans leur découverte de l'application.
Sois encourageant et explique les fonctionnalités étape par étape.
Personnalise tes conseils selon le profil du chauffeur.`;

// ============================================
// MAIN AI SERVICE
// ============================================

export interface AIRequestInput {
  driverId: string;
  message: string;
  conversationId?: string;
  contextType?: ConversationContextType;
  sessionId?: string;
  useRAG?: boolean;
  temperature?: number;
  model?: string;
}

export interface AIResponse {
  reply: string;
  conversationId: string;
  messageId: string;
  ragChunksUsed: string[];
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  costUsd: number;
  latencyMs: number;
}

/**
 * Process an AI request with full pipeline
 */
export async function processAIRequest(input: AIRequestInput): Promise<AIResponse> {
  const startTime = Date.now();
  const llm = getOpenAIClient();

  // 1. Get or create conversation
  let conversation: Conversation;
  if (input.conversationId) {
    const existing = await getConversation(input.conversationId);
    if (existing) {
      conversation = existing;
    } else {
      conversation = await createConversation({
        driverId: input.driverId,
        sessionId: input.sessionId,
        contextType: input.contextType || 'recommendation',
      });
    }
  } else {
    // Get driver context for features snapshot
    const { snapshotId } = await getDriverContext(input.driverId);

    conversation = await createConversation({
      driverId: input.driverId,
      sessionId: input.sessionId,
      contextType: input.contextType || 'recommendation',
      featuresSnapshotId: snapshotId || undefined,
    });
  }

  // 2. Get conversation history
  const history = await buildMessageHistory(conversation.id, MAX_CONTEXT_MESSAGES);

  // 3. Build driver context
  const driverContextSummary = await buildContextSummary(input.driverId);

  // 4. RAG search (if enabled)
  let ragResults: SearchResult[] = [];
  let ragContext = '';

  if (input.useRAG !== false) {
    try {
      ragResults = await searchDocuments(input.message, {
        maxResults: RAG_MAX_RESULTS,
        threshold: 0.65,
      });
      ragContext = buildContext(ragResults);
    } catch (err) {
      console.error('[AIService] RAG search failed:', err);
    }
  }

  // 5. Select system prompt based on context type
  let systemPrompt: string;
  switch (conversation.context_type) {
    case 'support':
      systemPrompt = SUPPORT_SYSTEM_PROMPT;
      break;
    case 'onboarding':
      systemPrompt = ONBOARDING_SYSTEM_PROMPT;
      break;
    default:
      systemPrompt = AJNAYA_SYSTEM_PROMPT;
  }

  // 5b. Collect realtime context from APIs (weather, trains, transport)
  let realtimeContext = '';
  try {
    const realtimeParts = await collectRealtimeContext(input);
    realtimeContext = realtimeParts;
  } catch (err) {
    console.warn('[AIService] Realtime context collection failed (non-blocking):', err);
  }

  // 6. Build full prompt with context + realtime data
  const fullSystemPrompt = buildFullSystemPrompt(
    systemPrompt,
    driverContextSummary,
    ragContext,
    realtimeContext,
  );

  // 7. Build messages array
  const messages: LLMMessage[] = [
    { role: 'system', content: fullSystemPrompt },
    ...history,
    { role: 'user', content: input.message },
  ];

  // 8. Log user message
  await logMessage({
    conversationId: conversation.id,
    role: 'user',
    contentRedacted: input.message,
  });

  // 9. Call LLM
  let llmResponse: LLMCompletionResponse;
  try {
    llmResponse = await llm.complete({
      messages,
      model: input.model || DEFAULT_MODEL,
      temperature: input.temperature ?? DEFAULT_TEMPERATURE,
      maxTokens: 300,
    });
  } catch (err) {
    console.error('[AIService] LLM call failed:', err);
    // Return fallback response
    return createFallbackResponse(conversation.id, startTime);
  }

  // 10. Calculate cost
  const cost = estimateCost(
    input.model || DEFAULT_MODEL,
    llmResponse.usage.promptTokens,
    llmResponse.usage.completionTokens,
  );

  // 11. Log assistant message
  const ragChunkIds = ragResults.map((r) => r.chunk_id);
  const assistantMessage = await logMessage({
    conversationId: conversation.id,
    role: 'assistant',
    contentRedacted: llmResponse.content,
    ragChunksUsed: ragChunkIds,
    model: llmResponse.model,
    provider: 'openai',
    tokensInput: llmResponse.usage.promptTokens,
    tokensOutput: llmResponse.usage.completionTokens,
    latencyMs: llmResponse.latencyMs,
    costUsd: cost.totalCost,
    promptContextSummary: summarizeContext(driverContextSummary, ragResults.length),
  });

  // 12. Track event
  trackEventAsync({
    eventName: 'ai.completion',
    eventCategory: 'recommendation',
    actorId: input.driverId,
    actorRole: 'driver',
    payload: {
      conversation_id: conversation.id,
      context_type: conversation.context_type,
      model: llmResponse.model,
      tokens_total: llmResponse.usage.totalTokens,
      rag_chunks_used: ragChunkIds.length,
      latency_ms: llmResponse.latencyMs,
    },
  });

  const totalLatencyMs = Date.now() - startTime;

  console.log(
    `[AIService] Completed: ${llmResponse.usage.totalTokens} tokens, ${totalLatencyMs}ms, $${cost.totalCost.toFixed(6)}`,
  );

  return {
    reply: llmResponse.content,
    conversationId: conversation.id,
    messageId: assistantMessage.id,
    ragChunksUsed: ragChunkIds,
    usage: llmResponse.usage,
    costUsd: cost.totalCost,
    latencyMs: totalLatencyMs,
  };
}

// ============================================
// HELPER FUNCTIONS
// ============================================

function buildFullSystemPrompt(
  basePrompt: string,
  driverContext: string,
  ragContext: string,
  realtimeContext?: string,
): string {
  let fullPrompt = basePrompt;

  if (driverContext && driverContext !== 'Données insuffisantes') {
    fullPrompt += `\n\n═══ PROFIL DU CHAUFFEUR ═══\n${driverContext}`;
  }

  if (ragContext) {
    fullPrompt += `\n\n═══ DOCUMENTS DE RÉFÉRENCE ═══\n${ragContext}`;
  }

  if (realtimeContext) {
    fullPrompt += `\n\n═══ DONNÉES TEMPS RÉEL (fiables, utilise-les) ═══\n${realtimeContext}`;
  }

  return fullPrompt;
}

function summarizeContext(driverContext: string, ragCount: number): string {
  const parts: string[] = [];

  if (driverContext && driverContext !== 'Données insuffisantes') {
    parts.push('driver_profile');
  }

  if (ragCount > 0) {
    parts.push(`rag_${ragCount}_chunks`);
  }

  return parts.join(', ') || 'none';
}

function createFallbackResponse(conversationId: string, startTime: number): AIResponse {
  return {
    reply:
      'Je rencontre un problème technique. Peux-tu reformuler ta question ou réessayer dans quelques instants ?',
    conversationId,
    messageId: '',
    ragChunksUsed: [],
    usage: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    },
    costUsd: 0,
    latencyMs: Date.now() - startTime,
  };
}

// ============================================
// REALTIME CONTEXT COLLECTION
// ============================================

/**
 * 🧠 CERVEAU DÉCISIONNEL AJNAYA — Collecte temps réel
 *
 * Collecte en PARALLÈLE toutes les données contextuelles :
 * 1. Heure/jour (gratuit, 0 API call)
 * 2. OpenWeather (météo Paris, pluie, neige)
 * 3. SNCF (arrivées TGV gares parisiennes)
 * 4. Analyse sémantique du message (intentions chauffeur)
 *
 * Non-bloquant : si une API échoue, on continue sans.
 * Coût : 0€ (toutes les APIs sont gratuites)
 * Latence : ~200-400ms max (appels parallèles + cache)
 * Tokens ajoutés : ~100-200 tokens
 */
async function collectRealtimeContext(input: AIRequestInput): Promise<string> {
  const parts: string[] = [];
  const now = new Date();
  const hour = now.getHours();
  const dayOfWeek = now.getDay();
  const dayNames = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
  const dayName = dayNames[dayOfWeek];
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

  // ─── 1. Contexte temporel (toujours, 0 API call) ───
  parts.push(
    `HEURE : ${dayName} ${hour}h${now.getMinutes().toString().padStart(2, '0')}${isWeekend ? ' (week-end)' : ''}`,
  );

  // ─── 2. Créneau horaire → conseil de fond ───
  if (hour >= 7 && hour <= 9 && !isWeekend) {
    parts.push('CRÉNEAU : Rush matin semaine — gares + La Défense = priorité.');
  } else if (hour >= 17 && hour <= 20) {
    parts.push('CRÉNEAU : Rush soir — centres-villes + gares retour = priorité.');
  } else if (hour >= 22 || hour <= 3) {
    parts.push('CRÉNEAU : Nuit — Oberkampf, Pigalle, Bastille, Marais = enchaînement rapide.');
  } else if (isWeekend && hour >= 10 && hour <= 18) {
    parts.push('CRÉNEAU : Week-end jour — zones touristiques (Trocadéro, Champs, Montmartre).');
  }

  // ─── 3. APIs temps réel EN PARALLÈLE (toutes en même temps = ~300ms max) ───
  const [
    weatherResult,
    trainResult,
    eventsResult,
    trafficResult,
    transportResult,
    calendarResult,
    socialResult,
  ] = await Promise.allSettled([
    getWeatherContext(),
    getTrainContext(),
    getEventsContext(),
    getTrafficContext(),
    getTransportContext(),
    getCalendarContext(),
    getSocialContext(),
  ]);

  if (weatherResult.status === 'fulfilled' && weatherResult.value) {
    parts.push(weatherResult.value);
  }
  if (trainResult.status === 'fulfilled' && trainResult.value) {
    parts.push(trainResult.value);
  }
  if (eventsResult.status === 'fulfilled' && eventsResult.value) {
    parts.push(eventsResult.value);
  }
  if (trafficResult.status === 'fulfilled' && trafficResult.value) {
    parts.push(trafficResult.value);
  }
  if (transportResult.status === 'fulfilled' && transportResult.value) {
    parts.push(transportResult.value);
  }
  if (calendarResult.status === 'fulfilled' && calendarResult.value) {
    parts.push(calendarResult.value);
  }
  if (socialResult.status === 'fulfilled' && socialResult.value) {
    parts.push(socialResult.value);
  }

  // ─── 4. Analyse sémantique du message chauffeur ───
  const message = input.message.toLowerCase();

  if (
    message.includes('gare') ||
    message.includes('train') ||
    message.includes('tgv') ||
    message.includes('sncf')
  ) {
    parts.push(
      'INTENTION : Le chauffeur parle de gares/trains — priorise les arrivées TGV et le positionnement gare.',
    );
  }
  if (
    message.includes('pluie') ||
    message.includes('pleut') ||
    message.includes('météo') ||
    message.includes('temps')
  ) {
    parts.push(
      "INTENTION : Le chauffeur demande la météo — rappelle l'impact pluie/neige sur la demande (+20-30% surge).",
    );
  }
  if (
    message.includes('grève') ||
    message.includes('perturbation') ||
    message.includes('ratp') ||
    message.includes('métro') ||
    message.includes('rer')
  ) {
    parts.push(
      'INTENTION : Le chauffeur mentionne les transports en commun — les perturbations RATP/SNCF = explosion demande VTC.',
    );
  }
  if (
    message.includes('uber') ||
    message.includes('bolt') ||
    message.includes('heetch') ||
    message.includes('freenow')
  ) {
    parts.push(
      "INTENTION : Le chauffeur parle d'une plateforme — cite les spécificités algo de cette plateforme.",
    );
  }
  if (
    message.includes('fatigué') ||
    message.includes('dormir') ||
    message.includes('pause') ||
    message.includes('arrêt')
  ) {
    parts.push(
      'INTENTION : Le chauffeur est fatigué — privilégie sa sécurité, suggère un créneau optimal pour reprendre.',
    );
  }
  if (
    message.includes('combien') ||
    message.includes('gagn') ||
    message.includes('revenu') ||
    message.includes('argent') ||
    message.includes('€')
  ) {
    parts.push(
      'INTENTION : Le chauffeur parle de revenus — réponds en €/h net, donne des leviers concrets.',
    );
  }

  return parts.join('\n');
}

// ============================================
// SPECIALIZED ENDPOINTS
// ============================================

/**
 * Get quick recommendation (no conversation tracking)
 */
export async function getQuickRecommendation(
  driverId: string,
  query: string,
): Promise<{ reply: string; latencyMs: number }> {
  const startTime = Date.now();
  const llm = getOpenAIClient();

  // Get driver context
  const driverContext = await buildContextSummary(driverId);

  // Simple prompt
  const messages: LLMMessage[] = [
    {
      role: 'system',
      content: `${AJNAYA_SYSTEM_PROMPT}\n\n## Profil\n${driverContext}`,
    },
    { role: 'user', content: query },
  ];

  try {
    const response = await llm.complete({
      messages,
      model: 'gpt-4o-mini',
      temperature: 0.7,
      maxTokens: 200,
    });

    return {
      reply: response.content,
      latencyMs: Date.now() - startTime,
    };
  } catch (err) {
    console.error('[AIService] Quick recommendation failed:', err);
    return {
      reply: 'Désolé, je ne peux pas répondre pour le moment.',
      latencyMs: Date.now() - startTime,
    };
  }
}

/**
 * Complete conversation and record outcome
 */
export async function completeConversation(
  conversationId: string,
  outcomeData?: {
    actionRecommended: string;
    actionTaken?: string;
    outcomeType?: 'accepted' | 'rejected' | 'ignored';
  },
): Promise<void> {
  const conversation = await getConversation(conversationId);
  if (!conversation) return;

  await updateConversationStatus(conversationId, 'completed');

  if (outcomeData) {
    recordOutcomeAsync({
      conversationId,
      driverId: conversation.driver_id,
      actionRecommended: outcomeData.actionRecommended,
      actionTaken: outcomeData.actionTaken,
      outcomeType: outcomeData.outcomeType || 'unknown',
    });
  }
}

// ============================================
// EXPORTS
// ============================================

export { AJNAYA_SYSTEM_PROMPT, SUPPORT_SYSTEM_PROMPT, ONBOARDING_SYSTEM_PROMPT };
