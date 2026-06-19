import type { Database } from '../database/index.js';
import type {
  PopulatedMessage,
  MessageModel,
} from '../database/models/Message.js';
import type { MemoryModel } from '../database/models/Memory.js';
import type { SummaryModel } from '../database/models/Summary.js';

export interface ContextToolLimits {
  maxMessages: number;
  maxChars: number;
  maxResults: number;
}

export type ContextToolResult =
  | {
      status: 'ok';
      messages?: unknown[];
      memories?: unknown[];
      summaries?: unknown[];
      digest?: string;
      summary?: string;
      deleted?: boolean;
    }
  | {
      status: 'too_large';
      suggested: Record<string, unknown>;
    }
  | {
      status: 'not_found';
    };

interface MinimalDatabase {
  getMessageModel(): Pick<
    MessageModel,
    | 'getRecentMessages'
    | 'getMessagesBefore'
    | 'searchMessages'
    | 'findByMessageTelegramId'
    | 'countMessages'
  >;
  getMemoryModel(): Pick<
    MemoryModel,
    'searchByChat' | 'addMemory' | 'deleteById' | 'listByChat'
  >;
  getSummaryModel(): Pick<
    SummaryModel,
    'getByLevelAscending' | 'getCount'
  >;
}

interface Summarizer {
  summarizeText(blocks: string[], instruction: string): Promise<string>;
}

export class ContextToolService {
  constructor(
    private readonly database: MinimalDatabase | Database,
    private readonly summarizer: Summarizer,
    private readonly limits: ContextToolLimits,
  ) {}

  async getRecentMessages(
    chatTelegramId: number,
    input: { limit: number; sinceMinutes?: number },
  ): Promise<ContextToolResult> {
    const requestedLimit = this.normalizeLimit(input.limit, this.limits.maxMessages + 1);
    const limitCheck = this.checkLimit(requestedLimit, {
      limit: this.limits.maxMessages,
      sinceMinutes: input.sinceMinutes,
    });
    if (limitCheck) return limitCheck;

    const messages = await this.database
      .getMessageModel()
      .getRecentMessages(chatTelegramId, requestedLimit);
    const filtered =
      typeof input.sinceMinutes === 'number'
        ? messages.filter(
            (message) =>
              new Date(message.sentAt).getTime() >=
              Date.now() - input.sinceMinutes! * 60_000,
          )
        : messages;

    return this.messagesResult(filtered);
  }

  async getMessagesBefore(
    chatTelegramId: number,
    input: { messageId: number; limit?: number },
  ): Promise<ContextToolResult> {
    const limit = this.normalizeLimit(input.limit, 10);
    const limitCheck = this.checkLimit(limit, { limit: this.limits.maxMessages });
    if (limitCheck) return limitCheck;

    const messages = await this.database
      .getMessageModel()
      .getMessagesBefore(chatTelegramId, input.messageId, limit);

    return messages.length > 0 ? this.messagesResult(messages) : { status: 'not_found' };
  }

  async searchMessages(
    chatTelegramId: number,
    input: {
      query?: string;
      since?: string;
      until?: string;
      fromUser?: number;
      limit?: number;
    },
  ): Promise<ContextToolResult> {
    const limit = this.normalizeLimit(input.limit, this.limits.maxResults);
    const limitCheck = this.checkLimit(limit, { limit: this.limits.maxResults });
    if (limitCheck) return limitCheck;

    const since = this.parseDate(input.since);
    const until = this.parseDate(input.until);
    const messages = await this.database.getMessageModel().searchMessages({
      chatTelegramId,
      query: input.query,
      since,
      until,
      fromUserTelegramId: input.fromUser,
      limit,
    });

    return this.messagesResult(messages);
  }

