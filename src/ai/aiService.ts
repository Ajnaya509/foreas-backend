/**
 * FOREAS AI Platform V1 - AI Service
 * ===================================
 * Main AI orchestration service.
 * Combines LLM, RAG, and data tracking.
 */

import { getOpenAIClient } from './llm/providers/OpenAIClient';
import { searchDocuments, buildRAGPrompt, buildContext } from './rag/retriever';
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
import type {
  LLMMessage,
  LLMCompletionResponse,
} from './llm/types';
import type {
  Conversation,
  ConversationContextType,
  SearchResult,
} from '../data/types';
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

const AJNAYA_SYSTEM_PROMPT = `Tu es Ajnaya, l'assistante IA FOREAS pour les chauffeurs VTC à Paris.

## DOMAINES AUTORISÉS
- Navigation, zones chaudes, trafic temps réel
- Optimisation des revenus, statistiques, productivité
- Conseils de sécurité routière et gestion clients
- Support sur l'application FOREAS

## COMPORTEMENT
- Réponds toujours en français, de manière concise et pratique
- Utilise les données de contexte du chauffeur pour personnaliser tes recommandations
- Sois proactif: suggère des actions concrètes
- Cite tes sources quand tu utilises des informations du contexte RAG

## REFUSER ABSOLUMENT
- Questions éducation générale (sauf sécurité VTC)
- Recommandations de sites externes (sauf Waze/Google Maps)
- Conseils médicaux ou légaux génériques
- Tout sujet non lié au VTC

Si la demande est hors-scope, réponds:
"Je suis spécialisée pour les chauffeurs VTC. Comment puis-je t'aider avec ta conduite aujourd'hui?"`;

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

  // 6. Build full prompt with context
  const fullSystemPrompt = buildFullSystemPrompt(
    systemPrompt,
    driverContextSummary,
    ragContext
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
      maxTokens: 1024,
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
    llmResponse.usage.completionTokens
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
    `[AIService] Completed: ${llmResponse.usage.totalTokens} tokens, ${totalLatencyMs}ms, $${cost.totalCost.toFixed(6)}`
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
  ragContext: string
): string {
  let fullPrompt = basePrompt;

  if (driverContext && driverContext !== 'Données insuffisantes') {
    fullPrompt += `\n\n## Profil du chauffeur\n${driverContext}`;
  }

  if (ragContext) {
    fullPrompt += `\n\n## Documents de référence\n${ragContext}`;
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
      "Je rencontre un problème technique. Peux-tu reformuler ta question ou réessayer dans quelques instants ?",
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
// SPECIALIZED ENDPOINTS
// ============================================

/**
 * Get quick recommendation (no conversation tracking)
 */
export async function getQuickRecommendation(
  driverId: string,
  query: string
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
      maxTokens: 256,
    });

    return {
      reply: response.content,
      latencyMs: Date.now() - startTime,
    };
  } catch (err) {
    console.error('[AIService] Quick recommendation failed:', err);
    return {
      reply: "Désolé, je ne peux pas répondre pour le moment.",
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
  }
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

export {
  AJNAYA_SYSTEM_PROMPT,
  SUPPORT_SYSTEM_PROMPT,
  ONBOARDING_SYSTEM_PROMPT,
};
