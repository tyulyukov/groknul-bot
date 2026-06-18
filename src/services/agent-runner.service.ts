import {
  parseSendPayload,
  type SendPayload,
} from './telegram-rich-delivery.service.js';

export interface AgentToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface AgentChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: AgentToolCall[];
}

export interface AgentToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface AgentChatCompletion {
  message: {
    role: 'assistant';
    content?: string | null;
    tool_calls?: AgentToolCall[];
  };
  usage?: {
    total_tokens?: number;
  };
}

export interface AgentChatClient {
  complete(input: {
    model: string;
    messages: AgentChatMessage[];
    tools?: AgentToolDefinition[];
    temperature?: number;
    maxTokens?: number;
  }): Promise<AgentChatCompletion>;
}

export interface AgentToolRegistry {
  getToolDefinitions(): AgentToolDefinition[];
  execute(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface AgentRunInput {
  chatTelegramId: number;
  triggerMessageId: number;
  botUsername: string;
  triggerText?: string;
}

export interface AgentRunResult {
  status: 'final' | 'sent' | 'tool_limit_reached' | 'fallback';
  output: SendPayload;
  toolsUsed: string[];
}

export class AgentRunner {
  constructor(
    private readonly client: AgentChatClient,
    private readonly registry: AgentToolRegistry,
    private readonly options: {
      model: string;
      maxToolCalls: number;
    },
  ) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const tools = this.registry.getToolDefinitions();
    const messages: AgentChatMessage[] = [
      {
        role: 'system',
        content: this.getSystemPrompt(input.botUsername),
      },
      {
        role: 'user',
        content: JSON.stringify({
          chatTelegramId: input.chatTelegramId,
          triggerMessageId: input.triggerMessageId,
          currentMessage: input.triggerText ?? '',
        }),
      },
    ];
    const toolsUsed: string[] = [];

    let toolCallsUsed = 0;
    while (toolCallsUsed < this.options.maxToolCalls) {
      const completion = await this.client.complete({
        model: this.options.model,
        messages,
        tools,
        temperature: 0.7,
        maxTokens: 1600,
      });
      const toolCalls = completion.message.tool_calls ?? [];

      if (toolCalls.length === 0) {
        return {
          status: 'final',
          output: this.parseFinalOutput(completion.message.content),
          toolsUsed,
        };
      }

      messages.push({
        role: 'assistant',
        content: completion.message.content ?? '',
        tool_calls: toolCalls,
      });

      for (const toolCall of toolCalls) {
        if (toolCallsUsed >= this.options.maxToolCalls) {
          return this.toolLimitResult(toolsUsed);
        }

        toolCallsUsed += 1;
        const toolName = toolCall.function.name;
        toolsUsed.push(toolName);
        const args = this.parseToolArgs(toolCall.function.arguments);
        const result = await this.registry.execute(toolName, args);

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        });

        if (toolName === 'send' && this.isSuccessfulSendResult(result)) {
          return {
            status: 'sent',
            output: { items: [] },
            toolsUsed,
          };
        }
      }
    }

    return this.toolLimitResult(toolsUsed);
  }

  private parseToolArgs(raw: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(raw || '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  private parseFinalOutput(content: string | null | undefined): SendPayload {
    const text = content?.trim();
    if (!text) {
      return this.safeFallbackOutput();
    }

    try {
      const parsed = JSON.parse(text) as Partial<SendPayload>;
      const sendPayload = parseSendPayload(parsed);
      if (sendPayload) return sendPayload;
    } catch {
      return {
        items: [
          {
            richMarkdown: text,
            plainText: text,
          },
        ],
      };
    }

    return {
      items: [
        {
          richMarkdown: text,
          plainText: text,
        },
      ],
    };
  }

  private isSuccessfulSendResult(result: unknown): boolean {
    if (!result || typeof result !== 'object') return false;
    const value = result as { status?: unknown; deliveries?: unknown };
    return (
      value.status === 'ok' &&
      Array.isArray(value.deliveries) &&
      value.deliveries.length > 0
    );
  }

  private safeFallbackOutput(): SendPayload {
    return {
      items: [
        {
          plainText: 'I hit a formatting issue, so I’m sending this safely.',
        },
      ],
    };
  }

  private toolLimitResult(toolsUsed: string[]): AgentRunResult {
    return {
      status: 'tool_limit_reached',
      output: {
        items: [
          {
            plainText: 'I need a narrower request to continue safely.',
          },
        ],
      },
      toolsUsed,
    };
  }

  private getSystemPrompt(botUsername: string): string {
    return `You are @${botUsername}, a Telegram group-chat agent. Use tools when you need chat history, memories, summaries, web search, or Telegram actions. You have at most ${this.options.maxToolCalls} tool calls.

Default to raw recent messages for immediate vibe and timing. Do not request huge context. If a tool returns too_large, make a narrower follow-up tool call.

When replying without the send tool, return either natural text or JSON shaped like {"items":[{"richMarkdown":"...","plainText":"...","replyToMessageId":123}]}. Do not include metadata prefixes in user-visible text.`;
  }
}
