import type {
  AgentToolDefinition,
  AgentToolRegistry,
} from './agent-runner.service.js';
import {
  IMAGE_ASPECT_RATIOS,
  isImageAspectRatio,
  type GeneratedImage,
  type ImageAspectRatio,
} from './ai-client.service.js';
import type { ContextToolService } from './context-tool.service.js';
import type { MessageModel } from '../database/models/Message.js';
import type { SearxngSearchService } from './searxng-search.service.js';
import {
  RuntimeCodexOAuthStatusProvider,
  type CodexOAuthStatusProvider,
} from './codex-oauth-status.service.js';
import {
  buildGeneratedPhotoPayload,
  MAX_SEND_ITEMS,
  parseSendPayload,
  type SendPayload,
  type TelegramRichDeliveryService,
} from './telegram-rich-delivery.service.js';
import { markdownToTelegramHtml } from '../utils/markdown-to-telegram-html.js';
import { MESSAGE_TYPE } from '../common/message-types.js';
import type { ArchiveAnalyzer } from './archive-analysis.service.js';

export interface TelegramActionApi {
  deleteMessage(chatId: number, messageId: number): Promise<unknown>;
  editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    other?: Record<string, unknown>,
  ): Promise<unknown>;
  setMessageReaction(
    chatId: number,
    messageId: number,
    reaction: unknown[],
    other?: Record<string, unknown>,
  ): Promise<unknown>;
}

interface TelegramToolRegistryInput {
  chatTelegramId: number;
  botUserTelegramId: number;
  triggerUserTelegramId?: number;
  api: TelegramActionApi;
  delivery: TelegramRichDeliveryService;
  imageService: {
    generateImage(input: {
      prompt: string;
      aspectRatio?: ImageAspectRatio;
    }): Promise<GeneratedImage | null>;
  };
  codexOAuthStatus?: CodexOAuthStatusProvider;
  contextTools: ContextToolService;
  searchService: SearxngSearchService;
  archiveAnalyzer?: ArchiveAnalyzer;
  messageModel: Pick<
    MessageModel,
    | 'findByMessageTelegramId'
    | 'updateReactions'
    | 'replaceUserReactions'
    | 'editMessage'
    | 'markDeleted'
    | 'saveMessage'
  >;
}

export class TelegramToolRegistry implements AgentToolRegistry {
  private usedReplyMetadata = false;
  private archiveAnalysisUsed = false;
  private readonly codexOAuthStatus: CodexOAuthStatusProvider;

  constructor(private readonly input: TelegramToolRegistryInput) {
    this.codexOAuthStatus =
      input.codexOAuthStatus ?? new RuntimeCodexOAuthStatusProvider();
  }

