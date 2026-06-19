import type { AgentToolDefinition, AgentToolRegistry } from './agent-runner.service.js';
import type { ContextToolService } from './context-tool.service.js';
import type { MessageModel } from '../database/models/Message.js';
import type { SearxngSearchService } from './searxng-search.service.js';
import {
  parseSendPayload,
  type TelegramRichDeliveryService,
} from './telegram-rich-delivery.service.js';
import { markdownToTelegramHtml } from '../utils/markdown-to-telegram-html.js';

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
  contextTools: ContextToolService;
  searchService: SearxngSearchService;
  messageModel: Pick<
    MessageModel,
    | 'findByMessageTelegramId'
    | 'updateReactions'
    | 'replaceUserReactions'
    | 'editMessage'
    | 'markDeleted'
  >;
}

export class TelegramToolRegistry implements AgentToolRegistry {
  constructor(private readonly input: TelegramToolRegistryInput) {}

  getToolDefinitions(): AgentToolDefinition[] {
    return [
      this.tool('send', 'Send one or more user-visible Telegram message bubbles. Use this for normal replies when you want Poke-like pacing or multiple short bubbles. Put only natural chat text in richMarkdown/plainText; never put JSON, tool payloads, metadata, or {"items":...} text inside a message item.', {
        type: 'object',
        properties: {
          items: { type: 'array' },
        },
        minItems: 1,
        required: ['items'],
      }),
      this.tool('get_recent_messages', 'Fetch recent raw chat messages.', {
        type: 'object',
        properties: {
          limit: { type: 'number' },
          sinceMinutes: { type: 'number' },
        },
        required: ['limit'],
      }),
      this.tool('search_messages', 'Search persisted chat messages.', {
        type: 'object',
        properties: {
          query: { type: 'string' },
          since: { type: 'string' },
          until: { type: 'string' },
          fromUser: { type: 'number' },
          limit: { type: 'number' },
        },
      }),
      this.tool('get_reply_thread', 'Follow the reply chain for a message.', {
        type: 'object',
        properties: {
          messageId: { type: 'number' },
          limit: { type: 'number' },
        },
        required: ['messageId'],
      }),
      this.tool('summarize_messages', 'Summarize selected messages or a recent range.', {
        type: 'object',
        properties: {
          messageIds: { type: 'array', items: { type: 'number' } },
          range: { type: 'object' },
        },
      }),
      this.tool('get_chat_digest', 'Get broad stored chat digest.', {
        type: 'object',
        properties: { period: { type: 'string' } },
        required: ['period'],
      }),
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
      this.tool('react_to_message', 'React to a chat message.', {
        type: 'object',
        properties: {
          messageId: { type: 'number' },
          reaction: { type: 'string' },
        },
        required: ['messageId', 'reaction'],
      }),
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
      case 'get_recent_messages':
        return this.input.contextTools.getRecentMessages(
          this.input.chatTelegramId,
          {
            limit: this.numberArg(args.limit, 20),
            sinceMinutes: this.optionalNumberArg(args.sinceMinutes),
          },
        );
      case 'search_messages':
        return this.input.contextTools.searchMessages(this.input.chatTelegramId, {
          query: this.stringArg(args.query),
          since: this.stringArg(args.since),
          until: this.stringArg(args.until),
          fromUser: this.optionalNumberArg(args.fromUser),
          limit: this.optionalNumberArg(args.limit),
        });
      case 'get_reply_thread':
        return this.input.contextTools.getReplyThread(this.input.chatTelegramId, {
          messageId: this.numberArg(args.messageId, 0),
          limit: this.optionalNumberArg(args.limit),
        });
      case 'summarize_messages':
        return this.input.contextTools.summarizeMessages(
          this.input.chatTelegramId,
          {
            messageIds: Array.isArray(args.messageIds)
              ? args.messageIds.filter((id): id is number => typeof id === 'number')
              : undefined,
            range:
              args.range && typeof args.range === 'object'
                ? (args.range as { limit: number })
                : undefined,
          },
        );
      case 'get_chat_digest':
        return this.input.contextTools.getChatDigest(this.input.chatTelegramId, {
          period: this.stringArg(args.period) ?? 'recent',
        });
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

    return this.input.delivery.send(this.input.chatTelegramId, payload);
  }

  private async reactToMessage(args: Record<string, unknown>): Promise<unknown> {
    const messageId = this.numberArg(args.messageId, 0);
    const reaction = this.stringArg(args.reaction) ?? '👍';
    const result = await this.input.api.setMessageReaction(
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

    return result;
  }

  private async editOwnMessage(args: Record<string, unknown>): Promise<unknown> {
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

  private async deleteOwnMessage(args: Record<string, unknown>): Promise<unknown> {
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
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  }

  private optionalNumberArg(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }
}
