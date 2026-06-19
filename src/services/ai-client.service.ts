import OpenAI from 'openai';
import { config } from '../common/config.js';
import logger from '../common/logger.js';
import type {
  AgentChatClient,
  AgentChatCompletion,
  AgentChatMessage,
  AgentToolDefinition,
} from './agent-runner.service.js';

export interface CompleteChatInput {
  model: string;
  messages: AgentChatMessage[];
  tools?: AgentToolDefinition[];
  temperature?: number;
  maxTokens?: number;
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

export class AiClient implements AgentChatClient {
  private readonly openai: OpenAI;
  private readonly retryOptions: AiClientRetryOptions;

  constructor(
    openai?: OpenAI,
    retryOptions: Partial<AiClientRetryOptions> = {},
  ) {
    this.openai =
      openai ??
      new OpenAI({
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: config.openRouter.apiKey,
        defaultHeaders: {
          'HTTP-Referer': 'https://tyulyukov.com',
          'X-Title': 'groknul-bot',
        },
      });
    this.retryOptions = {
      maxAttempts: retryOptions.maxAttempts ?? 3,
      baseDelayMs: retryOptions.baseDelayMs ?? 500,
      maxDelayMs: retryOptions.maxDelayMs ?? 4000,
    };
  }

  async complete(input: CompleteChatInput): Promise<AgentChatCompletion> {
    const startedAt = Date.now();
    const completion = await this.createChatCompletion({
      model: input.model,
      messages: input.messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      tools: input.tools as OpenAI.Chat.Completions.ChatCompletionTool[] | undefined,
      temperature: input.temperature,
      max_completion_tokens: input.maxTokens,
    });
    const message = completion.choices[0]?.message;

    logger.info(
      {
        model: input.model,
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
    const completion = await this.createChatCompletion(params);

    logger.info(
      {
        model: params.model,
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

  private async createChatCompletion(
    params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  ): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.retryOptions.maxAttempts; attempt += 1) {
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
      const status = typeof shape.status === 'number' ? shape.status : undefined;
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
}
