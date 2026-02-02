/**
 * FOREAS AI Platform V1 - Module Index
 * =====================================
 * Centralized exports for the AI layer.
 */

// LLM Module
export * from './llm';

// RAG Module
export * from './rag';

// AI Service
export {
  processAIRequest,
  getQuickRecommendation,
  completeConversation,
  AJNAYA_SYSTEM_PROMPT,
  SUPPORT_SYSTEM_PROMPT,
  ONBOARDING_SYSTEM_PROMPT,
} from './aiService';

export type { AIRequestInput, AIResponse } from './aiService';
