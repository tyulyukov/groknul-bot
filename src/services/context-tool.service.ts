import type { Database } from '../database/index.js';
import type {
  PopulatedMessage,
  MessageModel,
} from '../database/models/Message.js';
import type { MemoryModel } from '../database/models/Memory.js';
import type { SummaryModel } from '../database/models/Summary.js';

type MessageStatsPeriod = 'today' | 'yesterday' | 'last24h' | 'last7d' | 'all';

export interface ContextToolLimits {
  maxMessages: number;
  maxChars: number;
  maxResults: number;
}

export interface ContextToolMessageResult {
  id: number;
  from: string;
  userTelegramId?: number;
  text?: string;
  context?: string;
  fileName?: string;
  messageType?: PopulatedMessage['messageType'];
  sentAt?: Date;
  replyToMessageId?: number;
  replyQuoteText?: string;
  reactions?: string[];
}

export interface ContextToolStatsResult {
  period: string;
  timeZone: string;
  totalMessages: number;
  firstSentAt?: Date;
  lastSentAt?: Date;
  byDay: { date: string; count: number }[];
  topUsers: {
    userTelegramId: number;
    from: string;
    count: number;
    isBot?: boolean;
  }[];
  peakHours: { hour: string; count: number }[];
  source: 'stored_messages';
}

export interface ContextToolRawMessageResult {
  id: number;
  messageType?: PopulatedMessage['messageType'];
  sentAt?: Date;
  payloadJson: string;
  truncated: boolean;
}