  async getReplyThread(
    chatTelegramId: number,
    input: { messageId: number; limit?: number },
  ): Promise<ContextToolResult> {
    const limit = this.normalizeLimit(input.limit, 20);
    const limitCheck = this.checkLimit(limit, { limit: this.limits.maxMessages });
    if (limitCheck) return limitCheck;

    const messages: PopulatedMessage[] = [];
    let currentId: number | undefined = input.messageId;
    while (currentId && messages.length < limit) {
      const message = await this.database
        .getMessageModel()
        .findByMessageTelegramId(currentId, chatTelegramId);
      if (!message) break;
      messages.push(message);
      currentId = message.replyToMessageTelegramId;
    }

    return messages.length > 0 ? this.messagesResult(messages) : { status: 'not_found' };
  }

  async summarizeMessages(
    chatTelegramId: number,
    input: {
      messageIds?: number[];
      range?: {
        limit: number;
        since?: string;
        until?: string;
        fromUser?: number;
      };
    },
  ): Promise<ContextToolResult> {
    const ids = input.messageIds ?? [];
    const limit =
      ids.length > 0 ? ids.length : this.normalizeLimit(input.range?.limit, 20);
    const limitCheck = this.checkLimit(limit, { limit: this.limits.maxMessages });
    if (limitCheck) return limitCheck;

    const messages =
      ids.length > 0
        ? (
            await Promise.all(
              ids.map((id) =>
                this.database
                  .getMessageModel()
                  .findByMessageTelegramId(id, chatTelegramId),
              ),
            )
          ).filter((message): message is PopulatedMessage => Boolean(message))
        : input.range?.since ||
            input.range?.until ||
            typeof input.range?.fromUser === 'number'
          ? await this.database.getMessageModel().searchMessages({
              chatTelegramId,
              since: this.parseDate(input.range.since),
              until: this.parseDate(input.range.until),
              fromUserTelegramId: input.range.fromUser,
              limit,
            })
          : await this.database
              .getMessageModel()
              .getRecentMessages(chatTelegramId, limit);

    const summary = await this.summarizer.summarizeText(
      messages.map((message) => this.formatMessage(message)),
      'Summarize these selected chat messages concisely, preserving facts, decisions, jokes that matter to context, and unresolved questions.',
    );

    return { status: 'ok', summary };
  }

  async getChatSummaries(
    chatTelegramId: number,
    input: {
      level?: number;
      limit?: number;
      since?: string;
      until?: string;
    },
  ): Promise<ContextToolResult> {
    const limit = this.normalizeLimit(input.limit, this.limits.maxResults);
    const level = this.normalizeLevel(input.level);
    const limitCheck = this.checkLimit(limit, {
      level,
      limit: this.limits.maxResults,
      since: input.since,
      until: input.until,
    });
    if (limitCheck) return limitCheck;

    const summaries = await this.database
      .getSummaryModel()
      .getByLevelAscending(chatTelegramId, level);
    const since = this.parseDate(input.since);
    const until = this.parseDate(input.until);
    const filtered = summaries.filter((summary) => {
      if (
        since &&
        summary.endSentAt &&
        summary.endSentAt.getTime() < since.getTime()
      ) {
        return false;
      }

      if (
        until &&
        summary.startSentAt &&
        summary.startSentAt.getTime() > until.getTime()
      ) {
        return false;
      }

      return true;
    });

    return {
      status: 'ok',
      summaries: filtered.slice(-limit).map((summary) => ({
        level: summary.level,
        index: summary.index,
        summary: summary.summary,
        startSentAt: summary.startSentAt,
        endSentAt: summary.endSentAt,
      })),
    };
  }

