/**
 * FOREAS AI Platform V1 - AI Service
 * ===================================
 * Main AI orchestration service.
 * Combines LLM, RAG, and data tracking.
 */

import { getOpenAIClient } from './llm/providers/OpenAIClient';
import { AJNAYA_BASE_SYSTEM_PROMPT } from '../constants/ajnayaPersonality';
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

// v66 — ADN Ajnaya depuis la source unique de vérité (constants/ajnayaPersonality.ts)
const AJNAYA_SYSTEM_PROMPT = AJNAYA_BASE_SYSTEM_PROMPT;

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

  // 5c. Perplexity Sonar — recherche temps réel (compta, fiscal, VTC)
  let sonarContext = '';
  try {
    const { needsSonarSearch, querySonar, formatSonarContext } =
      await import('../services/perplexitySonar.js');
    if (needsSonarSearch(input.message)) {
      const sonarResult = await querySonar(input.message);
      if (sonarResult) {
        sonarContext = formatSonarContext(sonarResult);
        console.log('[AIService] 🔍 Sonar injecté (compta/IA)');
      }
    }
  } catch (sonarErr: any) {
    console.warn('[AIService] Sonar skip:', sonarErr?.message);
  }

  // 6. Build full prompt with context + realtime data + Sonar
  const fullSystemPrompt = buildFullSystemPrompt(
    systemPrompt,
    driverContextSummary,
    ragContext,
    realtimeContext + (sonarContext ? '\n\n' + sonarContext : ''),
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
