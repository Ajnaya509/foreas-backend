/**
 * FOREAS AI Platform V1 - LLM Client Interface
 * =============================================
 * Abstract base class for LLM providers.
 */

import type {
  LLMCompletionRequest,
  LLMCompletionResponse,
  LLMEmbeddingRequest,
  LLMEmbeddingResponse,
  LLMProviderConfig,
  LLMProvider,
} from './types';

/**
 * Abstract LLM Client interface
 */
export abstract class LLMClient {
  protected config: LLMProviderConfig;

  constructor(config: LLMProviderConfig) {
    this.config = config;
  }

  /**
   * Get the provider name
   */
  abstract get provider(): LLMProvider;

  /**
   * Get available models for this provider
   */
  abstract getAvailableModels(): string[];

  /**
   * Generate a chat completion
   */
  abstract complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse>;

  /**
   * Generate embeddings for text
   */
  abstract embed(request: LLMEmbeddingRequest): Promise<LLMEmbeddingResponse>;

  /**
   * Check if the client is properly configured
   */
  abstract isConfigured(): boolean;

  /**
   * Get the default model for completions
   */
  getDefaultModel(): string {
    return this.config.defaultModel || 'gpt-4o-mini';
  }

  /**
   * Get the default model for embeddings
   */
  getDefaultEmbeddingModel(): string {
    return this.config.defaultEmbeddingModel || 'text-embedding-3-small';
  }

  /**
   * Helper: retry with exponential backoff
   */
  protected async withRetry<T>(
    operation: () => Promise<T>,
    maxRetries: number = this.config.maxRetries || 3
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await operation();
      } catch (err) {
        lastError = err as Error;

        // Check if error is retryable
        if ((err as any).retryable === false) {
          throw err;
        }

        // Exponential backoff
        const delayMs = Math.min(1000 * Math.pow(2, attempt), 10000);
        console.warn(`[LLMClient] Attempt ${attempt + 1}/${maxRetries} failed, retrying in ${delayMs}ms`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    throw lastError;
  }
}
