import { config } from '../common/config.js';
import logger from '../common/logger.js';
import { database } from '../database/index.js';
import {
  AgentRunner,
  type AgentReplyContextMessage,
} from './agent-runner.service.js';
import type { AiClient } from './ai-client.service.js';
import type {
  ContextToolResult,
  ContextToolService,
} from './context-tool.service.js';
import type { RawTelegramApiClient } from './raw-telegram-api-client.service.js';
import type { SearxngSearchService } from './searxng-search.service.js';
import {
  TelegramRichDeliveryService,
  type TelegramApiLike,
} from './telegram-rich-delivery.service.js';
import {
  TelegramToolRegistry,
  type TelegramActionApi,
} from './telegram-tool-registry.service.js';

export interface AgentResponseInput {
  api: TelegramApiLike;
  chatTelegramId: number;
  triggerMessageId: number;
  triggerText?: string;
  botUsername: string;
  botUserTelegramId: number;
}

export interface AgentResponseResult {
  status:
    | 'sent'
    | 'final'
    | 'reacted'
    | 'ignored'
    | 'tool_limit_reached'
    | 'fallback'
    | 'skipped';
  toolsUsed: string[];
}

export const extractMemoryTexts = (result: ContextToolResult): string[] => {
  if (result.status !== 'ok' || !Array.isArray(result.memories)) return [];

  return result.memories
    .map((memory) => {
      if (!memory || typeof memory !== 'object') return null;
      const text = (memory as { text?: unknown }).text;
      return typeof text === 'string' ? text.trim() : null;
    })
    .filter((text): text is string => !!text)
    .map((text) => text.slice(0, 500));
};

export const extractReplyContextMessages = (
  result: ContextToolResult,
): AgentReplyContextMessage[] => {
  if (result.status !== 'ok' || !Array.isArray(result.messages)) return [];

  const messages = result.messages
    .map((message) => {
      if (!message || typeof message !== 'object') return null;
      const raw = message as Record<string, unknown>;
      const id = typeof raw.id === 'number' ? raw.id : undefined;
      if (typeof id !== 'number') return null;

      const normalized: AgentReplyContextMessage = { id };
      const from = stringField(raw.from);
      const userTelegramId = numberField(raw.userTelegramId);
      const text = stringField(raw.text, 1_000);
      const context = stringField(raw.context, 1_000);
      const fileName = stringField(raw.fileName);
      const messageType = stringField(raw.messageType);
      const sentAt = dateField(raw.sentAt);
      const replyToMessageId = numberField(raw.replyToMessageId);
      const replyQuoteText = stringField(raw.replyQuoteText, 1_000);
      const reactions = stringArrayField(raw.reactions);

      if (from) normalized.from = from;
      if (typeof userTelegramId === 'number') {
        normalized.userTelegramId = userTelegramId;
      }
      if (text) normalized.text = text;
      if (context) normalized.context = context;
      if (fileName) normalized.fileName = fileName;
      if (messageType) normalized.messageType = messageType;
      if (sentAt) normalized.sentAt = sentAt;
      if (typeof replyToMessageId === 'number') {
        normalized.replyToMessageId = replyToMessageId;
      }
      if (replyQuoteText) normalized.replyQuoteText = replyQuoteText;
      if (reactions.length > 0) normalized.reactions = reactions;

      return normalized;
    })
    .filter((message): message is AgentReplyContextMessage => message !== null);

  return messages.length > 1 ? messages.slice(0, 5) : [];
};

export const extractCurrentMessageDetails = (
  message: unknown,
): AgentReplyContextMessage | undefined => {
  if (!message || typeof message !== 'object') return undefined;
  const raw = message as Record<string, unknown>;
  const id = numberField(raw.telegramId);
  if (typeof id !== 'number') return undefined;

  const normalized: AgentReplyContextMessage = { id };
  const user = raw.user && typeof raw.user === 'object'
    ? (raw.user as Record<string, unknown>)
    : undefined;
  const from =
    stringField(user?.username) ??
    stringField(user?.firstName) ??
    stringField(raw.from);
  const userTelegramId = numberField(raw.userTelegramId);
  const text = stringField(raw.text, 1_000);
  const context = stringField(raw.context, 1_000);
  const fileName = stringField(raw.fileName);
  const messageType = stringField(raw.messageType);
  const sentAt = dateField(raw.sentAt);
  const replyToMessageId = numberField(raw.replyToMessageTelegramId);
  const replyQuoteText = stringField(raw.replyQuoteText, 1_000);
  const reactions = Array.isArray(raw.reactions)
    ? raw.reactions
        .map((reaction) => {
          if (!reaction || typeof reaction !== 'object') return null;
          const reactionRaw = reaction as Record<string, unknown>;
          return (
            stringField(reactionRaw.emoji) ??
            stringField(reactionRaw.customEmojiId)
          );
        })
        .filter((reaction): reaction is string => !!reaction)
    : [];

  if (from) normalized.from = from;
  if (typeof userTelegramId === 'number') normalized.userTelegramId = userTelegramId;
  if (text) normalized.text = text;
  if (context) normalized.context = context;
  if (fileName) normalized.fileName = fileName;
  if (messageType) normalized.messageType = messageType;
  if (sentAt) normalized.sentAt = sentAt;
  if (typeof replyToMessageId === 'number') {
    normalized.replyToMessageId = replyToMessageId;
  }
  if (replyQuoteText) normalized.replyQuoteText = replyQuoteText;
  if (reactions.length > 0) normalized.reactions = reactions;

  return normalized;
};

