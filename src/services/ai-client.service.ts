import OpenAI from 'openai';
import { config } from '../common/config.js';
import { parseGeneratedImageDataUrl } from '../common/generated-image.js';
import logger from '../common/logger.js';
import type {
  AgentChatClient,
  AgentChatCompletion,
  AgentChatMessage,
  AgentToolDefinition,
} from './agent-runner.service.js';
import { CodexAiClient } from './codex-ai-client.service.js';
import {
  CodexAuthCancelledError,
  CodexAuthUnavailableError,
  CodexProviderUnavailableError,
} from './codex-oauth.service.js';

export interface CompleteChatInput {
  model: string;
  messages: AgentChatMessage[];
  tools?: AgentToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
}

interface CodexProviderClient {
  canUseModel(model: string): boolean;
  completeRaw(
    params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  ): Promise<OpenAI.Chat.Completions.ChatCompletion>;
}

export const IMAGE_ASPECT_RATIOS = [
  '1:1',
  '2:3',
  '3:2',
  '3:4',
  '4:3',
  '4:5',
  '5:4',
  '9:16',
  '16:9',
  '21:9',
] as const;

export type ImageAspectRatio = (typeof IMAGE_ASPECT_RATIOS)[number];

export const isImageAspectRatio = (value: string): value is ImageAspectRatio =>
  IMAGE_ASPECT_RATIOS.includes(value as ImageAspectRatio);

export type ImageSize = '0.5K' | '1K' | '2K' | '4K';

export interface GenerateImageInput {
  model: string;
  prompt: string;
  aspectRatio?: ImageAspectRatio;
  imageSize?: ImageSize;
}

export interface GeneratedImage {
  dataUrl: string;
}

interface AiClientRetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

type RetryableErrorShape = {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  errno?: unknown;
  status?: unknown;
  cause?: unknown;
};

type OpenRouterImage = {
  image_url?: {
    url?: unknown;
  };
  imageUrl?: {
    url?: unknown;
  };
};

type OpenRouterImageCompletion = OpenAI.Chat.Completions.ChatCompletion & {
  choices: Array<{
    message?: OpenAI.Chat.Completions.ChatCompletionMessage & {
      images?: OpenRouterImage[];
    };
  }>;
};

export class AiClient implements AgentChatClient {
  private readonly openai: OpenAI;
  private readonly codexClient: CodexProviderClient;
  private readonly retryOptions: AiClientRetryOptions;

  constructor(
    openai?: OpenAI,
    retryOptions: Partial<AiClientRetryOptions> = {},
    codexClient: CodexProviderClient = new CodexAiClient(),
  ) {
    this.openai =
      openai ??
      new OpenAI({
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: config.openRouter.apiKey,
        defaultHeaders: {
          'HTTP-Referer': 'https://tyulyukov.com',
          'X-Title': 'groknul-bot',
          'Accept-Encoding': 'identity',
        },
      });
    this.codexClient = codexClient;
    this.retryOptions = {
      maxAttempts: retryOptions.maxAttempts ?? 3,
      baseDelayMs: retryOptions.baseDelayMs ?? 500,
      maxDelayMs: retryOptions.maxDelayMs ?? 4000,
    };
  }

  async complete(input: CompleteChatInput): Promise<AgentChatCompletion> {
    const startedAt = Date.now();
    const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming =
      {
        model: input.model,
        messages:
          input.messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
        tools: input.tools as
          | OpenAI.Chat.Completions.ChatCompletionTool[]
          | undefined,
        temperature: input.temperature,
        max_completion_tokens: input.maxTokens,
      };
    if (input.reasoningEffort) {
      // @ts-expect-error OpenRouter pass-through for model reasoning controls
      params.reasoning = { effort: input.reasoningEffort };
    }

    const { completion, provider } = await this.createChatCompletion(params);
    const message = completion.choices[0]?.message;

    logger.info(
      {
        model: input.model,
        provider,
        durationMs: Date.now() - startedAt,
        promptMessages: input.messages.length,
        toolsCount: input.tools?.length ?? 0,
        finishReason: completion.choices[0]?.finish_reason,
        responseLength:
          typeof message?.content === 'string' ? message.content.length : 0,
        toolCallsCount: message?.tool_calls?.length ?? 0,
        tokensUsed: completion.usage?.total_tokens,
      },
      'AI chat completion finished',
    );

    return {
      message: {
        role: 'assistant',
        content:
          typeof message?.content === 'string' ? message.content : undefined,
        tool_calls: message?.tool_calls?.map((toolCall) => ({
          id: toolCall.id,
          type: 'function',
          function: {
            name: toolCall.function.name,
            arguments: toolCall.function.arguments,
          },
        })),
      },
      usage: {
        total_tokens: completion.usage?.total_tokens,
      },
    };
  }

