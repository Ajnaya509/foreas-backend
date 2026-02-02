/**
 * FOREAS AI Platform V1 - LLM Module Index
 * =========================================
 * Centralized exports for LLM abstraction.
 */

// Types
export * from './types';

// Base client
export { LLMClient } from './LLMClient';

// Providers
export {
  OpenAIClient,
  getOpenAIClient,
  MistralClient,
  getMistralClient,
} from './providers';

// ============================================
// FACTORY FUNCTION
// ============================================

import type { LLMProvider, LLMProviderConfig } from './types';
import { LLMClient } from './LLMClient';
import { OpenAIClient } from './providers/OpenAIClient';
import { MistralClient } from './providers/MistralClient';

/**
 * Create an LLM client for the specified provider
 */
export function createLLMClient(
  provider: LLMProvider,
  config?: Partial<LLMProviderConfig>
): LLMClient {
  switch (provider) {
    case 'openai':
      return new OpenAIClient(config);
    case 'mistral':
      return new MistralClient(config);
    default:
      throw new Error(`Unknown LLM provider: ${provider}`);
  }
}

/**
 * Get the default LLM client (OpenAI for now)
 */
export function getDefaultLLMClient(): LLMClient {
  const openai = new OpenAIClient();
  if (openai.isConfigured()) {
    return openai;
  }

  const mistral = new MistralClient();
  if (mistral.isConfigured()) {
    return mistral;
  }

  // Return OpenAI anyway (will error on use if not configured)
  console.warn('[LLM] No provider configured, defaulting to OpenAI');
  return openai;
}