const stringField = (value: unknown, maxLength = 200): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text ? text.slice(0, maxLength) : undefined;
};

const stringArrayField = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .map((item) => stringField(item))
        .filter((item): item is string => !!item)
    : [];

const numberField = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const dateField = (value: unknown): string | undefined => {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }

  if (typeof value !== 'string') return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
};

export class AgentResponseService {
  constructor(
    private readonly aiClient: AiClient,
    private readonly contextToolService: ContextToolService,
    private readonly rawTelegramApiClient: RawTelegramApiClient,
    private readonly searxngSearchService: SearxngSearchService,
  ) {}

  async generateAndSend(
    input: AgentResponseInput & { api: TelegramApiLike & TelegramActionApi },
  ): Promise<AgentResponseResult> {
    const messageModel = database.getMessageModel();
    const dbTriggerMessage = await messageModel.findByMessageTelegramId(
      input.triggerMessageId,
      input.chatTelegramId,
    );

    if (!dbTriggerMessage) {
      logger.error(
        {
          chatId: input.chatTelegramId,
          triggerMessageId: input.triggerMessageId,
        },
        'Trigger message not found in database',
      );
      return { status: 'skipped', toolsUsed: [] };
    }

    const delivery = new TelegramRichDeliveryService(
      input.api,
      this.rawTelegramApiClient,
      messageModel,
      input.botUserTelegramId,
    );
    const registry = new TelegramToolRegistry({
      chatTelegramId: input.chatTelegramId,
      botUserTelegramId: input.botUserTelegramId,
      triggerUserTelegramId: dbTriggerMessage.userTelegramId,
      api: input.api,
      delivery,
      contextTools: this.contextToolService,
      searchService: this.searxngSearchService,
      messageModel,
    });
    const runner = new AgentRunner(this.aiClient, registry, {
      model: config.openRouter.models.agent,
      maxToolCalls: config.agent.maxToolCalls,
      reasoningEffort: 'low',
    });
    const chatMemories = await this.loadChatMemories(input.chatTelegramId);
    const replyContext = await this.loadReplyContext(
      input.chatTelegramId,
      input.triggerMessageId,
      dbTriggerMessage.replyToMessageTelegramId,
    );
    const agentResult = await runner.run({
      chatTelegramId: input.chatTelegramId,
      triggerMessageId: input.triggerMessageId,
      botUsername: input.botUsername,
      triggerText: input.triggerText,
      chatMemories,
      replyContext,
      currentMessageDetails: extractCurrentMessageDetails(dbTriggerMessage),
    });

    if (
      agentResult.status !== 'sent' &&
      agentResult.status !== 'reacted' &&
      agentResult.status !== 'ignored'
    ) {
      await delivery.send(input.chatTelegramId, {
        items: agentResult.output.items.map((item, index) => ({
          ...item,
          replyToMessageId:
            item.replyToMessageId ??
            (index === 0 ? input.triggerMessageId : undefined),
        })),
      });
    }

    return {
      status: agentResult.status,
      toolsUsed: agentResult.toolsUsed,
    };
  }

  private async loadChatMemories(chatTelegramId: number): Promise<string[]> {
    try {
      const result = await this.contextToolService.searchMemories(
        chatTelegramId,
        {
          limit: Math.min(12, config.agent.context.maxResults),
        },
      );
      const memories = extractMemoryTexts(result);
      logger.info(
        { chatTelegramId, memoriesCount: memories.length },
        'Loaded chat memories for agent context',
      );
      return memories;
    } catch (error) {
      logger.warn(error, 'Failed to preload chat memories for agent context');
      return [];
    }
  }

  private async loadReplyContext(
    chatTelegramId: number,
    triggerMessageId: number,
    replyToMessageId: number | undefined,
  ): Promise<AgentReplyContextMessage[]> {
    if (typeof replyToMessageId !== 'number') return [];

    try {
      const result = await this.contextToolService.getReplyThread(
        chatTelegramId,
        {
          messageId: triggerMessageId,
          limit: 5,
        },
      );
      const replyContext = extractReplyContextMessages(result);
      logger.info(
        { chatTelegramId, triggerMessageId, replyContextCount: replyContext.length },
        'Loaded reply context for agent context',
      );
      return replyContext;
    } catch (error) {
      logger.warn(error, 'Failed to preload reply context for agent context');
      return [];
    }
  }
}
