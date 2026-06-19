import { Bot, Context, GrammyError, HttpError, session } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import { hydrate, HydrateFlavor } from '@grammyjs/hydrate';
import { parseMode } from '@grammyjs/parse-mode';
import { run, sequentialize, type RunnerHandle } from '@grammyjs/runner';
import { MongoDBAdapter } from '@grammyjs/storage-mongodb';
import { apiThrottler } from '@grammyjs/transformer-throttler';
import { config } from '../common/config.js';
import logger from '../common/logger.js';
import { database } from '../database/index.js';
import { AiService } from './ai.service.js';
import { databaseConnection } from '../database/connection.js';
import { MessageOriginUser, Message as TelegramMessage } from 'grammy/types';
import { MessageReaction } from '../database/models/Message.js';
import { API_CONSTANTS } from 'grammy';
import { markdownToTelegramHtml } from '../utils/markdown-to-telegram-html.js';
import { MESSAGE_TYPE } from '../common/message-types.js';
import { getStartMessage } from '../common/start-message.js';
import { AgentResponseService } from './agent-response.service.js';
import { AiClient } from './ai-client.service.js';
import { ContextToolService } from './context-tool.service.js';
import { RawTelegramApiClient } from './raw-telegram-api-client.service.js';
import { SearxngSearchService } from './searxng-search.service.js';
import { CodexAiClient } from './codex-ai-client.service.js';
import { CodexOAuthService } from './codex-oauth.service.js';
import { CodexTelegramCommandService } from './codex-telegram-command.service.js';
import {
  buildTelegramPollContext,
  deriveTelegramMessageContent,
} from './message-ingestion.service.js';
import {
  MediaContextService,
  selectTelegramMedia,
} from './media-context.service.js';
import { LocalMediaProcessor } from './local-media-processor.service.js';

interface SessionData {
  messageCount: number;
  lastAmbientAt?: number;
  sinceAmbientCount: number;
}

type MyContext = HydrateFlavor<Context & { session: SessionData }>;

export const mergeMessageContexts = (
  existing: string | undefined,
  incoming: string | undefined,
): string | undefined => {
  const parts = [existing, incoming]
    .map((part) => part?.trim())
    .filter((part): part is string => !!part);

  return parts.length > 0 ? parts.join('\n\n') : undefined;
};

export const hasAmbientTextOrMediaContext = (
  message: TelegramMessage,
  currentContext?: string,
): boolean => {
  const { text, messageType } = deriveTelegramMessageContent(message);
  const messageText = text ?? '';
  const isAmbientMedia = selectTelegramMedia(message) !== null;

  if (isAmbientMedia) return !!currentContext?.trim();
  return !!messageText && messageType === MESSAGE_TYPE.TEXT;
};

export class TelegramBotService {
  private readonly bot: Bot<MyContext>;
  private readonly aiClient: AiClient;
  private readonly aiService: AiService;
  private readonly codexOAuthService: CodexOAuthService;
  private readonly codexCommandService: CodexTelegramCommandService;
  private readonly contextToolService: ContextToolService;
  private readonly agentResponseService: AgentResponseService;
  private readonly mediaContextService: MediaContextService;
  private runnerHandle?: RunnerHandle;
  private botUsername: string = '';

  constructor() {
    this.bot = new Bot(config.telegram.apiKey);
    this.codexOAuthService = new CodexOAuthService();
    this.codexCommandService = new CodexTelegramCommandService(
      this.codexOAuthService,
    );
    this.aiClient = new AiClient(
      undefined,
      {},
      new CodexAiClient(this.codexOAuthService),
    );
    this.aiService = new AiService(this.aiClient);
    this.contextToolService = new ContextToolService(
      database,
      this.aiService,
      config.agent.context,
    );
    this.mediaContextService = new MediaContextService(
      new LocalMediaProcessor(),
      this.aiService,
      {
        maxVideoFrames: config.media.maxVideoFrames,
        maxTranscriptChars: config.media.maxTranscriptChars,
      },
    );
    this.agentResponseService = new AgentResponseService(
      this.aiClient,
      this.contextToolService,
      new RawTelegramApiClient(config.telegram.apiKey),
      new SearxngSearchService(config.searxng),
    );
    this.setupMiddleware();
    this.setupHandlers();
  }

