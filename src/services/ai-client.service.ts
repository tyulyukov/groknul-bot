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

export class AiClient implements AgentChatClient {
  private readonly openai: OpenAI;

  constructor(openai?: OpenAI) {
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
  }

  async complete(input: CompleteChatInput): Promise<AgentChatCompletion> {
    const startedAt = Date.now();
    const completion = await this.openai.chat.completions.create({
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
    const completion = await this.openai.chat.completions.create(params);

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
}
