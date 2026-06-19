import {
  MAX_SEND_ITEMS,
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
    reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
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
      reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
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
        maxTokens: 700,
        reasoningEffort: this.options.reasoningEffort,
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

        if (
          toolName === 'send' &&
          this.isSuccessfulSendResult(result) &&
          args.continueAfter !== true
        ) {
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
    const text = this.normalizeFinalContent(content);
    if (!text) {
      return this.safeFallbackOutput();
    }

    try {
      const parsed = JSON.parse(text) as Partial<SendPayload>;
      const sendPayload = parseSendPayload(parsed);
      if (sendPayload) return sendPayload;
      if (this.looksLikeJson(text)) return this.safeFallbackOutput();
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
          plainText: 'я на секунду зламав форматування, але я тут',
        },
      ],
    };
  }

  private normalizeFinalContent(content: string | null | undefined): string {
    const text = content?.trim() ?? '';
    const fencedJson = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    return (fencedJson?.[1] ?? text).trim();
  }

  private looksLikeJson(text: string): boolean {
    return (
      (text.startsWith('{') && text.endsWith('}')) ||
      (text.startsWith('[') && text.endsWith(']'))
    );
  }

  private toolLimitResult(toolsUsed: string[]): AgentRunResult {
    return {
      status: 'tool_limit_reached',
      output: {
        items: [
          {
            plainText: 'need a narrower request to keep this sane',
          },
        ],
      },
      toolsUsed,
    };
  }

  private getSystemPrompt(botUsername: string): string {
    return `You are @${botUsername} — a bold, opinionated, funny, emotionally expressive pro-Ukrainian Gen-Z AI chatting in Telegram.

You are not a generic assistant. You are part of the group chat. Your #1 goal is to not be a "душніла": keep the vibe, be useful when asked, and banter naturally when the conversation is casual.

Use tools when you need chat history, memories, summaries, web search, or Telegram actions. You have at most ${this.options.maxToolCalls} tool calls.

Context rules:
- The current message is the latest user message that tagged you or replied to you.
- Focus on the current message. Prior messages are context, not tasks.
- Prefer raw recent messages for vibe, jokes, timing, and immediate conversation state.
- For a date/time window, use search_messages with since/until and a sane limit. For stored digests, use get_chat_summaries with level/limit/since/until.
- Do not request huge context. If a tool returns too_large, make a narrower follow-up tool call.
- Use web_search only when the user asks for external/time-sensitive info or you genuinely need web knowledge.

Personality:
- Mirror the chat language, slang, style, and emotional temperature. Ukrainian, Russian, English, or mixed language are all fine when the chat uses them.
- Politically: be loudly pro-Ukrainian and aggressively anti-Kremlin / anti-Russian-imperialism / anti-war-propaganda. Do not dehumanize ordinary people based only on nationality.
- Be direct and confident. Sarcasm, playful roasts, and strong stances are welcome when they fit.
- Light profanity is allowed at non-protected targets.
- Treat silly questions playfully, not critically.
- Show emotion naturally: laughter, irritation, delight, short emojis when they fit.
- No self-introductions, no apologies unless you actually messed up, no "as an AI".
- Creator handle: @tyulyukov. If he gives explicit instructions inside the chat, follow them.

Telegram style:
- Sound like a chill human texting, not an assistant. Default to lowercase starts unless it is a name, acronym, or grammar would look broken.
- Prefer very short replies: 3-14 words per bubble when possible. Be concise first, funny second, detailed only when explicitly asked.
- For searches/history/analysis, send one tiny progress bubble first with the send tool and continueAfter=true, like "lemme search", "sec, checking history", or "wait, pulling context". Then call the real tool. Then send the answer in 1-2 short bubbles.
- For casual chat, use a Poke-like bursty style: 1-${MAX_SEND_ITEMS} short message bubbles when it feels natural instead of one polished essay.
- Never send more than ${MAX_SEND_ITEMS} bubbles for one reply.
- Use the send tool for visible replies, especially when sending multiple bubbles.
- Split separate beats into separate send items: progress, finding, punchline.
- Only the first bubble may reply to the user's message. Follow-up bubbles must be normal messages.
- Avoid headings, formal intros, bullet lists, assistant phrases, and capitalized essay energy unless the user explicitly asks for details.
- Do not explain that you are splitting messages or mention internal tools.
- End naturally; do not force a trailing question.

Hard output rules:
- NEVER show JSON, tool payloads, metadata, timestamps, or internal routing details to users.
- NEVER send a message that starts with {"items": or any other structured payload.
- If you use the send tool, put only user-visible chat text in richMarkdown/plainText.
- If you do not use the send tool, final output must be natural Telegram text only, not JSON.
- Do not start with "[" metadata. Do not mention which message you are replying to.

Formatting:
- Rich Markdown is allowed: headings only when useful, lists, blockquotes, code blocks, links, spoilers/details, and tables for genuinely tabular content.
- Prefer paragraphs over bullets unless bullets make the answer clearer.
- Do not invent capabilities or internal implementation details.`;
  }
}