  private async setupMiddleware(): Promise<void> {
    this.bot.api.config.use(autoRetry());

    this.bot.api.config.use(apiThrottler());

    this.bot.use(hydrate());

    this.bot.api.config.use(parseMode('HTML'));

    this.bot.use(
      sequentialize((ctx) =>
        typeof ctx.chat?.id === 'number' ? String(ctx.chat.id) : undefined,
      ),
    );

    const adapter = new MongoDBAdapter({
      collection: databaseConnection.getDb().collection('sessions'),
    });

    this.bot.use(
      session({
        initial: (): SessionData => ({ messageCount: 0, sinceAmbientCount: 0 }),
        storage: adapter,
      }),
    );

    this.bot.catch((err) => {
      const ctx = err.ctx;
      logger.error(
        {
          error: err.error,
          chatId: ctx.chat?.id,
          userId: ctx.from?.id,
          updateType: ctx.update,
        },
        'Bot error occurred',
      );

      if (err.error instanceof GrammyError) {
        logger.error(err.error.description, 'Error in request');
      } else if (err.error instanceof HttpError) {
        logger.error(err.error, 'Could not contact Telegram');
      } else {
        logger.error(err.error, 'Unknown error');
      }
    });

    this.bot.use(async (ctx, next) => {
      const start = Date.now();

      logger.info(
        {
          updateType: ctx.update.message ? 'message' : 'other',
          chatId: ctx.chat?.id,
          userId: ctx.from?.id,
          username: ctx.from?.username,
          chatType: ctx.chat?.type,
        },
        'Processing update',
      );

      await next();

      const duration = Date.now() - start;
      logger.info({ duration }, 'Update processed');
    });
  }

