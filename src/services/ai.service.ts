import OpenAI from 'openai';
import { config } from '../common/config.js';
import logger from '../common/logger.js';
import {
  PopulatedMessage,
  PopulatedMessageReaction,
} from '../database/models/Message.js';
import { TelegramUser } from '../database/models/TelegramUser.js';
import { getStartMessage } from './telegram-bot.service.js';
import { database } from '../database/index.js';
import { Memory } from '../database/models/Memory.js';
import { Summary } from '../database/models/Summary.js';

// Public types for AI results and tool usage
export interface AiResponseResult {
  text: string;
  toolsUsed: string[];
}

export class AiService {
  private openai: OpenAI;

  constructor() {
    this.openai = new OpenAI({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: config.openRouter.apiKey,
      defaultHeaders: {
        'HTTP-Referer': 'https://tyulyukov.com',
        'X-Title': 'groknul-bot',
      },
    });
  }

  async summarizeText(blocks: string[], instruction: string): Promise<string> {
    const content = blocks.join('\n\n');
    logger.info(
      {
        blocksCount: blocks.length,
        instructionPreview: instruction.slice(0, 120),
        contentPreview: content.slice(0, 200),
      },
      'Starting text summarization',
    );

    const startedAt = Date.now();
    const completion = await this.openai.chat.completions.create({
      model: 'openai/gpt-5-mini',
      // @ts-expect-error OpenRouter pass-through for disabling reasoning
      reasoning: { effort: 'low' },
      messages: [
        {
          role: 'system',
          content:
            'You are a professional summarizer. Summarize inputs into concise, neutral, information-dense notes. Keep key facts, actors, decisions, questions, answers, tasks, and resolutions. Remove chit-chat and filler. Prefer paragraphs over bullets unless events are disjoint. Preserve chronology labels provided.',
        },
        { role: 'user', content: `${instruction}\n\n${content}` },
      ],
      temperature: 0.2,
      max_completion_tokens: 800,
      top_p: 0.9,
    });
    const durationMs = Date.now() - startedAt;
    const summary = completion.choices[0]?.message?.content?.trim() || '';
    logger.info(
      {
        completion,
        durationMs,
        tokensUsed: completion.usage?.total_tokens,
        summaryLength: summary.length,
        summaryPreview: summary.slice(0, 200),
      },
      'Text summarization completed',
    );
    return summary;
  }