export type ContextToolResult =
  | {
      status: 'ok';
      messages?: ContextToolMessageResult[];
      memories?: unknown[];
      summaries?: unknown[];
      digest?: string;
      summary?: string;
      stats?: ContextToolStatsResult;
      rawMessage?: ContextToolRawMessageResult;
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
    | 'findRawByMessageTelegramId'
    | 'countMessages'
    | 'getChatStats'
  >;
  getMemoryModel(): Pick<
    MemoryModel,
    'searchByChat' | 'addMemory' | 'deleteById' | 'listByChat'
  >;
  getSummaryModel(): Pick<SummaryModel, 'getByLevelAscending' | 'getCount'>;
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
    const requestedLimit = this.normalizeLimit(
      input.limit,
      this.limits.maxMessages + 1,
    );
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
    const limitCheck = this.checkLimit(limit, {
      limit: this.limits.maxMessages,
    });
    if (limitCheck) return limitCheck;

    const messages = await this.database
      .getMessageModel()
      .getMessagesBefore(chatTelegramId, input.messageId, limit);

    return messages.length > 0
      ? this.messagesResult(messages)
      : { status: 'not_found' };
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
    const limitCheck = this.checkLimit(limit, {
      limit: this.limits.maxResults,
    });
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

  async getChatStats(
    chatTelegramId: number,
    input: {
      period?: string;
      since?: string;
      until?: string;
      timeZone?: string;
      topUsersLimit?: number;
      topHoursLimit?: number;
      dayLimit?: number;
      excludeUserTelegramId?: number;
      now?: Date;
    },
  ): Promise<ContextToolResult> {
    const explicitSince = this.parseDate(input.since);
    const explicitUntil = this.parseDate(input.until);
    const period = this.normalizeStatsPeriod(input.period);
    const timeZone = this.normalizeTimeZone(input.timeZone);
    const topUsersLimit = this.normalizeResultLimit(input.topUsersLimit, 10);
    const topHoursLimit = this.normalizeResultLimit(input.topHoursLimit, 5);
    const dayLimit = this.normalizeResultLimit(input.dayLimit, 14);
    const window =
      explicitSince || explicitUntil
        ? { since: explicitSince, until: explicitUntil }
        : this.resolveStatsWindow(period, timeZone, input.now);

    const statsInput = {
      chatTelegramId,
      timeZone,
      topUsersLimit,
      topHoursLimit,
      dayLimit,
    };
    if (window.since) Object.assign(statsInput, { since: window.since });
    if (window.until) Object.assign(statsInput, { until: window.until });
    if (typeof input.excludeUserTelegramId === 'number') {
      Object.assign(statsInput, {
        excludeUserTelegramId: input.excludeUserTelegramId,
      });
    }

    const stats = await this.database
      .getMessageModel()
      .getChatStats(statsInput);

    return {
      status: 'ok',
      stats: {
        period: explicitSince || explicitUntil ? 'custom' : period,
        timeZone,
        totalMessages: stats.totalMessages,
        firstSentAt: stats.firstSentAt,
        lastSentAt: stats.lastSentAt,
        byDay: stats.byDay.map((item) => ({
          date: item.day,
          count: item.count,
        })),
        topUsers: stats.topUsers.map((item) => {
          const result = {
            userTelegramId: item.userTelegramId,
            from:
              item.username ?? item.firstName ?? String(item.userTelegramId),
            count: item.count,
          };

          return typeof item.isBot === 'boolean'
            ? { ...result, isBot: item.isBot }
            : result;
        }),
        peakHours: stats.peakHours,
        source: 'stored_messages',
      },
    };
  }

  async getRawMessage(
    chatTelegramId: number,
    input: { messageId: number },
  ): Promise<ContextToolResult> {
    const message = await this.database
      .getMessageModel()
      .findRawByMessageTelegramId(input.messageId, chatTelegramId);
    if (!message) return { status: 'not_found' };

    const payload = this.stringifyBounded(message.payload);

    return {
      status: 'ok',
      rawMessage: {
        id: message.telegramId,
        messageType: message.messageType,
        sentAt: message.sentAt,
        payloadJson: payload.text,
        truncated: payload.truncated,
      },
    };
  }

  async getReplyThread(
    chatTelegramId: number,
    input: { messageId: number; limit?: number },
  ): Promise<ContextToolResult> {
    const limit = this.normalizeLimit(input.limit, 20);
    const limitCheck = this.checkLimit(limit, {
      limit: this.limits.maxMessages,
    });
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

    return messages.length > 0
      ? this.messagesResult(messages)
      : { status: 'not_found' };
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
    const limitCheck = this.checkLimit(limit, {
      limit: this.limits.maxMessages,
    });
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
    const limitCheck = this.checkLimit(limit, {
      limit: this.limits.maxResults,
    });
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

  private normalizeResultLimit(
    value: number | undefined,
    fallback: number,
  ): number {
    return Math.min(
      this.limits.maxResults,
      this.normalizeLimit(value, fallback),
    );
  }

  private normalizeStatsPeriod(value: string | undefined): MessageStatsPeriod {
    switch (value) {
      case 'yesterday':
      case 'last24h':
      case 'last7d':
      case 'all':
        return value;
      case 'today':
      default:
        return 'today';
    }
  }

  private resolveStatsWindow(
    period: MessageStatsPeriod,
    timeZone: string,
    now = new Date(),
  ): { since?: Date; until?: Date } {
    const dayMs = 24 * 60 * 60 * 1000;

    switch (period) {
      case 'today':
        return this.getZonedDayWindow(now, timeZone, 0);
      case 'yesterday':
        return this.getZonedDayWindow(now, timeZone, -1);
      case 'last24h':
        return { since: new Date(now.getTime() - dayMs), until: now };
      case 'last7d':
        return { since: new Date(now.getTime() - 7 * dayMs), until: now };
      case 'all':
      default:
        return {};
    }
  }

  private getZonedDayWindow(
    now: Date,
    timeZone: string,
    dayOffset: number,
  ): { since: Date; until: Date } {
    const currentParts = this.zonedDateParts(now, timeZone);
    const targetDay = new Date(
      Date.UTC(
        currentParts.year,
        currentParts.month - 1,
        currentParts.day + dayOffset,
      ),
    );
    const parts = {
      year: targetDay.getUTCFullYear(),
      month: targetDay.getUTCMonth() + 1,
      day: targetDay.getUTCDate(),
    };
    const nextDay = new Date(
      Date.UTC(parts.year, parts.month - 1, parts.day + 1),
    );

    return {
      since: this.zonedLocalTimeToUtc(
        parts.year,
        parts.month,
        parts.day,
        timeZone,
      ),
      until: this.zonedLocalTimeToUtc(
        nextDay.getUTCFullYear(),
        nextDay.getUTCMonth() + 1,
        nextDay.getUTCDate(),
        timeZone,
      ),
    };
  }

  private zonedDateParts(
    date: Date,
    timeZone: string,
  ): { year: number; month: number; day: number } {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const value = (type: string) =>
      Number(parts.find((part) => part.type === type)?.value);

    return {
      year: value('year'),
      month: value('month'),
      day: value('day'),
    };
  }

  private zonedLocalTimeToUtc(
    year: number,
    month: number,
    day: number,
    timeZone: string,
  ): Date {
    const localAsUtc = Date.UTC(year, month - 1, day);
    let utc = new Date(localAsUtc);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      utc = new Date(localAsUtc - this.timeZoneOffsetMs(utc, timeZone));
    }

    return utc;
  }

  private timeZoneOffsetMs(date: Date, timeZone: string): number {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    const value = (type: string) =>
      Number(parts.find((part) => part.type === type)?.value);

    return (
      Date.UTC(
        value('year'),
        value('month') - 1,
        value('day'),
        value('hour'),
        value('minute'),
        value('second'),
      ) - date.getTime()
    );
  }

  private normalizeTimeZone(value: string | undefined): string {
    const fallback = 'Europe/Kiev';
    if (!value) return fallback;

    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
      return value;
    } catch {
      return fallback;
    }
  }

  private parseDate(value: string | undefined): Date | undefined {
    if (!value) return undefined;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : undefined;
  }

  private stringifyBounded(value: unknown): {
    text: string;
    truncated: boolean;
  } {
    let text: string;
    try {
      text = JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      text = String(value);
    }

    if (text.length <= this.limits.maxChars) {
      return { text, truncated: false };
    }

    return {
      text: `${text.slice(0, this.limits.maxChars)}\n...[truncated]`,
      truncated: true,
    };
  }

  private messagesResult(messages: PopulatedMessage[]): ContextToolResult {
    const formatted = messages.map((message) => this.formatMessage(message));
    const totalChars = formatted.reduce(
      (sum, message) => sum + message.length,
      0,
    );

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
      messages: messages.map((message) => {
        const reactions = message.reactions
          ?.map((reaction) => reaction.emoji ?? reaction.customEmojiId)
          .filter((reaction): reaction is string => !!reaction);
        const result: ContextToolMessageResult = {
          id: message.telegramId,
          from: message.user?.username ?? message.user?.firstName ?? 'unknown',
          userTelegramId: message.userTelegramId,
          text: message.text,
          context: message.context,
          sentAt: message.sentAt,
          replyToMessageId: message.replyToMessageTelegramId,
        };

        if (message.fileName) result.fileName = message.fileName;
        if (message.messageType && message.messageType !== 'text') {
          result.messageType = message.messageType;
        }
        if (message.replyQuoteText)
          result.replyQuoteText = message.replyQuoteText;
        if (reactions?.length) result.reactions = reactions;

        return result;
      }),
    };
  }

  private formatMessage(message: PopulatedMessage): string {
    const author =
      message.user?.username ?? message.user?.firstName ?? 'unknown';
    return `${message.sentAt.toISOString()} | ${author}: ${
      message.text ?? '[non-text content]'
    }${message.context ? `\nContext: ${message.context}` : ''}`;
  }
}