  private setupHandlers(): void {
    this.bot.command('start', async (ctx) => {
      if (ctx.chat?.type !== 'private') {
        return;
      }

      const startMessage = [getStartMessage(this.botUsername)];
      const codexStartMessage = this.codexCommandService.getStartMessage(ctx);
      if (codexStartMessage) {
        startMessage.push(codexStartMessage);
      }

      await ctx.reply(startMessage.join('\n'));
    });

    this.codexCommandService.register(this.bot);

    // --- Admin-only commands (private chats only) ---
    this.bot.command('stats', async (ctx) => {
      if (ctx.chat?.type !== 'private') return;
      if (!ctx.from || !config.telegram.adminIds.includes(ctx.from.id)) return;

      try {
        const messageModel = database.getMessageModel();
        const totalMessages = await messageModel.countAllMessages();
        const byChat = await messageModel.getMessageCountsByChat();

        const uniqueChats = byChat.length;
        const lines = byChat
          .slice(0, 20)
          .map((c, idx) => `${idx + 1}. ${c.chatTelegramId}: ${c.count}`)
          .join('\n');

        const text = [
          '<b>Stats</b>',
          `• <b>Total messages:</b> ${totalMessages}`,
          `• <b>Chats tracked:</b> ${uniqueChats}`,
          byChat.length > 0 ? '<b>Top chats by message count:</b>' : '',
          byChat.length > 0 ? `<pre>${lines}</pre>` : '<i>No chats yet</i>',
        ]
          .filter(Boolean)
          .join('\n');

        await ctx.reply(text);
      } catch (error) {
        logger.error(error, 'Failed to compute /stats');
        await ctx.reply('Failed to compute stats.');
      }
    });

    this.bot.command('say', async (ctx) => {
      if (ctx.chat?.type !== 'private') return;
      if (!ctx.from || !config.telegram.adminIds.includes(ctx.from.id)) return;

      const fullText = ctx.message?.text || '';
      const rest = fullText.replace(/^\/(say)(?:@[^\s]+)?\s*/i, '');
      const match = rest.match(/^(-?\d+)\s+([\s\S]+)$/);
      if (!match) {
        await ctx.reply('Usage: /say <chatTelegramId> <text>');
        return;
      }
      const chatId = Number(match[1]);
      if (!Number.isFinite(chatId)) {
        await ctx.reply('Invalid chatTelegramId');
        return;
      }
      const textToSend = match[2].trim();
      if (textToSend.length === 0) {
        await ctx.reply('Text cannot be empty');
        return;
      }

      try {
        const html = markdownToTelegramHtml(textToSend);
        const sent = await ctx.api.sendMessage(chatId, html);

        const messageModel = database.getMessageModel();
        await messageModel.saveMessage({
          telegramId: sent.message_id,
          chatTelegramId: chatId,
          userTelegramId: this.bot.botInfo.id,
          text: textToSend,
          sentAt: new Date(sent.date * 1000),
          messageType: 'text',
          payload: JSON.parse(JSON.stringify(sent)),
        });

        await ctx.reply(`Sent to chat ${chatId} (message ${sent.message_id}).`);
      } catch (error) {
        logger.error({ error, rest }, 'Failed to execute /say');
        await ctx.reply('Failed to send message.');
      }
    });

    this.bot.command('reply', async (ctx) => {
      if (ctx.chat?.type !== 'private') return;
      if (!ctx.from || !config.telegram.adminIds.includes(ctx.from.id)) return;

      const fullText = ctx.message?.text || '';
      const rest = fullText.replace(/^\/(reply)(?:@[^\s]+)?\s*/i, '');
      const match = rest.match(/^([A-Fa-f0-9]{24})\s+([\s\S]+)$/);
      if (!match) {
        await ctx.reply('Usage: /reply <dbMessageId> <text>');
        return;
      }
      const dbId = match[1];
      const textToSend = match[2].trim();
      if (textToSend.length === 0) {
        await ctx.reply('Text cannot be empty');
        return;
      }

      try {
        const messageModel = database.getMessageModel();
        const original = await messageModel.findByDbId(dbId);
        if (!original) {
          await ctx.reply('Message not found by provided DB id.');
          return;
        }

        const html = markdownToTelegramHtml(textToSend);
        const sent = await ctx.api.sendMessage(original.chatTelegramId, html, {
          reply_to_message_id: original.telegramId,
        });

        await messageModel.saveMessage({
          telegramId: sent.message_id,
          chatTelegramId: original.chatTelegramId,
          userTelegramId: this.bot.botInfo.id,
          text: textToSend,
          replyToMessageTelegramId: original.telegramId,
          sentAt: new Date(sent.date * 1000),
          messageType: 'text',
          payload: JSON.parse(JSON.stringify(sent)),
        });

        await ctx.reply(
          `Replied in chat ${original.chatTelegramId} to message ${original.telegramId}.`,
        );
      } catch (error) {
        logger.error({ error, rest }, 'Failed to execute /reply');
        await ctx.reply('Failed to reply.');
      }
    });

    this.bot.on('message', async (ctx) => {
      if (
        !ctx.chat ||
        (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup')
      ) {
        return;
      }

      try {
        await this.handleMessage(ctx);
      } catch (error) {
        logger.error(error, 'Error handling message');
      }
    });

    this.bot.on('edited_message', async (ctx) => {
      if (
        !ctx.chat ||
        (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup')
      ) {
        return;
      }

      try {
        await this.handleMessageEdit(ctx);
      } catch (error) {
        logger.error(
          { error, chatId: ctx.chat.id },
          'Error handling message edit',
        );
      }
    });

    this.bot.on('message_reaction', async (ctx) => {
      if (
        !ctx.chat ||
        (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup')
      ) {
        return;
      }

      try {
        await this.handleMessageReaction(ctx);
      } catch (error) {
        logger.error(
          { error, chatId: ctx.chat.id },
          'Error handling message reaction',
        );
      }
    });
  }

  private async ensureSummaries(chatId: number): Promise<void> {
    const messageModel = database.getMessageModel();
    const summaryModel = database.getSummaryModel();

    logger.info({ chatId }, 'Ensuring summaries start');

    // Level 0: summarize every 200 messages into one summary block
    const totalMessages = await messageModel.countMessages(chatId);
    const existingLevel0Count = await summaryModel.getCount(chatId, 0);
    const requiredLevel0Blocks = Math.floor(totalMessages / 200);

    for (let i = existingLevel0Count; i < requiredLevel0Blocks; i++) {
      logger.info(
        { chatId, level: 0, index: i },
        'Preparing level-0 batch summarization',
      );
      const batch = await messageModel.getMessagesAscending(
        chatId,
        i * 200,
        200,
      );
      if (batch.length === 0) break;
      const labeled = batch.map((msg, idx) => {
        const n = 200 - idx;
        const label = `${n}..${n - 1 >= 1 ? n - 1 : 1}`;
        const user =
          msg.user?.username || `${msg.user?.firstName || 'Unknown'}`;
        const text = [msg.text || '[non-text content]', msg.context?.trim()]
          .filter(Boolean)
          .join('\nContext: ');
        const ts = new Date(msg.sentAt).toISOString();
        return `${label} | ${ts} | ${user}: ${text}`;
      });
      const instruction =
        'Summarize the following 200 chronological chat messages into a compact, information-dense paragraph or two. Include main topics, key decisions, answers, and unresolved questions. Keep most relevant names. Avoid quoting unless essential.';
      logger.info(
        {
          chatId,
          level: 0,
          index: i,
          labeledPreview: labeled[0]?.slice(0, 160),
        },
        'Invoking summarizeText for level-0',
      );
      const summary = await this.aiService.summarizeText(labeled, instruction);

      await summaryModel.upsertSummary({
        chatTelegramId: chatId,
        level: 0,
        index: i,
        summary,
        startSentAt: batch[0]?.sentAt,
        endSentAt: batch[batch.length - 1]?.sentAt,
      });
      logger.info(
        { chatId, level: 0, index: i },
        'Created level-0 batch summary',
      );
    }

    // Higher levels: every 200 summaries collapse into one higher-level summary
    let level = 1;
    while (true) {
      const lowerLevel = level - 1;
      const lowerCount = await summaryModel.getCount(chatId, lowerLevel);
      if (lowerCount < 200) break;

      const existingHigherCount = await summaryModel.getCount(chatId, level);
      const requiredHigherBlocks = Math.floor(lowerCount / 200);

      for (let i = existingHigherCount; i < requiredHigherBlocks; i++) {
        logger.info(
          { chatId, level, index: i },
          'Preparing higher-level summarization',
        );
        const range = await summaryModel.getRangeByLevelAscending(
          chatId,
          lowerLevel,
          i * 200,
          200,
        );
        if (range.length === 0) break;
        const labeled = range.map((s, idx) => `Block ${idx + 1}: ${s.summary}`);
        const instruction =
          'Summarize these 200 summaries into a compact overview that preserves chronology and the most critical developments, decisions, conclusions, and ongoing threads. Keep it brief yet comprehensive.';
        logger.info(
          {
            chatId,
            level,
            index: i,
            labeledFirstPreview: labeled[0]?.slice(0, 160),
          },
          'Invoking summarizeText for higher level',
        );
        const summary = await this.aiService.summarizeText(
          labeled,
          instruction,
        );

        await summaryModel.upsertSummary({
          chatTelegramId: chatId,
          level,
          index: i,
          summary,
          startSentAt: range[0]?.startSentAt,
          endSentAt: range[range.length - 1]?.endSentAt,
        });
        logger.info(
          { chatId, level, index: i },
          'Created higher-level summary',
        );
      }

      level += 1;
    }

    logger.info({ chatId }, 'Ensuring summaries complete');
  }

  private async handleMessage(ctx: MyContext): Promise<void> {
    const message = ctx.message;

    if (!message || !ctx.from || !ctx.chat) {
      logger.warn({ message, ctx }, 'Skipping message handling');
      return;
    }

    // Track message counters for ambient gating
    ctx.session.messageCount = (ctx.session.messageCount || 0) + 1;
    ctx.session.sinceAmbientCount = (ctx.session.sinceAmbientCount || 0) + 1;

    const userModel = database.getTelegramUserModel();
    await userModel.upsertUser({
      telegramId: ctx.from.id,
      username: ctx.from.username,
      firstName: ctx.from.first_name,
      lastName: ctx.from.last_name,
      isBot: ctx.from.is_bot,
      isPremium: ctx.from.is_premium,
      languageCode: ctx.from.language_code,
    });

    const messageModel = database.getMessageModel();
    const quote = message.quote;

    const derived = deriveTelegramMessageContent(message);
    // Build extra context for special message types (e.g., poll)
    let extraContext: string | undefined;
    if (message.poll) {
      extraContext = buildTelegramPollContext(message.poll);
    }

    await messageModel.saveMessage({
      telegramId: message.message_id,
      chatTelegramId: ctx.chat.id,
      userTelegramId: ctx.from.id,
      text: derived.text,
      context: extraContext,
      fileName: derived.fileName,
      replyToMessageTelegramId: message.reply_to_message?.message_id,
      replyQuoteText: quote?.text,
      sentAt: new Date(message.date * 1000),
      messageType: derived.messageType,
      forwardOrigin: message.forward_origin,
      forwardFromUserTelegramId: (message.forward_origin as MessageOriginUser)
        ?.sender_user?.id,
      payload: JSON.parse(JSON.stringify(ctx)),
    });

    let storedContext = extraContext;

    try {
      const mediaContext = await this.mediaContextService.buildContext(
        message,
        ctx.api,
      );
      storedContext = mergeMessageContexts(extraContext, mediaContext);

      if (storedContext && storedContext !== extraContext) {
        await messageModel.updateMessageContext(
          message.message_id,
          ctx.chat.id,
          storedContext,
        );
        logger.info(
          {
            chatId: ctx.chat.id,
            messageId: message.message_id,
            contextLength: storedContext.length,
          },
          'Stored Telegram media context in DB',
        );
      }
    } catch (error) {
      logger.error(error, 'Failed to build and store Telegram media context');
    }

    const chatId = ctx.chat.id;

    // Trigger background summarization maintenance after final message context is persisted.
    this.ensureSummaries(chatId).catch((error) =>
      logger.error({ error, chatId }, 'Failed to maintain summaries'),
    );

    if (this.shouldRespond(message, ctx.from.id)) {
      await this.generateAndSendResponse(ctx, message);
      return;
    }

    // Try ambient interjection (non-mention, non-reply) with strong gating
    await this.maybeAmbientInterject(ctx, message, storedContext).catch((e) =>
      logger.error(e, 'Ambient interjection failed'),
    );
  }

  private async handleMessageEdit(ctx: MyContext): Promise<void> {
    const editedMessage = ctx.editedMessage;

    if (!editedMessage || !ctx.chat) {
      return;
    }

    const messageModel = database.getMessageModel();

    try {
      if (!editedMessage.text) {
        return;
      }

      await messageModel.editMessage(
        editedMessage.message_id,
        ctx.chat.id,
        editedMessage.text,
      );

      logger.info(
        {
          messageId: editedMessage.message_id,
          chatId: ctx.chat.id,
        },
        'Message edit tracked',
      );
    } catch (error) {
      logger.error(error, 'Failed to track message edit');
    }
  }

  private async handleMessageReaction(ctx: MyContext): Promise<void> {
    const messageReaction = ctx.messageReaction;

    if (!messageReaction || !ctx.from || !ctx.chat) {
      return;
    }

    logger.info(
      {
        messageId: messageReaction.message_id,
        chatId: ctx.chat.id,
        userId: ctx.from.id,
        chatType: ctx.chat.type,
      },
      'Message reaction received',
    );

    const messageModel = database.getMessageModel();

    try {
      const { emojiAdded, emojiRemoved, customEmojiAdded, customEmojiRemoved } =
        ctx.reactions();

      logger.info(
        {
          emojiAdded,
          emojiRemoved,
          customEmojiAdded,
          customEmojiRemoved,
        },
        'Reaction changes detected',
      );

      type ReactionData = Omit<MessageReaction, 'userTelegramId' | 'addedAt'>;

      const addedReactions: ReactionData[] = [
        ...emojiAdded.map((emoji) => ({ emoji })),
        ...customEmojiAdded.map((customEmojiId) => ({
          customEmojiId,
        })),
      ];

      const removedReactions: ReactionData[] = [
        ...emojiRemoved.map((emoji) => ({ emoji })),
        ...customEmojiRemoved.map((customEmojiId) => ({
          customEmojiId,
        })),
      ];

      await messageModel.updateReactions(
        messageReaction.message_id,
        ctx.chat.id,
        ctx.from.id,
        addedReactions,
        removedReactions,
      );

      logger.info(
        {
          messageId: messageReaction.message_id,
          chatId: ctx.chat.id,
          userId: ctx.from.id,
          addedCount: addedReactions.length,
          removedCount: removedReactions.length,
        },
        'Message reaction tracked successfully',
      );
    } catch (error) {
      logger.error(error, 'Failed to track message reaction');
    }
  }

  // A loop-capable peer is a genuine bot account posting as itself: replying to
  // it could spark an infinite bot-to-bot loop (Bot API 10.0). Anonymous admins
  // and channel senders carry `sender_chat` and are humans/channels behind the
  // scenes, so they are allowed through.
  private isLoopCapableBot(message: TelegramMessage): boolean {
    return !!message.from?.is_bot && !message.sender_chat;
  }

  private shouldRespond(message: TelegramMessage, fromUserId: number): boolean {
    if (fromUserId === this.bot.botInfo.id) {
      return false;
    }

    if (this.isLoopCapableBot(message)) {
      return false;
    }

    const { text } = deriveTelegramMessageContent(message);

    if (text && text.includes(`@${this.botUsername}`)) {
      return true;
    }

    return !!(
      message.reply_to_message &&
      message.reply_to_message.from?.id === this.bot.botInfo.id
    );
  }

  private shouldTryAmbient(
    ctx: MyContext,
    message: TelegramMessage,
    currentContext?: string,
  ): boolean {
    const cfg = config.telegram.ambient;
    if (!cfg.enabled) return false;

    if (message.from?.id === this.bot.botInfo.id) return false;

    if (this.isLoopCapableBot(message)) return false;

    const { text } = deriveTelegramMessageContent(message);
    const messageText = text ?? '';

    if (!hasAmbientTextOrMediaContext(message, currentContext)) return false;

    // Skip if directly mentions or replies to the bot (handled elsewhere)
    if (messageText.includes(`@${this.botUsername}`)) return false;
    if (message.reply_to_message?.from?.id === this.bot.botInfo.id)
      return false;

    // Cooldowns
    const now = Date.now();
    const lastAt = ctx.session.lastAmbientAt || 0;
    const sinceSec = (now - lastAt) / 1000;
    if (sinceSec < cfg.minCooldownSec) {
      logger.info(
        { sinceSec, minCooldownSec: cfg.minCooldownSec, chatId: ctx.chat?.id },
        'Ambient gate: cooldown not satisfied',
      );
      return false;
    }

    const sinceMsgs = ctx.session.sinceAmbientCount || 0;
    if (sinceMsgs < cfg.minGapMessages) {
      logger.info(
        { sinceMsgs, minGapMessages: cfg.minGapMessages, chatId: ctx.chat?.id },
        'Ambient gate: message gap not satisfied',
      );
      return false;
    }

    // Probability gate
    const roll = Math.random();
    if (roll >= cfg.probability) {
      logger.info(
        { roll, probability: cfg.probability, chatId: ctx.chat?.id },
        'Ambient gate: probability not passed',
      );
      return false;
    }

    return true;
  }

  private async maybeAmbientInterject(
    ctx: MyContext,
    triggerMessage: TelegramMessage,
    currentContext?: string,
  ): Promise<void> {
    if (!this.shouldTryAmbient(ctx, triggerMessage, currentContext)) return;

    const chatId = ctx.chat!.id;
    const messageModel = database.getMessageModel();

    // Fetch recent messages, then filter by recency window
    const recent = await messageModel.getRecentMessages(chatId, 120);
    logger.info(
      { chatId, fetchedCount: recent.length },
      'Ambient: fetched recent messages',
    );
    const maxAgeMin = config.telegram.ambient.maxContextAgeMinutes;
    const cutoff = Date.now() - maxAgeMin * 60 * 1000;
    const recentFresh = recent.filter(
      (m) => new Date(m.sentAt).getTime() >= cutoff,
    );
    const context = recentFresh.length > 0 ? recentFresh : recent.slice(0, 30);
    logger.info(
      {
        chatId,
        contextCount: context.length,
        maxAgeMin,
        cutoffIso: new Date(cutoff).toISOString(),
        newestIso: context[0]?.sentAt,
        oldestIso: context[context.length - 1]?.sentAt,
      },
      'Ambient: prepared context window',
    );

    await ctx.replyWithChatAction('typing');
    const ambient = await this.aiService.generateAmbientInterjection(
      context,
      this.botUsername,
    );

    if (!ambient) {
      logger.info(
        { chatId, triggerId: triggerMessage.message_id },
        'Ambient: model abstained',
      );
      return;
    }

    const html = markdownToTelegramHtml(ambient);
    const sent = await ctx.api.sendMessage(chatId, html);

    await messageModel.saveMessage({
      telegramId: sent.message_id,
      chatTelegramId: chatId,
      userTelegramId: this.bot.botInfo.id,
      text: ambient,
      replyToMessageTelegramId: undefined,
      sentAt: new Date(sent.date * 1000),
      messageType: 'text',
      payload: JSON.parse(JSON.stringify(sent)),
    });

    ctx.session.lastAmbientAt = Date.now();
    ctx.session.sinceAmbientCount = 0;

    logger.info(
      {
        chatId,
        triggerMessageId: triggerMessage.message_id,
        botMessageId: sent.message_id,
        textPreview: ambient.slice(0, 160),
      },
      'Ambient interjection sent',
    );
  }

  private async generateAndSendResponse(
    ctx: MyContext,
    triggerMessage: TelegramMessage,
  ): Promise<void> {
    const chatId = ctx.chat!.id;

    try {
      const derived = deriveTelegramMessageContent(triggerMessage);
      const agentResult = await this.agentResponseService.generateAndSend({
        api: ctx.api,
        chatTelegramId: chatId,
        triggerMessageId: triggerMessage.message_id,
        triggerText: derived.text,
        botUsername: this.botUsername,
        botUserTelegramId: this.bot.botInfo.id,
      });

      logger.info(
        {
          chatId,
          triggerMessageId: triggerMessage.message_id,
          status: agentResult.status,
          toolsUsed: agentResult.toolsUsed,
        },
        'AI response sent and saved successfully',
      );
    } catch (error) {
      logger.error(error, 'Failed to generate or send AI response');

      try {
        const errorMessage = await ctx.reply(
          'Sorry, I encountered an error while generating a response. Please try again later.',
          { reply_to_message_id: triggerMessage.message_id },
        );

        const messageModel = database.getMessageModel();
        await messageModel.saveMessage({
          telegramId: errorMessage.message_id,
          chatTelegramId: chatId,
          userTelegramId: this.bot.botInfo.id,
          text: errorMessage.text,
          replyToMessageTelegramId: triggerMessage.message_id,
          sentAt: new Date(errorMessage.date * 1000),
          messageType: 'text',
          payload: JSON.parse(JSON.stringify(errorMessage)),
        });
      } catch (sendError) {
        logger.error(sendError, 'Failed to send or save error message');
      }
    }
  }

  async start(): Promise<void> {
    const botInfo = await this.bot.api.getMe();
    this.botUsername = botInfo.username || '';

    logger.info(
      {
        botId: botInfo.id,
        botUsername: this.botUsername,
        botName: botInfo.first_name,
      },
      'Bot info retrieved',
    );

    await this.saveBotUserProfile(botInfo);

    if (config.telegram.mode === 'webhook') {
      logger.info('Starting bot in webhook mode');
      return;
    } else {
      logger.info('Starting bot in polling mode');

      this.runnerHandle = run(this.bot, {
        runner: {
          fetch: {
            allowed_updates: API_CONSTANTS.ALL_UPDATE_TYPES,
          },
        },
      });
    }
  }

  async stop(): Promise<void> {
    logger.info('Stopping Telegram bot service');

    if (config.telegram.mode === 'polling') {
      if (this.runnerHandle) {
        await this.runnerHandle.stop();
        this.runnerHandle = undefined;
      } else {
        this.bot.stop();
      }
    }
  }

  getBot(): Bot<MyContext> {
    return this.bot;
  }

  getBotUsername(): string {
    return this.botUsername;
  }

  private async saveBotUserProfile(botInfo: any): Promise<void> {
    try {
      const userModel = database.getTelegramUserModel();
      await userModel.upsertUser({
        telegramId: botInfo.id,
        username: botInfo.username,
        firstName: botInfo.first_name,
        lastName: botInfo.last_name,
        isBot: true,
        isPremium: false,
        languageCode: botInfo.language_code || null,
      });

      logger.info(
        { botId: botInfo.id, botUsername: botInfo.username },
        'Bot user profile saved to database',
      );
    } catch (error) {
      logger.error(error, 'Failed to save bot user profile to database');
    }
  }
}
