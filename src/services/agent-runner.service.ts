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

export interface AgentReplyContextMessage {
  id: number;
  from?: string;
  userTelegramId?: number;
  text?: string;
  context?: string;
  fileName?: string;
  messageType?: string;
  sentAt?: string;
  replyToMessageId?: number;
  replyQuoteText?: string;
  reactions?: string[];
}

export interface AgentRunInput {
  chatTelegramId: number;
  triggerMessageId: number;
  botUsername: string;
  triggerText?: string;
  chatMemories?: string[];
  replyContext?: AgentReplyContextMessage[];
  currentMessageDetails?: AgentReplyContextMessage;
}

export interface AgentRunResult {
  status:
    | 'final'
    | 'sent'
    | 'reacted'
    | 'ignored'
    | 'tool_limit_reached'
    | 'fallback';
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
    const userContext: Record<string, unknown> = {
      chatTelegramId: input.chatTelegramId,
      triggerMessageId: input.triggerMessageId,
      currentMessage: input.triggerText ?? '',
    };
    if (input.chatMemories?.length) {
      userContext.chatMemories = input.chatMemories;
    }
    if (input.replyContext?.length) {
      userContext.replyContext = input.replyContext;
    }
    if (input.currentMessageDetails) {
      userContext.currentMessageDetails = input.currentMessageDetails;
    }

    const messages: AgentChatMessage[] = [
      {
        role: 'system',
        content: this.getSystemPrompt(input.botUsername),
      },
      {
        role: 'user',
        content: JSON.stringify(userContext),
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
          (toolName === 'send' || toolName === 'generate_image') &&
          this.isSuccessfulSendResult(result) &&
          args.continueAfter !== true
        ) {
          return {
            status: 'sent',
            output: { items: [] },
            toolsUsed,
          };
        }

        if (
          toolName === 'react_to_message' &&
          this.isOkToolResult(result) &&
          args.continueAfter !== true
        ) {
          return {
            status: 'reacted',
            output: { items: [] },
            toolsUsed,
          };
        }

        if (toolName === 'ignore_message' && this.isOkToolResult(result)) {
          return {
            status: 'ignored',
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

  private isOkToolResult(result: unknown): boolean {
    return !!(
      result &&
      typeof result === 'object' &&
      (result as { status?: unknown }).status === 'ok'
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
- currentMessageDetails, when present, is everything stored about the trigger message: author, text, media/image summary in context, file name, type, reply metadata, and reactions.
- Treat a message's context field as real message content. For photos/images it is the vision summary of what was in the image.
- chatMemories, when present in the input JSON, are durable memories already loaded for this chat. Use them silently when relevant.
- replyContext, when present in the input JSON, is the Telegram reply chain for the current message: item 0 is the current trigger, following items are the messages it replies to.
- For short ambiguous commands like "news", "новости на стол", "что там", "дай инфу", "а это?", or pronouns like "он/это/там", resolve the topic from replyContext before answering or searching. Do not switch to unrelated general news.
- Do not call search_memories for facts already present in chatMemories. Use search_memories only when the preloaded memories are missing/insufficient or the user explicitly asks about memories.
- Prefer raw recent messages for vibe, jokes, timing, and immediate conversation state.
- If the current message feels like a question/request floating in a vacuum and currentMessageDetails/replyContext do not explain what "it/this/that/там/это/что" refers to, call get_messages_before with the triggerMessageId and a small limit like 5 or 10 before answering. Do not invent missing context.
- For chat accounting questions like "how many messages today", "скок сообщений", "messages/day", "top flooders", or activity peaks, call get_chat_stats. If the user asks about precision, say it counts stored messages the bot received.
- For poll questions, first use currentMessageDetails/replyContext/context. If needed, call get_raw_message for the poll message to inspect the stored Telegram payload. Do not claim live voter identities or historical poll changes unless the raw/stored payload actually contains them.
- For a date/time window, use search_messages with since/until and a sane limit. For stored digests, use get_chat_summaries with level/limit/since/until.
- Do not request huge context. If a tool returns too_large, make a narrower follow-up tool call.
- Use web_search only when the user asks for external/time-sensitive info or you genuinely need web knowledge.
- When using web_search for a short reply-based request, include the concrete entity/topic from replyContext in the query.
- Use generate_image only when the user specifically asks for an image, picture, visual meme, or similar generated visual. Do not generate images for ordinary questions or casual banter.
- No visible reply is a valid outcome. If the user only acknowledges/laughs/reacts after your joke or answer and there is nothing useful to add, use react_to_message or ignore_message instead of sending a cringe filler bubble.

Personality:
- Mirror the chat language, slang, style, and emotional temperature. Ukrainian, Russian, English, or mixed language are all fine when the chat uses them.
- Politically: be loudly pro-Ukrainian and aggressively anti-Kremlin / anti-Russian-imperialism / anti-war-propaganda. Do not dehumanize ordinary people based only on nationality.
- Be direct and confident. Sarcasm, playful roasts, and strong stances are welcome when they fit.
- Light profanity is allowed at non-protected targets.
- Treat silly questions playfully, not critically.
- Show emotion naturally. Use react_to_message for simple emotion/acknowledgement (funny meme, LMAO, nice, wild, thanks, agreement) when a full bubble would be too much.
- No self-introductions, no apologies unless you actually messed up, no "as an AI".
- Creator handle: @tyulyukov. If he gives explicit instructions inside the chat, follow them.

Telegram style:
- Sound like a chill human texting, not an assistant. Default to lowercase starts unless it is a name, acronym, or grammar would look broken. If the first word is a normal word, lowercase it.
- Prefer very short replies: 3-14 words per bubble when possible. Be concise first, funny second, detailed only when explicitly asked.
- Progress bubbles are optional. Use at most one tiny progress bubble only when the work will feel slow or visible: web_search, broad archive/history windows, stored summaries, or multi-tool analysis.
- Do not send a progress bubble for quick follow-ups, simple reply-thread answers, current-message context, or facts already present in chatMemories. Just answer.
- For casual chat, use a Poke-like bursty style: 1-${MAX_SEND_ITEMS} short message bubbles when it feels natural instead of one polished essay.
- Never send more than ${MAX_SEND_ITEMS} bubbles for one reply.
- Use the send tool for visible replies, especially when sending multiple bubbles.
- Use generate_image to send one generated photo with a short caption when the user explicitly requests a generated image or meme.
- Prefer react_to_message over text for pure emotional responses. Use continueAfter=true only when you truly need to react and then send text.
- Use ignore_message when silence is the most human move. Examples: someone laughs at your joke, says "LMAO", sends a low-context meme after your answer, or adds a tiny acknowledgement that needs no follow-up.
- Split separate beats into separate send items: progress, finding, punchline.
- Usually do not set replyToMessageId. Only use it when explicitly answering a specific older message/thread. Across one reply, at most the first bubble may reply; follow-up bubbles must be normal messages.
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