  getToolDefinitions(): AgentToolDefinition[] {
    return [
      this.tool(
        'send',
        `Send 1-${MAX_SEND_ITEMS} user-visible Telegram message bubbles. Keep each bubble short, natural, and Poke-like; use 1 bubble by default, 2 for a setup + result, and 3 only when the extra beat clearly helps. Put only natural chat text in richMarkdown/plainText; never put JSON, tool payloads, metadata, or {"items":...} text inside a message item.`,
        {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              minItems: 1,
              maxItems: MAX_SEND_ITEMS,
              items: {
                type: 'object',
                properties: {
                  richMarkdown: { type: 'string' },
                  richHtml: { type: 'string' },
                  plainText: { type: 'string' },
                  replyToMessageId: { type: 'number' },
                  delayHintMs: { type: 'number' },
                },
                required: ['plainText'],
              },
            },
            continueAfter: { type: 'boolean' },
          },
          required: ['items'],
        },
      ),
      ...(this.codexOAuthStatus.isAvailable()
        ? [
            this.tool(
              'generate_image',
              'Generate one image and send it as a Telegram photo. Use only when the user clearly asks for an image/picture/meme/sticker-like visual, or when a rare ambient meme opportunity is explicitly selected by system logic. Do not use this for ordinary text replies. Keep prompts safe: no private likenesses, no hateful/dehumanizing content, and no copyrighted character/style requests.',
              {
                type: 'object',
                properties: {
                  prompt: {
                    type: 'string',
                    description:
                      'Detailed prompt for the image model. Include the meme subject, visual composition, and any text that should appear in the image.',
                  },
                  caption: {
                    type: 'string',
                    description:
                      'Short Telegram caption to send with the photo.',
                  },
                  replyToMessageId: { type: 'number' },
                  aspectRatio: {
                    type: 'string',
                    enum: [...IMAGE_ASPECT_RATIOS],
                  },
                  continueAfter: { type: 'boolean' },
                },
                required: ['prompt'],
              },
            ),
          ]
        : []),
      this.tool(
        'get_recent_messages',
        'Fetch the last N raw chat messages, optionally only messages from the last sinceMinutes minutes. Use this for fresh context and vibe when the exact anchor message does not matter.',
        {
          type: 'object',
          properties: {
            limit: { type: 'number' },
            sinceMinutes: { type: 'number' },
          },
          required: ['limit'],
        },
      ),
      this.tool(
        'get_messages_before',
        'Fetch the N messages immediately above/before a specific Telegram message in this chat. Use this when the current request is vague, refers to "this/that/it/там/это", or seems to depend on nearby chat/photo context that was not in currentMessageDetails or replyContext. Ask for 5-10 first; increase only if needed.',
        {
          type: 'object',
          properties: {
            messageId: { type: 'number' },
            limit: { type: 'number' },
          },
          required: ['messageId'],
        },
      ),
      this.tool(
        'search_messages',
        'Fetch one page of persisted chat messages by optional text query, date range, author, cursor, and limit. Continue with nextBeforeMessageId while hasMore is true.',
        {
          type: 'object',
          properties: {
            query: { type: 'string' },
            since: { type: 'string' },
            until: { type: 'string' },
            fromUser: { type: 'number' },
            beforeMessageId: { type: 'number' },
            limit: { type: 'number' },
          },
        },
      ),
      ...(this.input.archiveAnalyzer
        ? [
            this.tool(
              'analyze_chat_archive',
              'Delegate a broad, evidence-heavy archive research task to a read-only worker with a larger independent budget. Use for comparisons across many people/messages, historical claim or prediction audits, rankings, and tasks requiring exhaustive pagination plus external verification. Call once with the complete task and known date bounds; use the returned evidence report to answer the user.',
              {
                type: 'object',
                properties: {
                  task: { type: 'string' },
                  since: { type: 'string' },
                  until: { type: 'string' },
                },
                required: ['task'],
              },
            ),
          ]
        : []),
      this.tool(
        'get_raw_message',
        'Fetch the bounded raw stored Telegram update payload for one message id in this chat. Use this when normalized context omits Telegram fields you need, such as poll internals or new message-type fields. This reads stored payloads only; it cannot fetch arbitrary Telegram history.',
        {
          type: 'object',
          properties: {
            messageId: { type: 'number' },
          },
          required: ['messageId'],
        },
      ),
      this.tool(
        'get_chat_stats',
        'Compute exact accounting from stored messages in this chat, excluding this bot and its internal no-reply markers: total messages, messages per day, top posters, and peak hours. Use for questions like "how many messages today", "messages/day", "top flooders", and activity peaks. period defaults to today; timeZone defaults to Europe/Kiev. Results cover messages the bot has stored, not Telegram history it never received.',
        {
          type: 'object',
          properties: {
            period: {
              type: 'string',
              enum: ['today', 'yesterday', 'last24h', 'last7d', 'all'],
            },
            since: { type: 'string' },
            until: { type: 'string' },
            timeZone: { type: 'string' },
            topUsersLimit: { type: 'number' },
            topHoursLimit: { type: 'number' },
            dayLimit: { type: 'number' },
          },
        },
      ),
      this.tool('get_reply_thread', 'Follow the reply chain for a message.', {
        type: 'object',
        properties: {
          messageId: { type: 'number' },
          limit: { type: 'number' },
        },
        required: ['messageId'],
      }),
      this.tool(
        'summarize_messages',
        'Summarize selected messages, the last N messages, or a bounded message period.',
        {
          type: 'object',
          properties: {
            messageIds: { type: 'array', items: { type: 'number' } },
            range: {
              type: 'object',
              properties: {
                limit: { type: 'number' },
                since: { type: 'string' },
                until: { type: 'string' },
                fromUser: { type: 'number' },
              },
            },
          },
        },
      ),
      this.tool('get_chat_digest', 'Get broad stored chat digest.', {
        type: 'object',
        properties: { period: { type: 'string' } },
        required: ['period'],
      }),
      this.tool(
        'get_chat_summaries',
        'Fetch stored summary blocks by level, limit, and optional date range. Use level 0 for most recent message-block summaries; higher levels are broader/older digests.',
        {
          type: 'object',
          properties: {
            level: { type: 'number' },
            limit: { type: 'number' },
            since: { type: 'string' },
            until: { type: 'string' },
          },
        },
      ),
      this.tool('search_memories', 'Search chat memories.', {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'number' },
        },
      }),
      this.tool('save_memory', 'Persist a concise chat memory.', {
        type: 'object',
        properties: {
          text: { type: 'string' },
          sourceMessageId: { type: 'number' },
        },
        required: ['text'],
      }),
      this.tool('delete_memory', 'Delete a chat memory by id.', {
        type: 'object',
        properties: { memoryId: { type: 'string' } },
        required: ['memoryId'],
      }),
      this.tool('web_search', 'Search the web through SearXNG.', {
        type: 'object',
        properties: {
          query: { type: 'string' },
          categories: { type: 'array', items: { type: 'string' } },
          language: { type: 'string' },
          timeRange: { type: 'string', enum: ['day', 'month', 'year'] },
          limit: { type: 'number' },
        },
        required: ['query'],
      }),
      this.tool(
        'react_to_message',
        'React to a chat message instead of sending a text bubble. Use this for pure emotion or lightweight acknowledgement: memes, LMAO, thanks, nice, wild, agreement, approval, or a tiny roast beat. By default this ends the agent reply; set continueAfter=true only when a visible follow-up message is genuinely needed.',
        {
          type: 'object',
          properties: {
            messageId: { type: 'number' },
            reaction: { type: 'string' },
            continueAfter: { type: 'boolean' },
          },
          required: ['messageId', 'reaction'],
        },
      ),
      this.tool(
        'ignore_message',
        'Deliberately send no visible reply and save an internal no-reply marker. Use when silence is the most human response, especially after laughter/acknowledgement/reaction bait where another bot bubble would be cringe.',
        {
          type: 'object',
          properties: {
            messageId: { type: 'number' },
            reason: { type: 'string' },
          },
          required: ['messageId', 'reason'],
        },
      ),
      this.tool('edit_own_message', 'Edit a message sent by this bot.', {
        type: 'object',
        properties: {
          messageId: { type: 'number' },
          content: { type: 'string' },
        },
        required: ['messageId', 'content'],
      }),
      this.tool('delete_own_message', 'Delete a message sent by this bot.', {
        type: 'object',
        properties: { messageId: { type: 'number' } },
        required: ['messageId'],
      }),
    ];
  }

  async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case 'send':
        return this.send(args);
      case 'generate_image':
        return this.generateImage(args);
      case 'get_recent_messages':
        return this.input.contextTools.getRecentMessages(
          this.input.chatTelegramId,
          {
            limit: this.numberArg(args.limit, 20),
            sinceMinutes: this.optionalNumberArg(args.sinceMinutes),
          },
        );
      case 'get_messages_before':
        return this.input.contextTools.getMessagesBefore(
          this.input.chatTelegramId,
          {
            messageId: this.numberArg(args.messageId, 0),
            limit: this.optionalNumberArg(args.limit),
          },
        );
      case 'search_messages':
        return this.input.contextTools.searchMessages(
          this.input.chatTelegramId,
          {
            query: this.stringArg(args.query),
            since: this.stringArg(args.since),
            until: this.stringArg(args.until),
            fromUser: this.optionalNumberArg(args.fromUser),
            beforeMessageId: this.optionalNumberArg(args.beforeMessageId),
            limit: this.optionalNumberArg(args.limit),
          },
        );
      case 'analyze_chat_archive':
        return this.analyzeChatArchive(args);
      case 'get_raw_message':
        return this.input.contextTools.getRawMessage(
          this.input.chatTelegramId,
          {
            messageId: this.numberArg(args.messageId, 0),
          },
        );
      case 'get_chat_stats':
        return this.input.contextTools.getChatStats(this.input.chatTelegramId, {
          period: this.stringArg(args.period),
          since: this.stringArg(args.since),
          until: this.stringArg(args.until),
          timeZone: this.stringArg(args.timeZone),
          topUsersLimit: this.optionalNumberArg(args.topUsersLimit),
          topHoursLimit: this.optionalNumberArg(args.topHoursLimit),
          dayLimit: this.optionalNumberArg(args.dayLimit),
          excludeUserTelegramId: this.input.botUserTelegramId,
        });
      case 'get_reply_thread':
        return this.input.contextTools.getReplyThread(
          this.input.chatTelegramId,
          {
            messageId: this.numberArg(args.messageId, 0),
            limit: this.optionalNumberArg(args.limit),
          },
        );
      case 'summarize_messages':
        return this.input.contextTools.summarizeMessages(
          this.input.chatTelegramId,
          {
            messageIds: Array.isArray(args.messageIds)
              ? args.messageIds.filter(
                  (id): id is number => typeof id === 'number',
                )
              : undefined,
            range:
              args.range && typeof args.range === 'object'
                ? (args.range as { limit: number })
                : undefined,
          },
        );
      case 'get_chat_digest':
        return this.input.contextTools.getChatDigest(
          this.input.chatTelegramId,
          {
            period: this.stringArg(args.period) ?? 'recent',
          },
        );
      case 'get_chat_summaries':
        return this.input.contextTools.getChatSummaries(
          this.input.chatTelegramId,
          {
            level: this.optionalNumberArg(args.level),
            limit: this.optionalNumberArg(args.limit),
            since: this.stringArg(args.since),
            until: this.stringArg(args.until),
          },
        );
      case 'search_memories':
        return this.input.contextTools.searchMemories(
          this.input.chatTelegramId,
          {
            query: this.stringArg(args.query),
            limit: this.optionalNumberArg(args.limit),
          },
        );
      case 'save_memory':
        return this.input.contextTools.saveMemory(
          this.input.chatTelegramId,
          this.input.triggerUserTelegramId ?? this.input.botUserTelegramId,
          {
            text: this.stringArg(args.text) ?? '',
            sourceMessageId: this.optionalNumberArg(args.sourceMessageId),
          },
        );
      case 'delete_memory':
        return this.input.contextTools.deleteMemory(this.input.chatTelegramId, {
          memoryId: this.stringArg(args.memoryId) ?? '',
        });
      case 'web_search':
        return this.input.searchService.search({
          chatTelegramId: this.input.chatTelegramId,
          query: this.stringArg(args.query) ?? '',
          categories: Array.isArray(args.categories)
            ? args.categories.filter(
                (category): category is string => typeof category === 'string',
              )
            : undefined,
          language: this.stringArg(args.language),
          timeRange:
            args.timeRange === 'day' ||
            args.timeRange === 'month' ||
            args.timeRange === 'year'
              ? args.timeRange
              : undefined,
          limit: this.optionalNumberArg(args.limit),
        });
      case 'react_to_message':
        return this.reactToMessage(args);
      case 'ignore_message':
        return this.ignoreMessage(args);
      case 'edit_own_message':
        return this.editOwnMessage(args);
      case 'delete_own_message':
        return this.deleteOwnMessage(args);
      default:
        return { status: 'unknown_tool', name };
    }
  }

  private async send(args: Record<string, unknown>): Promise<unknown> {
    const payload = parseSendPayload(args);
    if (!payload) {
      return {
        status: 'invalid_args',
        reason: 'send_requires_at_least_one_valid_item',
      };
    }

    return this.input.delivery.send(
      this.input.chatTelegramId,
      this.onlyFirstItemCanReply(payload),
    );
  }

  private async analyzeChatArchive(
    args: Record<string, unknown>,
  ): Promise<unknown> {
    if (!this.input.archiveAnalyzer) return { status: 'disabled' };
    if (this.archiveAnalysisUsed) return { status: 'already_used' };

    const task = this.stringArg(args.task);
    if (!task) {
      return { status: 'invalid_args', reason: 'task_is_required' };
    }

    this.archiveAnalysisUsed = true;

    return this.input.archiveAnalyzer.analyze({
      chatTelegramId: this.input.chatTelegramId,
      task,
      since: this.stringArg(args.since),
      until: this.stringArg(args.until),
    });
  }

  private async generateImage(args: Record<string, unknown>): Promise<unknown> {
    if (!this.codexOAuthStatus.isAvailable()) {
      return { status: 'disabled', reason: 'codex_oauth_required' };
    }

    const prompt = this.stringArg(args.prompt)?.trim() ?? '';
    if (!prompt) {
      return { status: 'invalid_args', reason: 'prompt_required' };
    }

    const caption = (
      this.stringArg(args.caption)?.trim() || 'generated image'
    ).slice(0, 200);
    const image = await this.input.imageService.generateImage({
      prompt: prompt.slice(0, 1_500),
      aspectRatio: this.imageAspectRatioArg(args.aspectRatio),
    });

    if (!image) {
      return { status: 'error', reason: 'image_generation_failed' };
    }

    const replyToMessageId = this.optionalNumberArg(args.replyToMessageId);
    const payload = this.onlyFirstItemCanReply(
      buildGeneratedPhotoPayload({
        caption,
        imageDataUrl: image.dataUrl,
        replyToMessageId,
      }),
    );

    return this.input.delivery.send(this.input.chatTelegramId, payload);
  }

  private onlyFirstItemCanReply(payload: SendPayload): SendPayload {
    return {
      items: payload.items.map((item, index) => {
        const canReply =
          !this.usedReplyMetadata &&
          index === 0 &&
          typeof item.replyToMessageId === 'number';
        if (canReply) {
          this.usedReplyMetadata = true;
          return item;
        }

        return { ...item, replyToMessageId: undefined };
      }),
    };
  }

  private async reactToMessage(
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const messageId = this.numberArg(args.messageId, 0);
    const reaction = this.stringArg(args.reaction) ?? '👍';
    await this.input.api.setMessageReaction(
      this.input.chatTelegramId,
      messageId,
      [{ type: 'emoji', emoji: reaction }],
    );

    await this.input.messageModel.replaceUserReactions(
      messageId,
      this.input.chatTelegramId,
      this.input.botUserTelegramId,
      [{ emoji: reaction }],
    );

    return { status: 'ok', reacted: true, messageId, reaction };
  }

  private async ignoreMessage(args: Record<string, unknown>): Promise<unknown> {
    const messageId = this.numberArg(args.messageId, 0);
    if (messageId <= 0) {
      return { status: 'invalid_args', reason: 'messageId_required' };
    }

    const rawReason = this.stringArg(args.reason) ?? 'no useful reply needed';
    const reason = rawReason.trim().slice(0, 300) || 'no useful reply needed';

    await this.input.messageModel.saveMessage({
      telegramId: -Math.abs(messageId),
      chatTelegramId: this.input.chatTelegramId,
      userTelegramId: this.input.botUserTelegramId,
      text: '',
      context: `Bot deliberately did not send a visible reply. Reason: ${reason}`,
      replyToMessageTelegramId: messageId,
      sentAt: new Date(),
      messageType: MESSAGE_TYPE.OTHER,
      payload: {
        type: 'agent_no_visible_reply',
        messageId,
        reason,
      },
    });

    return { status: 'ok', ignored: true, messageId };
  }

  private async editOwnMessage(
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const messageId = this.numberArg(args.messageId, 0);
    const message = await this.input.messageModel.findByMessageTelegramId(
      messageId,
      this.input.chatTelegramId,
    );

    if (!message) return { status: 'not_found' };
    if (message.userTelegramId !== this.input.botUserTelegramId) {
      return { status: 'forbidden', reason: 'message_not_sent_by_this_bot' };
    }

    const result = await this.input.api.editMessageText(
      this.input.chatTelegramId,
      messageId,
      markdownToTelegramHtml(this.stringArg(args.content) ?? ''),
    );
    await this.input.messageModel.editMessage(
      messageId,
      this.input.chatTelegramId,
      this.stringArg(args.content) ?? '',
    );

    return result;
  }

  private async deleteOwnMessage(
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const messageId = this.numberArg(args.messageId, 0);
    const message = await this.input.messageModel.findByMessageTelegramId(
      messageId,
      this.input.chatTelegramId,
    );

    if (!message) return { status: 'not_found' };
    if (message.userTelegramId !== this.input.botUserTelegramId) {
      return { status: 'forbidden', reason: 'message_not_sent_by_this_bot' };
    }

    await this.input.api.deleteMessage(this.input.chatTelegramId, messageId);
    await this.input.messageModel.markDeleted(
      messageId,
      this.input.chatTelegramId,
    );
    return { status: 'ok', deleted: true };
  }

  private tool(
    name: string,
    description: string,
    parameters: Record<string, unknown>,
  ): AgentToolDefinition {
    return {
      type: 'function',
      function: { name, description, parameters },
    };
  }

  private stringArg(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
  }

  private numberArg(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value)
      ? value
      : fallback;
  }

  private optionalNumberArg(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value)
      ? value
      : undefined;
  }

  private imageAspectRatioArg(value: unknown): ImageAspectRatio | undefined {
    return typeof value === 'string' && isImageAspectRatio(value)
      ? value
      : undefined;
  }
}