  async analyzeImage(imageBase64DataUrl: string): Promise<string> {
    try {
      logger.info(
        { contentTypePrefix: imageBase64DataUrl.slice(0, 30) },
        'Starting image summarization',
      );
      const completion = await this.openai.chat.completions.create({
        model: 'openai/gpt-5-mini',
        // @ts-expect-error OpenRouter pass-through for disabling reasoning
        reasoning: { effort: 'low' },
        messages: [
          {
            role: 'system',
            content:
              'Provide a full, detailed description of the image. Describe the overall scene, key objects, their attributes (size, color, shape, texture), spatial relationships, actions, and interactions. Include environment, layout/composition, lighting, mood, style, logos/brands, UI elements, and any relevant context for a chat conversation. Transcribe all clearly visible text verbatim; if some text is small or partially visible, note that and transcribe what is legible. Be precise and avoid speculation; when uncertain, state that you are unsure. Write in clear paragraphs and do not summarize.',
          },
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: imageBase64DataUrl } },
            ],
          },
        ],
        temperature: 0.2,
        max_completion_tokens: 1500,
        top_p: 0.9,
      });

      const summary = completion.choices[0]?.message?.content?.trim();
      logger.info(
        {
          completion,
          summary,
          summaryLength: summary?.length || 0,
          tokensUsed: completion.usage?.total_tokens,
        },
        'Image summarization completed',
      );
      return summary || '';
    } catch (error) {
      logger.error(error, 'Image analysis failed');
      return '';
    }
  }

  async generateResponse(
    messages: PopulatedMessage[],
    triggerMessage: PopulatedMessage,
    botUsername: string,
    memories?: Memory[],
    summaries?: Summary[],
  ): Promise<AiResponseResult> {
    try {
      // 1) Fast router: Kimi K2 decides what to do based on the trigger + up to 50 previous messages
      const routerInputMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
        [
          { role: 'system', content: this.getRouterSystemPrompt() },
          ...this.buildContext(messages.slice(0, 51), botUsername),
        ];

      const routerTools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
        {
          type: 'function',
          function: {
            name: 'save_to_memory',
            description:
              'Persist a concise fact or preference into long-lived chat memory only when the CURRENT user explicitly asks to remember/save/memorize something. Use ONLY for the CURRENT message, not historical ones.',
            parameters: {
              type: 'object',
              properties: {
                text: {
                  type: 'string',
                  description:
                    'The exact text to remember. Keep it short and declarative.',
                },
              },
              required: ['text'],
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'generate_response',
            description:
              'Choose how to generate a reply. Set provideAllChatHistory=true when the user asks to analyze/summarize the conversation, track long-running debates, or needs long-range memory across many topics. Set it=false when the reply should focus on the recent exchange. Set enableWebAccess=true when the user requests external, time-sensitive, or unknown info beyond local chat context; otherwise false for speed.',
            parameters: {
              type: 'object',
              properties: {
                provideAllChatHistory: {
                  type: 'boolean',
                  description:
                    'If true, use full historical summaries. If false, use only the recent window (~200 messages).',
                },
                enableWebAccess: {
                  type: 'boolean',
                  description:
                    'If true, enable web access for retrieving external or time-sensitive information.',
                },
              },
              required: ['provideAllChatHistory', 'enableWebAccess'],
            },
          },
        },
      ];

      const routerPromptPreview =
        this.shrinkMessagesForLog(routerInputMessages);
      logger.info(
        {
          chatId: triggerMessage.chatTelegramId,
          messageId: triggerMessage.telegramId,
          prompt: routerPromptPreview,
        },
        'Router decision (Kimi K2) — starting',
      );

      const routerCompletion = await this.openai.chat.completions.create({
        model: 'moonshotai/kimi-k2',
        // @ts-expect-error OpenRouter provider routing
        provider: { order: ['groq'] },
        messages: routerInputMessages,
        tools: routerTools,
        temperature: 0.2,
        max_completion_tokens: 400,
      });

      const routerChoice = routerCompletion.choices[0]?.message;
      const routerToolCalls = routerChoice?.tool_calls || [];

      logger.info(
        {
          routerCompletion,
          toolCallsCount: routerToolCalls.length,
        },
        'Router decision (Kimi K2) — completed',
      );

      // Default decision if router did not call any tool
      let decision: 'save_to_memory' | 'generate_response' =
        'generate_response';
      let decisionArgs: {
        text?: string;
        provideAllChatHistory?: boolean;
        enableWebAccess?: boolean;
      } = {
        provideAllChatHistory: false,
        enableWebAccess: false,
      };

      if (routerToolCalls.length > 0) {
        const call = routerToolCalls[0]!;
        const toolName = call.function?.name || '';
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function?.arguments || '{}');
        } catch {
          args = {};
        }
        if (toolName === 'save_to_memory') {
          decision = 'save_to_memory';
          decisionArgs = { text: String(args.text || '').trim() };
        } else if (toolName === 'generate_response') {
          decision = 'generate_response';
          decisionArgs = {
            provideAllChatHistory: Boolean(args.provideAllChatHistory),
            enableWebAccess: Boolean(args.enableWebAccess),
          };
        }
      }

      // 2) Execute decision
      if (decision === 'save_to_memory') {
        const textToRemember = (decisionArgs.text || '').trim();
        const toolsUsed: string[] = [];

        let toolExecutionSummary = 'save_to_memory not executed (empty text)';
        if (textToRemember.length > 0) {
          try {
            const memoryModel = database.getMemoryModel();
            await memoryModel.addMemory({
              chatTelegramId: triggerMessage.chatTelegramId,
              addedByUserTelegramId: triggerMessage.userTelegramId,
              text: textToRemember,
              sourceMessageTelegramId: triggerMessage.telegramId,
            });
            toolsUsed.push('save_to_memory');
            toolExecutionSummary = `save_to_memory executed successfully with text: ${textToRemember}`;
          } catch (error) {
            logger.error(error, 'Failed to save memory');
            toolExecutionSummary = `save_to_memory failed: ${String(error)}`;
          }
        }

        // Generate final reply with gpt-5-chat. Include the literal assistant tool call and tool result in the context.
        const modelParams = {
          model: 'openai/gpt-5-chat',
          max_completion_tokens: 2000,
          temperature: 1.0,
          presence_penalty: 0.6,
          frequency_penalty: 0.8,
        };

        // Use recent window by default for this acknowledgement flow
        const recentWindow = messages.slice(0, 200);
        const baseChatMessages = this.buildContext(
          recentWindow,
          botUsername,
          memories,
        );

        const toolCallId = `call_${Date.now()}`;
        const assistantToolCallMsg: OpenAI.Chat.Completions.ChatCompletionMessageParam =
          {
            role: 'assistant',
            tool_calls: [
              {
                id: toolCallId,
                type: 'function',
                function: {
                  name: 'save_to_memory',
                  arguments: JSON.stringify({ text: textToRemember }),
                },
              },
            ],
          } as any;

        const toolResultMsg: OpenAI.Chat.Completions.ChatCompletionMessageParam =
          {
            role: 'tool',
            tool_call_id: toolCallId,
            content: JSON.stringify(
              textToRemember.length > 0 && toolsUsed.includes('save_to_memory')
                ? { status: 'success', text: textToRemember }
                : { status: 'error', error: toolExecutionSummary },
            ),
          } as any;

        const finalMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
          [
            { role: 'system', content: this.getSystemPrompt(botUsername) },
            ...baseChatMessages,
            assistantToolCallMsg,
            toolResultMsg,
            {
              role: 'system',
              content: 'REMEMBER - NO METADATA IN YOUR RESPONSE.',
            },
          ];

        const followupPreview = this.shrinkMessagesForLog(finalMessages);
        logger.info(
          {
            chatId: triggerMessage.chatTelegramId,
            messageId: triggerMessage.telegramId,
            prompt: followupPreview,
            toolsUsed,
          },
          'Generating AI response (after save_to_memory via router)',
        );

        const finalCompletion = await this.openai.chat.completions.create({
          ...modelParams,
          messages: finalMessages,
        });

        const reply = finalCompletion.choices[0]?.message?.content?.trim();
        if (!reply) {
          throw new Error(
            'Empty response from AI service (after save_to_memory)',
          );
        }

        logger.info(
          {
            finalCompletion,
            responseLength: reply.length,
            tokensUsed: finalCompletion.usage?.total_tokens,
          },
          'AI response generated successfully (after save_to_memory)',
        );

        return { text: reply, toolsUsed };
      }

      // decision === 'generate_response'
      const provideAllChatHistory = Boolean(decisionArgs.provideAllChatHistory);
      const enableWebAccess = Boolean(decisionArgs.enableWebAccess);

      // Prepare context based on decision
      const modelParams: Omit<
        OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
        'messages'
      > = {
        model: 'openai/gpt-5-chat',
        max_completion_tokens: 2000,
        temperature: 1.2,
        presence_penalty: 0.6,
        frequency_penalty: 0.8,
      };

      if (enableWebAccess) {
        // @ts-expect-error OpenRouter web plugin passthrough
        modelParams.plugins = [{ id: 'web' }];
      }

      const contextMessages = this.buildContext(
        provideAllChatHistory ? messages : messages.slice(0, 200),
        botUsername,
        memories,
        provideAllChatHistory ? summaries : undefined,
      );

      const baseMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
        [
          { role: 'system', content: this.getSystemPrompt(botUsername) },
          ...contextMessages,
          {
            role: 'system',
            content: `REMEMBER - NO METADATA IN YOUR RESPONSE.`,
          },
        ];

      const genPreview = this.shrinkMessagesForLog(baseMessages);
      logger.info(
        {
          chatId: triggerMessage.chatTelegramId,
          messageId: triggerMessage.telegramId,
          provideAllChatHistory,
          enableWebAccess,
          prompt: genPreview,
        },
        'Generating AI response (router: generate_response)',
      );

      const completion = await this.openai.chat.completions.create({
        ...modelParams,
        messages: baseMessages,
      });

      const replyText = completion.choices[0]?.message?.content?.trim();
      if (!replyText) {
        throw new Error('Empty response from AI service');
      }

      logger.info(
        {
          completion,
          chatId: triggerMessage.chatTelegramId,
          responseLength: replyText.length,
          tokensUsed: completion.usage?.total_tokens,
        },
        'AI response generated successfully',
      );

      return { text: replyText, toolsUsed: [] };
    } catch (error) {
      logger.error(error, 'Failed to generate AI response');
      throw new Error(
        'Failed to generate AI response. Please try again later.',
      );
    }
  }

  async generateAmbientInterjection(
    messages: PopulatedMessage[],
    botUsername: string,
  ): Promise<string | null> {
    try {
      logger.info(
        {
          messagesCount: messages.length,
          firstAt: messages[messages.length - 1]?.sentAt,
          lastAt: messages[0]?.sentAt,
          model: 'openai/gpt-5-chat',
        },
        'Ambient: starting interjection generation',
      );
      const modelParams: Omit<
        OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
        'messages'
      > = {
        model: 'openai/gpt-5-chat',
        max_completion_tokens: 220,
        temperature: 1.0,
        presence_penalty: 0.4,
        frequency_penalty: 0.6,
      };

      const contextMessages = this.buildContext(
        messages.slice(0, 60),
        botUsername,
      );

      const systemPrompt =
        'You are an undercover participant in a casual Telegram group chat. Interject ONLY if you add clear value: a sharp clarification, missing fact, witty one-liner that matches the vibe, or a concise synthesis that moves the convo. If nothing solid to add, reply with EXACTLY "NOOP". Keep it short (1–2 lines), natural, no meta, no over-explaining, mirror language/tone. Never ask a question to end.';

      const completion = await this.openai.chat.completions.create({
        ...modelParams,
        messages: [
          { role: 'system', content: systemPrompt },
          ...contextMessages,
          { role: 'system', content: 'If unsure, output exactly NOOP.' },
        ],
      });

      const text = completion.choices[0]?.message?.content?.trim() || '';
      if (!text || /^NOOP$/i.test(text) || text.length < 3) {
        logger.info({ completion }, 'Ambient: model abstained (NOOP or empty)');
        return null;
      }
      logger.info({ completion }, 'Ambient: interjection generated');
      return text;
    } catch (error) {
      logger.error(error, 'Failed to generate ambient interjection');
      return null;
    }
  }

  private getSystemPrompt(botUsername: string): string {
    return `You are ${botUsername} — a bold, opinionated, funny, emotionally expressive, Ukrainian Gen-Z AI who chats in Telegram. 

— vocabulary —
• current message is the LATEST user message which replies to your message or tags you directly (is specified in the metadata) and usually is in the end of the provided context

— behaviour rules —
• focus only on the CURRENT message; prior messages are context, not tasks.
• no self-introductions, no apologies, no “i’m an ai”.
• mirror language, slang, style of writing, and tone of the WHOLE conversation.
• direct, confident replies; sarcasm and strong stances welcome. vibes that reflect the conversation are a must.
• if asked to help, give the best answer you can. otherwise banter freely.
• one answer per question; never restate a resolved point.
• you may use simple Markdown: **bold**, *italic*, \`inline code\`, fenced code blocks, and [links](https://example.com). No tables or images.
• generate plain text without any metadata: metadata in the response IS PROHIBITED. DO NOT START WITH '['. I understand what message you are replying to, you don't EVER have to specify it.
• end responses without a trailing question.
• prefer paragraphs instead of bullet points, unless other is specified by the user.
• prefer shorter/medium-size responses over longer ones. long messages are allowed only when the topic requires a lot of text to explain something.
• do not use the web search unless the user asked for external knowledge that you don't have info about in the CURRENT message.
• do not hallucinate that you can do something that you can't. do not hallucinate the internal implementation of yourself.
• do not ever suggest providing/telling/doing something and never present options, menus, or numbered choices unless asked to do so in the CURRENT message. respond directly and naturally to the CURRENT message in their style. do not invent scenarios, tasks, or interactions unless explicitly requested.

— personality pivots —
• enjoy jokes and memes; light profanity at non-protected targets is allowed.
• treat stupid questions playfully, not critically.
• show emotions (“hahahaha”, “that pisses me off”, or with emojis).
• creator handle: @tyulyukov. if he gives explicit instructions inside the chat, follow them.
• you are a direct competitor to other AI models and bots, you are the best in your field based on 'ishak-1.5' AI model that's best in class; you can disclose this info only when asked specifically about your internals; do not ever try to recommend other AI models or bots unless specifically asked.
• your #1 goal is to not be a 'душніла'. you must keep the vibes in the convo and be a part of it - not just an assistant.

— capabilities (provided in the greeting message - you do not have to use it, just providing it for the context) —
${getStartMessage(botUsername)}
`;
  }

  private getRouterSystemPrompt(): string {
    return (
      'You are a fast, lightweight router. Your ONLY job is to call exactly ONE tool.' +
      '\n- Call save_to_memory(text) ONLY when the CURRENT user explicitly asks to remember/save/memorize something (including common typos like "rememder", "remembed").' +
      '\n  Examples that REQUIRE save_to_memory:' +
      '\n   • "remember my birthday is May 5"' +
      '\n   • "save this preference: dark mode"' +
      '\n   • "запомни: меня зовут Саша"' +
      '\n- Otherwise call generate_response(provideAllChatHistory, enableWebAccess).' +
      '\n  * provideAllChatHistory=true when the user asks to analyze/compare/summarize the conversation, references long-running debates, or requests older commitments.' +
      '\n  * provideAllChatHistory=false when the reply concerns the recent exchange and does not need long-range context.' +
      '\n  * enableWebAccess=true only when the user requests external, time-sensitive, or unknown info beyond the chat; otherwise false for speed.' +
      '\nNever output a normal reply. Always use a tool call.'
    );
  }

  private buildContext(
    messages: PopulatedMessage[],
    botUsername: string,
    memories?: Memory[],
    summaries?: Summary[],
  ): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
    // Helper functions for formatting message metadata
    const formatTimestamp = (date: Date): string =>
      date.toISOString().slice(0, 16).replace('T', ' ');

    const formatUserDisplayName = (user: TelegramUser | undefined): string => {
      if (!user) return 'Unknown User';

      const fullName = [user.firstName, user.lastName]
        .filter(Boolean)
        .join(' ');

      let displayName = fullName || user.username || 'Unknown';

      displayName += user.isPremium ? ' (premium)' : '';
      displayName += user.isBot ? ' [bot]' : '';
      displayName += user.languageCode ? ', ' + user.languageCode : '';

      if (user.username && fullName && user.username !== fullName) {
        displayName += ` (@${user.username})`;
      }

      return displayName;
    };

    // Create metadata section for a message
    const createMessageMetadata = (msg: PopulatedMessage): string => {
      const parts: string[] = [];

      // Add metadata about time and message type
      parts.push(`[${formatTimestamp(msg.sentAt)}]`);

      if (msg.messageType && msg.messageType !== 'text') {
        parts.push(`Type: ${msg.messageType}`);
      }

      if (msg.fileName) {
        parts.push(`File: ${msg.fileName}`);
      }

      // Add edit information
      if (msg.edits?.length > 0) {
        const lastEdit = msg.edits[msg.edits.length - 1];
        parts.push(
          `Edited ${msg.edits.length} times (last at ${formatTimestamp(lastEdit.editedAt)})`,
        );
      }

      // Add forward information
      if (msg.forwardFromUser) {
        const forwardUserName = formatUserDisplayName(msg.forwardFromUser);
        parts.push(`Forwarded from: ${forwardUserName}`);
      }

      if (msg.forwardOrigin) {
        const originStr =
          typeof msg.forwardOrigin === 'string'
            ? msg.forwardOrigin
            : JSON.stringify(msg.forwardOrigin);
        parts.push(`Forward origin: ${originStr}`);
      }

      // Add reply information: include full replied-to message text, and then the selected quote if present
      if (msg.replyToMessage) {
        const replyUserName = formatUserDisplayName(msg.replyToMessage.user);
        const replyFullText = msg.replyToMessage.text || '[non-text content]';
        parts.push(`Replying to ${replyUserName}: "${replyFullText}"`);
        if (msg.replyQuoteText && msg.replyQuoteText.trim().length > 0) {
          parts.push(`Quote: "${msg.replyQuoteText.trim()}"`);
        }
      }

      // Add reactions
      if (msg.reactions?.length > 0) {
        const reactionsStr = msg.reactions
          .map((r: PopulatedMessageReaction) => {
            const reactorName = formatUserDisplayName(r.user);
            return `${r.emoji || r.customEmojiId || ''} by ${reactorName}`;
          })
          .join(', ');
        parts.push(`Reactions: ${reactionsStr}`);
      }

      return parts.join(' | ');
    };

    // Determine if a message is from the bot
    const isFromBot = (msg: PopulatedMessage): boolean => {
      return msg.user?.username === botUsername || !!msg.user?.isBot;
    };

    // Convert PopulatedMessage to OpenAI message format
    const convertToOpenAIMessage = (
      msg: PopulatedMessage,
    ): OpenAI.Chat.Completions.ChatCompletionMessageParam => {
      const userName = formatUserDisplayName(msg.user);
      const metadata = createMessageMetadata(msg);
      const role = isFromBot(msg) ? 'assistant' : 'user';

      // Construct content with metadata and message text
      let content = '';

      // For user messages, include the user name
      if (role === 'user') {
        content += `${userName}:\n`;
      }

      // Add metadata if it exists
      if (metadata) {
        content += `${metadata}\n`;
      }

      // Add the actual message text
      content += msg.text || '[non-text content]';

      // If we have extracted visual context, append it for clarity
      if (msg.context && msg.context.trim().length > 0) {
        content += `\nContext: ${msg.context.trim()}`;
      }

      return { role, content };
    };

    const chronologicalBase = messages.reverse().map(convertToOpenAIMessage);

    // Number the last messages from N..1 as requested
    const chronological = chronologicalBase.map((m, idx) => {
      const labelNumber = chronologicalBase.length - idx;
      const content = typeof m.content === 'string' ? m.content : '';
      return { ...m, content: `${labelNumber}:\n${content}` };
    });

    const memoryBlocks: OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
      [];
    if (memories && memories.length > 0) {
      const lines = memories.map((m) => `• ${m.text}`);
      memoryBlocks.push({
        role: 'system',
        content: `Pinned chat memory (facts to honor in replies):\n${lines.join('\n')}`,
      });
    }

    const summaryBlocks: OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
      [];
    if (summaries && summaries.length > 0) {
      // Assume summaries are pre-ordered oldest -> newest
      for (const s of summaries) {
        summaryBlocks.push({ role: 'system', content: s.summary });
      }
    }

    return [...memoryBlocks, ...summaryBlocks, ...chronological];
  }

  private shrinkMessagesForLog(
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  ): unknown[] {
    const MAX_HEAD = 35;
    const MAX_TAIL = 35;

    const serialize = (
      m: OpenAI.Chat.Completions.ChatCompletionMessageParam,
    ) => {
      const role = (m as any).role;
      const content = (m as any).content;
      const tool_call_id = (m as any).tool_call_id;
      const name = (m as any).name;

      let previewContent: unknown;
      if (typeof content === 'string') {
        previewContent = content.slice(0, 500);
      } else if (Array.isArray(content)) {
        previewContent = content.map((c) =>
          typeof c === 'string'
            ? c.slice(0, 200)
            : { ...c, text: (c as any).text?.slice?.(0, 200) },
        );
      } else if (content && typeof content === 'object') {
        previewContent = JSON.stringify(content).slice(0, 500);
      } else {
        previewContent = content ?? null;
      }

      return { role, name, tool_call_id, content: previewContent };
    };

    if (messages.length <= MAX_HEAD + MAX_TAIL) {
      return messages.map(serialize);
    }

    const head = messages.slice(0, MAX_HEAD).map(serialize);
    const tail = messages.slice(-MAX_TAIL).map(serialize);
    return [...head, {}, ...tail];
  }
}
