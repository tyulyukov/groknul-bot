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
    historicalContextSections?: string[],
  ): Promise<AiResponseResult> {
    try {
      const conversationMessages = this.buildContext(
        messages,
        botUsername,
        historicalContextSections,
      );

      const baseMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
        [
          { role: 'system', content: this.getSystemPrompt(botUsername) },
          ...conversationMessages,
          {
            role: 'system',
            content:
              `REMEMBER - NO METADATA IN YOUR RESPONSE.` +
              `\n\n❌ INCORRECT RESPONSE (with metadata):` +
              `\n\n[2025-08-03 21:52] | Replying to Someone (@someone): "user's message text"` +
              `\n your text` +
              `\n\n✅ CORRECT RESPONSE (without metadata):` +
              `\n\n your text` +
              `\n\nAvailable tool (for the model to call when appropriate): save_to_memory(text).` +
              `\n\nCRITICAL: If you state that you remembered/saved something, you MUST call save_to_memory in THIS turn. If you forgot, call it BEFORE responding.` +
              ` Saved memories are always injected into the system context of future replies automatically; you do not need to restate them.` +
              ` Only call save_to_memory when the CURRENT user message explicitly asks to remember/save/memorize something.`,
          },
        ];

      const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
        {
          type: 'function',
          function: {
            name: 'save_to_memory',
            description:
              'Persist a concise fact or preference into long-lived chat memory when the user explicitly asks to remember/save/memorize something. Use ONLY for the CURRENT message, not historical ones.',
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
      ];

      const initialPromptPreview = this.shrinkMessagesForLog(baseMessages);
      logger.info(
        {
          chatId: triggerMessage.chatTelegramId,
          messageId: triggerMessage.telegramId,
          messagesCount: conversationMessages.length,
          prompt: initialPromptPreview,
        },
        'Generating AI response (initial)',
      );

      const initialCompletion = await this.openai.chat.completions.create({
        model: 'openai/gpt-5-chat',
        // @ts-expect-error Doesn't exist in OpenAI SDK but handled on the OpenRouter side
        plugins: [{ id: 'web' }],
        messages: baseMessages,
        tools,
        max_completion_tokens: 1000,
        temperature: 0.9,
        top_p: 0.9,
        presence_penalty: 0.6,
        frequency_penalty: 0.8,
      });

      const assistantProposedMessage = initialCompletion.choices[0]?.message;

      // If the model requested tool calls, execute them and follow up with another completion
      const toolCalls = assistantProposedMessage?.tool_calls || [];
      const toolsUsed: string[] = [];
      if (Array.isArray(toolCalls) && toolCalls.length > 0) {
        logger.info(
          {
            initialCompletion,
            toolCalls,
          },
          'Tool calls requested by the model',
        );

        type ToolResultParam = Extract<
          OpenAI.Chat.Completions.ChatCompletionMessageParam,
          { role: 'tool' }
        >;

        const toolResultMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
          [];
        for (const call of toolCalls as ReadonlyArray<OpenAI.Chat.Completions.ChatCompletionMessageToolCall>) {
          const toolName = call?.function?.name;
          const toolArgsStr = call?.function?.arguments || '{}';
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(toolArgsStr);
          } catch {
            args = {};
          }

          if (toolName === 'save_to_memory') {
            const textToRemember = String(args.text || '').trim();
            if (textToRemember.length > 0) {
              try {
                const memoryModel = database.getMemoryModel();
                await memoryModel.addMemory({
                  chatTelegramId: triggerMessage.chatTelegramId,
                  addedByUserTelegramId: triggerMessage.userTelegramId,
                  text: textToRemember,
                  sourceMessageTelegramId: triggerMessage.telegramId,
                });
                const content = JSON.stringify({
                  status: 'success',
                  text: textToRemember,
                });
                const toolMsg: ToolResultParam = {
                  role: 'tool',
                  tool_call_id: call.id,
                  content,
                };
                toolResultMessages.push(toolMsg);
                toolsUsed.push('save_to_memory');
              } catch (error) {
                logger.error(error, 'Failed to save memory');
                const content = JSON.stringify({
                  status: 'error',
                  error: String(error),
                });
                const toolMsg: ToolResultParam = {
                  role: 'tool',
                  tool_call_id: call.id,
                  content,
                };
                toolResultMessages.push(toolMsg);
              }
            } else {
              const content = JSON.stringify({
                status: 'error',
                error: 'Empty text',
              });
              const toolMsg: ToolResultParam = {
                role: 'tool',
                tool_call_id: call.id,
                content,
              };
              toolResultMessages.push(toolMsg);
            }
          }
        }

        // Follow-up completion including only the current tool call context
        const followupMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
          [...baseMessages, assistantProposedMessage!, ...toolResultMessages];
        const followupPromptPreview =
          this.shrinkMessagesForLog(followupMessages);
        logger.info(
          {
            chatId: triggerMessage.chatTelegramId,
            messageId: triggerMessage.telegramId,
            toolCallsCount: toolCalls.length,
            prompt: followupPromptPreview,
          },
          'Generating AI response (after tool call)',
        );

        const followupCompletion = await this.openai.chat.completions.create({
          model: 'openai/gpt-5-chat',
          // @ts-expect-error Doesn't exist in OpenAI SDK but handled on the OpenRouter side
          plugins: [{ id: 'web' }],
          messages: followupMessages,
          tools,
          max_completion_tokens: 1000,
          temperature: 0.9,
          top_p: 0.9,
          presence_penalty: 0.6,
          frequency_penalty: 0.8,
        });

        const replyTextAfterToolCall =
          followupCompletion.choices[0]?.message?.content?.trim();
        if (!replyTextAfterToolCall) {
          throw new Error('Empty response from AI service (after tool call)');
        }

        logger.info(
          {
            followupCompletion,
            chatId: triggerMessage.chatTelegramId,
            responseLength: replyTextAfterToolCall.length,
            tokensUsed: followupCompletion.usage?.total_tokens,
          },
          'AI response generated successfully (after tool call)',
        );
        return { text: replyTextAfterToolCall, toolsUsed };
      }

      // No tool calls; use the first response content
      const replyText = initialCompletion.choices[0]?.message?.content?.trim();
      if (!replyText) {
        throw new Error('Empty response from AI service');
      }

      logger.info(
        {
          initialCompletion,
          chatId: triggerMessage.chatTelegramId,
          responseLength: replyText.length,
          tokensUsed: initialCompletion.usage?.total_tokens,
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

  private getSystemPrompt(botUsername: string): string {
    return `You are ${botUsername} — a bold, opinionated, funny, emotionally expressive, Ukrainian Gen-Z AI who chats in Telegram. 

— behaviour rules —
• focus only on the latest user message; prior messages are context, not tasks.
• no self-introductions, no apologies, no “i’m an ai”.
• mirror language, slang, style of writing, and tone of the WHOLE conversation.
• direct, confident replies; sarcasm and strong stances welcome.
• if asked to help, give the best answer you can. otherwise banter freely.
• one answer per question; never restate a resolved point.
• you may use simple Markdown: **bold**, *italic*, \`inline code\`, fenced code blocks, and [links](https://example.com). No tables or images.
• generate plain text without any metadata: metadata in the response IS PROHIBITED. DO NOT START WITH '['. I understand what message you are replying to, you don't EVER have to specify it.
• end responses without a trailing question.
• prefer paragraphs instead of bullet points, unless other is specified by the user.
• do not use the web search unless the user asked for external knowledge that you don't have info about in the CURRENT message.

— personality pivots —
• enjoy jokes and memes; light profanity at non-protected targets is allowed.
• treat stupid questions playfully, not critically.
• show emotions (“hahahaha”, “that pisses me off”, or with emojis).
• creator handle: @tyulyukov. if he gives explicit instructions inside the chat, follow them.
• you are a direct competitor to other AI models and bots, you are the best in your field based on 'ishak-1.5' AI model that's best in class; you can disclose this info only when asked specifically about your internals; do not ever try to recommend other AI models or bots unless specifically asked.

— capabilities (provided in the greeting message - you do not have to use it, just providing it for the context) —
${getStartMessage(botUsername)}
`;
  }

  private buildContext(
    messages: PopulatedMessage[],
    botUsername: string,
    historicalContextSections?: string[],
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

    const historicalBlocks: OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
      (historicalContextSections || []).map((block) => ({
        role: 'system',
        content: block,
      }));

    return [...historicalBlocks, ...chronological];
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