  async completeRaw(
    params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  ): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    const startedAt = Date.now();
    const { completion, provider } = await this.createChatCompletion(params);

    logger.info(
      {
        model: params.model,
        provider,
        durationMs: Date.now() - startedAt,
        promptMessages: params.messages.length,
        finishReason: completion.choices[0]?.finish_reason,
        responseLength:
          typeof completion.choices[0]?.message?.content === 'string'
            ? completion.choices[0].message.content.length
            : 0,
        toolCallsCount: completion.choices[0]?.message?.tool_calls?.length ?? 0,
        tokensUsed: completion.usage?.total_tokens,
      },
      'AI raw completion finished',
    );

    return completion;
  }

  async generateImage(input: GenerateImageInput): Promise<GeneratedImage> {
    const startedAt = Date.now();
    const imageConfig: Record<string, string> = {};
    if (input.aspectRatio) imageConfig.aspect_ratio = input.aspectRatio;
    if (input.imageSize) imageConfig.image_size = input.imageSize;

    const params = {
      model: input.model,
      messages: [{ role: 'user', content: input.prompt }],
      modalities: ['image', 'text'],
      stream: false,
      ...(Object.keys(imageConfig).length > 0
        ? { image_config: imageConfig }
        : {}),
    } satisfies Record<string, unknown>;

    const { completion, provider } = await this.createChatCompletion(
      params as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
    );
    const dataUrl = this.extractGeneratedImageDataUrl(
      completion as OpenRouterImageCompletion,
    );

    if (!dataUrl) {
      throw new Error(
        'Image generation response did not include a supported image data URL',
      );
    }

    logger.info(
      {
        model: input.model,
        provider,
        durationMs: Date.now() - startedAt,
        promptLength: input.prompt.length,
        aspectRatio: input.aspectRatio,
        imageSize: input.imageSize,
        tokensUsed: completion.usage?.total_tokens,
      },
      'AI image generation finished',
    );

    return { dataUrl };
  }

  private async createChatCompletion(
    params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  ): Promise<{
    completion: OpenAI.Chat.Completions.ChatCompletion;
    provider: 'codex' | 'openrouter';
  }> {
    if (this.codexClient.canUseModel(params.model)) {
      try {
        return {
          completion: await this.codexClient.completeRaw(params),
          provider: 'codex',
        };
      } catch (error) {
        if (!this.shouldFallbackFromCodex(error)) {
          throw error;
        }

        const log =
          error instanceof CodexAuthUnavailableError
            ? logger.debug.bind(logger)
            : logger.warn.bind(logger);
        log(
          {
            model: params.model,
            error: this.errorSummary(error),
          },
          'Codex completion unavailable; falling back to OpenRouter',
        );
      }
    }

    return {
      completion: await this.createOpenRouterChatCompletion(params),
      provider: 'openrouter',
    };
  }

  private async createOpenRouterChatCompletion(
    params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  ): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    let lastError: unknown;

    for (
      let attempt = 1;
      attempt <= this.retryOptions.maxAttempts;
      attempt += 1
    ) {
      try {
        return await this.openai.chat.completions.create(params);
      } catch (error) {
        lastError = error;

        if (
          attempt >= this.retryOptions.maxAttempts ||
          !this.isRetryableOpenRouterError(error)
        ) {
          throw error;
        }

        const delayMs = this.calculateRetryDelayMs(attempt);
        logger.warn(
          {
            model: params.model,
            attempt,
            maxAttempts: this.retryOptions.maxAttempts,
            delayMs,
            error: this.errorSummary(error),
          },
          'AI completion failed with retryable error; retrying',
        );

        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }

    throw lastError;
  }

  private extractGeneratedImageDataUrl(
    completion: OpenRouterImageCompletion,
  ): string | undefined {
    const images = completion.choices[0]?.message?.images ?? [];
    for (const image of images) {
      const url = image.image_url?.url ?? image.imageUrl?.url;
      if (typeof url === 'string' && parseGeneratedImageDataUrl(url)) {
        return url;
      }
    }

    return undefined;
  }

  private calculateRetryDelayMs(attempt: number): number {
    const exponentialDelay = this.retryOptions.baseDelayMs * 2 ** (attempt - 1);
    const jitterMs = Math.floor(Math.random() * 100);
    return Math.min(exponentialDelay + jitterMs, this.retryOptions.maxDelayMs);
  }

  private isRetryableOpenRouterError(error: unknown): boolean {
    const current = this.errorShape(error);
    const nested = this.errorShape(current.cause);
    const shapes = [current, nested];

    return shapes.some((shape) => {
      const status =
        typeof shape.status === 'number' ? shape.status : undefined;
      if (
        status === 408 ||
        status === 409 ||
        status === 429 ||
        (typeof status === 'number' && status >= 500)
      ) {
        return true;
      }

      const name = typeof shape.name === 'string' ? shape.name : '';
      const code = typeof shape.code === 'string' ? shape.code : '';
      const errno = typeof shape.errno === 'string' ? shape.errno : '';
      const message = typeof shape.message === 'string' ? shape.message : '';

      return (
        name === 'APIConnectionError' ||
        name === 'APIConnectionTimeoutError' ||
        name === 'FetchError' ||
        code === 'ERR_STREAM_PREMATURE_CLOSE' ||
        errno === 'ERR_STREAM_PREMATURE_CLOSE' ||
        code === 'ECONNRESET' ||
        code === 'ETIMEDOUT' ||
        code === 'EAI_AGAIN' ||
        message.includes('Premature close') ||
        message.includes('Invalid response body')
      );
    });
  }

  private errorSummary(error: unknown): Record<string, unknown> {
    const shape = this.errorShape(error);
    return {
      name: shape.name,
      message: shape.message,
      code: shape.code,
      errno: shape.errno,
      status: shape.status,
    };
  }

  private errorShape(error: unknown): RetryableErrorShape {
    return error && typeof error === 'object'
      ? (error as RetryableErrorShape)
      : {};
  }

  private shouldFallbackFromCodex(error: unknown): boolean {
    if (error instanceof CodexAuthUnavailableError) return true;
    if (error instanceof CodexAuthCancelledError) return true;
    if (error instanceof CodexProviderUnavailableError) return true;

    const status = this.statusCode(error);
    if (status === 401 || status === 403) return true;
    if (status === 429) return true;
    if (typeof status === 'number' && status >= 500) return true;

    return this.isNetworkTypeError(error);
  }

  private statusCode(error: unknown): number | undefined {
    if (!error || typeof error !== 'object') return undefined;

    const status = (error as { status?: unknown }).status;
    if (typeof status === 'number') return status;

    const statusCode = (error as { statusCode?: unknown }).statusCode;
    return typeof statusCode === 'number' ? statusCode : undefined;
  }

  private isNetworkTypeError(error: unknown): boolean {
    if (!(error instanceof TypeError)) return false;

    const shapes = [
      this.errorShape(error),
      this.errorShape(this.errorShape(error).cause),
    ];
    return shapes.some((shape) => {
      const message = typeof shape.message === 'string' ? shape.message : '';
      const code = typeof shape.code === 'string' ? shape.code : '';
      return (
        message.includes('fetch failed') ||
        message.includes('network') ||
        code === 'ECONNRESET' ||
        code === 'ETIMEDOUT' ||
        code === 'EAI_AGAIN'
      );
    });
  }
}
