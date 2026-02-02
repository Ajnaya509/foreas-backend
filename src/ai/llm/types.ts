/**
 * FOREAS AI Platform V1 - LLM Types
 * ==================================
 * Unified types for LLM provider abstraction.
 */

// ============================================
// MESSAGE TYPES
// ============================================

export type LLMRole = 'system' | 'user' | 'assistant';

export interface LLMMessage {
  role: LLMRole;
  content: string;
}

// ============================================
// REQUEST/RESPONSE TYPES
// ============================================

export interface LLMCompletionRequest {
  messages: LLMMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  stop?: string[];
  stream?: boolean;
}

export interface LLMCompletionResponse {
  content: string;
  model: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  finishReason: 'stop' | 'length' | 'content_filter' | 'null' | string;
  latencyMs: number;
}

// ============================================
// EMBEDDING TYPES
// ============================================

export interface LLMEmbeddingRequest {
  input: string | string[];
  model?: string;
}

export interface LLMEmbeddingResponse {
  embeddings: number[][];
  model: string;
  usage: {
    promptTokens: number;
    totalTokens: number;
  };
}

// ============================================
// PROVIDER CONFIGURATION
// ============================================

export type LLMProvider = 'openai' | 'mistral' | 'anthropic';

export interface LLMProviderConfig {
  provider: LLMProvider;
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
  defaultEmbeddingModel?: string;
  maxRetries?: number;
  timeoutMs?: number;
}

// ============================================
// COST TRACKING
// ============================================

export interface LLMCostEstimate {
  inputCost: number;
  outputCost: number;
  totalCost: number;
  currency: 'USD';
}

// Model pricing (per 1M tokens as of Feb 2026)
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // OpenAI
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4-turbo': { input: 10, output: 30 },
  'gpt-3.5-turbo': { input: 0.5, output: 1.5 },
  'text-embedding-3-small': { input: 0.02, output: 0 },
  'text-embedding-3-large': { input: 0.13, output: 0 },
  'text-embedding-ada-002': { input: 0.1, output: 0 },

  // Mistral
  'mistral-7b-instruct': { input: 0.25, output: 0.25 },
  'mistral-small': { input: 1, output: 3 },
  'mistral-medium': { input: 2.7, output: 8.1 },
  'mistral-large': { input: 4, output: 12 },
  'mistral-embed': { input: 0.1, output: 0 },

  // Default fallback
  default: { input: 1, output: 3 },
};

export function estimateCost(
  model: string,
  promptTokens: number,
  completionTokens: number
): LLMCostEstimate {
  const pricing = MODEL_PRICING[model] || MODEL_PRICING.default;

  const inputCost = (promptTokens / 1_000_000) * pricing.input;
  const outputCost = (completionTokens / 1_000_000) * pricing.output;

  return {
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost,
    currency: 'USD',
  };
}

// ============================================
// ERROR TYPES
// ============================================

export class LLMError extends Error {
  constructor(
    message: string,
    public provider: LLMProvider,
    public statusCode?: number,
    public retryable: boolean = false
  ) {
    super(message);
    this.name = 'LLMError';
  }
}

export class LLMRateLimitError extends LLMError {
  constructor(
    provider: LLMProvider,
    public retryAfterMs?: number
  ) {
    super('Rate limit exceeded', provider, 429, true);
    this.name = 'LLMRateLimitError';
  }
}

export class LLMTimeoutError extends LLMError {
  constructor(provider: LLMProvider) {
    super('Request timed out', provider, 408, true);
    this.name = 'LLMTimeoutError';
  }
}

export class LLMAuthError extends LLMError {
  constructor(provider: LLMProvider) {
    super('Authentication failed', provider, 401, false);
    this.name = 'LLMAuthError';
  }
}
