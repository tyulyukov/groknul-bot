import { config } from '../common/config.js';
import logger from '../common/logger.js';
import { database } from '../database/index.js';
import { AgentRunner } from './agent-runner.service.js';
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
    const agentResult = await runner.run({
      chatTelegramId: input.chatTelegramId,
      triggerMessageId: input.triggerMessageId,
      botUsername: input.botUsername,
      triggerText: input.triggerText,
      chatMemories,
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
}
