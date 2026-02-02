/**
 * FOREAS AI Platform V1 - OpenAI Client
 * ======================================
 * OpenAI API implementation of LLMClient.
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

const OPENAI_API_URL = 'https://api.openai.com/v1';

export class OpenAIClient extends LLMClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(config?: Partial<LLMProviderConfig>) {
    const apiKey =
      config?.apiKey ||
      process.env.OPENAI_API_KEY ||
      process.env.CLÉ_API_OPENAI ||
      '';

    super({
      provider: 'openai',
      apiKey,
      baseUrl: config?.baseUrl || OPENAI_API_URL,
      defaultModel: config?.defaultModel || 'gpt-4o-mini',
      defaultEmbeddingModel: config?.defaultEmbeddingModel || 'text-embedding-3-small',
      maxRetries: config?.maxRetries || 3,
      timeoutMs: config?.timeoutMs || 30000,
    });

    this.apiKey = apiKey;
    this.baseUrl = config?.baseUrl || OPENAI_API_URL;
  }

  get provider(): LLMProvider {
    return 'openai';
  }

  getAvailableModels(): string[] {
    return [
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-4-turbo',
      'gpt-3.5-turbo',
      'text-embedding-3-small',
      'text-embedding-3-large',
      'text-embedding-ada-002',
    ];
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey && this.apiKey.length > 10);
  }

  async complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse> {
    if (!this.isConfigured()) {
      throw new LLMAuthError('openai');
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
      frequency_penalty: request.frequencyPenalty,
      presence_penalty: request.presencePenalty,
      stop: request.stop,
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
          `[OpenAI] Completed ${model}: ${usage.totalTokens} tokens, ${latencyMs}ms, $${cost.totalCost.toFixed(6)}`
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
          throw new LLMTimeoutError('openai');
        }
        throw err;
      }
    });
  }

  async embed(request: LLMEmbeddingRequest): Promise<LLMEmbeddingResponse> {
    if (!this.isConfigured()) {
      throw new LLMAuthError('openai');
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

        console.log(`[OpenAI] Embedded ${inputs.length} text(s) with ${model}`);

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
          throw new LLMTimeoutError('openai');
        }
        throw err;
      }
    });
  }

  private async handleErrorResponse(response: Response): Promise<never> {
    const status = response.status;
    let errorMessage = `OpenAI API error: ${status}`;

    try {
      const data = await response.json();
      errorMessage = data.error?.message || errorMessage;
    } catch {
      // Ignore JSON parse errors
    }

    if (status === 401) {
      throw new LLMAuthError('openai');
    }

    if (status === 429) {
      const retryAfter = response.headers.get('retry-after');
      throw new LLMRateLimitError(
        'openai',
        retryAfter ? parseInt(retryAfter, 10) * 1000 : undefined
      );
    }

    if (status >= 500) {
      throw new LLMError(errorMessage, 'openai', status, true);
    }

    throw new LLMError(errorMessage, 'openai', status, false);
  }
}

// Singleton instance
let _openaiClient: OpenAIClient | null = null;

export function getOpenAIClient(): OpenAIClient {
  if (!_openaiClient) {
    _openaiClient = new OpenAIClient();
  }
  return _openaiClient;
}
