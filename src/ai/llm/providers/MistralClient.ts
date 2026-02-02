/**
 * FOREAS AI Platform V1 - Mistral Client (STUB)
 * =============================================
 * Mistral AI API implementation of LLMClient.
 *
 * STATUS: STUB - Ready for future activation
 * Pour activer: Configurer MISTRAL_API_KEY dans Railway
 */

import { LLMClient } from '../LLMClient';
import type {
  LLMCompletionRequest,
  LLMCompletionResponse,
  LLMEmbeddingRequest,
  LLMEmbeddingResponse,
  LLMProviderConfig,
  LLMProvider,
} from '../types';
import {
  LLMError,
  LLMRateLimitError,
  LLMTimeoutError,
  LLMAuthError,
  estimateCost,
} from '../types';

const MISTRAL_API_URL = 'https://api.mistral.ai/v1';

export class MistralClient extends LLMClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(config?: Partial<LLMProviderConfig>) {
    const apiKey =
      config?.apiKey ||
      process.env.MISTRAL_API_KEY ||
      '';

    super({
      provider: 'mistral',
      apiKey,
      baseUrl: config?.baseUrl || MISTRAL_API_URL,
      defaultModel: config?.defaultModel || 'mistral-7b-instruct',
      defaultEmbeddingModel: config?.defaultEmbeddingModel || 'mistral-embed',
      maxRetries: config?.maxRetries || 3,
      timeoutMs: config?.timeoutMs || 30000,
    });

    this.apiKey = apiKey;
    this.baseUrl = config?.baseUrl || MISTRAL_API_URL;
  }

  get provider(): LLMProvider {
    return 'mistral';
  }

  getAvailableModels(): string[] {
    return [
      'mistral-7b-instruct',
      'mistral-small',
      'mistral-medium',
      'mistral-large',
      'mistral-embed',
    ];
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey && this.apiKey.length > 10);
  }

  async complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse> {
    if (!this.isConfigured()) {
      console.warn('[MistralClient] Not configured - returning stub response');
      // STUB: Return mock response when not configured
      return this.stubCompletion(request);
    }

    const model = request.model || this.getDefaultModel();
    const startTime = Date.now();

    const body = {
      model,
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      temperature: request.temperature ?? 0.7,
      max_tokens: request.maxTokens ?? 1024,
      top_p: request.topP,
      stream: false,
    };

    return this.withRetry(async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        this.config.timeoutMs || 30000
      );

      try {
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          await this.handleErrorResponse(response);
        }

        const data = await response.json();
        const latencyMs = Date.now() - startTime;

        const usage = {
          promptTokens: data.usage?.prompt_tokens || 0,
          completionTokens: data.usage?.completion_tokens || 0,
          totalTokens: data.usage?.total_tokens || 0,
        };

        const cost = estimateCost(model, usage.promptTokens, usage.completionTokens);

        console.log(
          `[Mistral] Completed ${model}: ${usage.totalTokens} tokens, ${latencyMs}ms, $${cost.totalCost.toFixed(6)}`
        );

        return {
          content: data.choices?.[0]?.message?.content || '',
          model: data.model || model,
          usage,
          finishReason: data.choices?.[0]?.finish_reason || 'stop',
          latencyMs,
        };
      } catch (err: any) {
        clearTimeout(timeoutId);

        if (err.name === 'AbortError') {
          throw new LLMTimeoutError('mistral');
        }
        throw err;
      }
    });
  }

  async embed(request: LLMEmbeddingRequest): Promise<LLMEmbeddingResponse> {
    if (!this.isConfigured()) {
      console.warn('[MistralClient] Not configured - returning stub embeddings');
      // STUB: Return mock embeddings when not configured
      return this.stubEmbedding(request);
    }

    const model = request.model || this.getDefaultEmbeddingModel();
    const inputs = Array.isArray(request.input) ? request.input : [request.input];

    const body = {
      model,
      input: inputs,
    };

    return this.withRetry(async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        this.config.timeoutMs || 30000
      );

      try {
        const response = await fetch(`${this.baseUrl}/embeddings`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          await this.handleErrorResponse(response);
        }

        const data = await response.json();

        const embeddings = data.data
          .sort((a: any, b: any) => a.index - b.index)
          .map((item: any) => item.embedding);

        console.log(`[Mistral] Embedded ${inputs.length} text(s) with ${model}`);

        return {
          embeddings,
          model: data.model || model,
          usage: {
            promptTokens: data.usage?.prompt_tokens || 0,
            totalTokens: data.usage?.total_tokens || 0,
          },
        };
      } catch (err: any) {
        clearTimeout(timeoutId);

        if (err.name === 'AbortError') {
          throw new LLMTimeoutError('mistral');
        }
        throw err;
      }
    });
  }

  // ============================================
  // STUB METHODS (When not configured)
  // ============================================

  private stubCompletion(request: LLMCompletionRequest): LLMCompletionResponse {
    const model = request.model || this.getDefaultModel();

    // Generate a simple stub response
    const lastUserMessage = request.messages
      .filter((m) => m.role === 'user')
      .pop();

    const stubContent = lastUserMessage
      ? `[STUB] Mistral n'est pas configuré. Message reçu: "${lastUserMessage.content.substring(0, 50)}..."`
      : '[STUB] Mistral n\'est pas configuré. Configurez MISTRAL_API_KEY pour activer.';

    return {
      content: stubContent,
      model,
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      },
      finishReason: 'stop',
      latencyMs: 1,
    };
  }

  private stubEmbedding(request: LLMEmbeddingRequest): LLMEmbeddingResponse {
    const model = request.model || this.getDefaultEmbeddingModel();
    const inputs = Array.isArray(request.input) ? request.input : [request.input];

    // Generate random embeddings of dimension 1024 (Mistral embed dimension)
    const embeddings = inputs.map(() => {
      const embedding = new Array(1024).fill(0).map(() => (Math.random() - 0.5) * 2);
      // Normalize
      const norm = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
      return embedding.map((v) => v / norm);
    });

    return {
      embeddings,
      model,
      usage: {
        promptTokens: 0,
        totalTokens: 0,
      },
    };
  }

  private async handleErrorResponse(response: Response): Promise<never> {
    const status = response.status;
    let errorMessage = `Mistral API error: ${status}`;

    try {
      const data = await response.json();
      errorMessage = data.error?.message || data.message || errorMessage;
    } catch {
      // Ignore JSON parse errors
    }

    if (status === 401) {
      throw new LLMAuthError('mistral');
    }

    if (status === 429) {
      const retryAfter = response.headers.get('retry-after');
      throw new LLMRateLimitError(
        'mistral',
        retryAfter ? parseInt(retryAfter, 10) * 1000 : undefined
      );
    }

    if (status >= 500) {
      throw new LLMError(errorMessage, 'mistral', status, true);
    }

    throw new LLMError(errorMessage, 'mistral', status, false);
  }
}

// Singleton instance
let _mistralClient: MistralClient | null = null;

export function getMistralClient(): MistralClient {
  if (!_mistralClient) {
    _mistralClient = new MistralClient();
  }
  return _mistralClient;
}