  async getChatDigest(
    chatTelegramId: number,
    input: { period: string },
  ): Promise<ContextToolResult> {
    const summaryModel = this.database.getSummaryModel();
    let probeLevel = 0;
    while ((await summaryModel.getCount(chatTelegramId, probeLevel)) > 0) {
      probeLevel += 1;
    }

    const maxLevel = probeLevel - 1;
    const blocks: string[] = [];
    for (let level = maxLevel; level >= 1; level -= 1) {
      const summaries = await summaryModel.getByLevelAscending(
        chatTelegramId,
        level,
      );
      blocks.push(
        ...summaries.map(
          (summary) => `Level ${level} digest:\n${summary.summary}`,
        ),
      );
    }

    const level0 = await summaryModel.getByLevelAscending(chatTelegramId, 0);
    blocks.push(
      ...level0
        .slice(-10)
        .map((summary) => `Recent digest:\n${summary.summary}`),
    );

    return {
      status: 'ok',
      digest:
        blocks.join('\n\n') ||
        `No stored digest is available for period "${input.period}". Ask for recent messages instead.`,
    };
  }

  async searchMemories(
    chatTelegramId: number,
    input: { query?: string; limit?: number },
  ): Promise<ContextToolResult> {
    const limit = this.normalizeLimit(input.limit, this.limits.maxResults);
    const limitCheck = this.checkLimit(limit, { limit: this.limits.maxResults });
    if (limitCheck) return limitCheck;

    const memories = await this.database
      .getMemoryModel()
      .searchByChat(chatTelegramId, input.query, limit);

    return {
      status: 'ok',
      memories: memories.map((memory) => ({
        id: memory._id,
        text: memory.text,
        sourceMessageId: memory.sourceMessageTelegramId,
        createdAt: memory.createdAt,
      })),
    };
  }

  async saveMemory(
    chatTelegramId: number,
    addedByUserTelegramId: number,
    input: { text: string; sourceMessageId?: number },
  ): Promise<ContextToolResult> {
    const memory = await this.database.getMemoryModel().addMemory({
      chatTelegramId,
      addedByUserTelegramId,
      text: input.text,
      sourceMessageTelegramId: input.sourceMessageId,
    });

    return {
      status: 'ok',
      memories: [{ id: memory._id, text: memory.text }],
    };
  }

  async deleteMemory(
    chatTelegramId: number,
    input: { memoryId: string },
  ): Promise<ContextToolResult> {
    const deleted = await this.database
      .getMemoryModel()
      .deleteById(chatTelegramId, input.memoryId);

    return { status: 'ok', deleted };
  }

  private checkLimit(
    requested: number,
    suggested: Record<string, unknown>,
  ): ContextToolResult | null {
    if (requested > (suggested.limit as number)) {
      return { status: 'too_large', suggested };
    }

    return null;
  }

  private normalizeLimit(value: number | undefined, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.max(1, Math.floor(value));
  }

  private normalizeLevel(value: number | undefined): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
    return Math.max(0, Math.floor(value));
  }

  private parseDate(value: string | undefined): Date | undefined {
    if (!value) return undefined;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : undefined;
  }

  private messagesResult(messages: PopulatedMessage[]): ContextToolResult {
    const formatted = messages.map((message) => this.formatMessage(message));
    const totalChars = formatted.reduce((sum, message) => sum + message.length, 0);

    if (totalChars > this.limits.maxChars) {
      return {
        status: 'too_large',
        suggested: {
          limit: Math.max(1, Math.floor(messages.length / 2)),
        },
      };
    }

    return {
      status: 'ok',
      messages: messages.map((message) => ({
        id: message.telegramId,
        from: message.user?.username ?? message.user?.firstName ?? 'unknown',
        userTelegramId: message.userTelegramId,
        text: message.text,
        context: message.context,
        sentAt: message.sentAt,
        replyToMessageId: message.replyToMessageTelegramId,
        reactions: message.reactions?.map(
          (reaction) => reaction.emoji ?? reaction.customEmojiId,
        ),
      })),
    };
  }

  private formatMessage(message: PopulatedMessage): string {
    const author = message.user?.username ?? message.user?.firstName ?? 'unknown';
    return `${message.sentAt.toISOString()} | ${author}: ${
      message.text ?? '[non-text content]'
    }${message.context ? `\nContext: ${message.context}` : ''}`;
  }
}
