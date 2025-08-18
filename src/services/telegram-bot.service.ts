import { Bot, Context, GrammyError, HttpError, session } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import { hydrate, HydrateFlavor } from '@grammyjs/hydrate';
import { parseMode } from '@grammyjs/parse-mode';
import { MongoDBAdapter } from '@grammyjs/storage-mongodb';
import { apiThrottler } from '@grammyjs/transformer-throttler';
import { config } from '../common/config.js';
import logger from '../common/logger.js';
import { database } from '../database/index.js';
import { AiService } from './ai.service.js';
import { databaseConnection } from '../database/connection.js';
import {
  MessageOriginUser,
  Message as TelegramMessage,
  Poll as TelegramPoll,
} from 'grammy/types';
import { MessageReaction } from '../database/models/Message.js';
import { API_CONSTANTS } from 'grammy';
import { markdownToTelegramHtml } from '../utils/markdown-to-telegram-html.js';
import { MESSAGE_TYPE, MessageType } from '../common/message-types.js';

interface SessionData {
  messageCount: number;
}

type MyContext = HydrateFlavor<Context & { session: SessionData }>;

export const getStartMessage = (botUsername: string) => `🤖 <b>Groknul Bot</b>

I'm a bold, opinionated, yet helpful group chat assistant that observes conversations and provides informative responses!

<b>How to use me:</b>
• Add me to your group chat
• Mention me (@${botUsername}) in a message or reply to my messages
• I'll respond with contextual information based on recent group conversation

<b>Features:</b>
✨ Context-aware responses using AI
📝 I remember the conversation history
🔄 I track message edits and changes
🎭 I track message reactions (requires admin permissions)
🎯 I only respond when specifically mentioned or replied to
💬 I match your conversation style and language
🧠 I provide detailed information when you ask for it

<b>Note:</b> I only work in group chats, not in private messages.

Have fun chatting! 🚀`;

export class TelegramBotService {
  private readonly bot: Bot<MyContext>;
  private aiService: AiService;
  private botUsername: string = '';

  constructor() {
    this.bot = new Bot(config.telegram.apiKey);
    this.aiService = new AiService();
    this.setupMiddleware();
    this.setupHandlers();
  }

  private async setupMiddleware(): Promise<void> {
    this.bot.api.config.use(autoRetry());

    this.bot.api.config.use(apiThrottler());

    this.bot.use(hydrate());

    this.bot.api.config.use(parseMode('HTML'));

    const adapter = new MongoDBAdapter({
      collection: databaseConnection.getDb().collection('sessions'),
    });

    this.bot.use(
      session({
        initial: (): SessionData => ({ messageCount: 0 }),
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

      await ctx.reply(getStartMessage(this.botUsername));
    });

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
        const text = msg.text || '[non-text content]';
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

    const derived = this.deriveContentFields(message);
    // Build extra context for special message types (e.g., poll)
    let extraContext: string | undefined;
    if (message.poll) {
      extraContext = this.buildPollContext(message.poll);
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

    // Trigger background summarization maintenance
    this.ensureSummaries(ctx.chat!.id).catch((error) =>
      logger.error(
        { error, chatId: ctx.chat!.id },
        'Failed to maintain summaries',
      ),
    );

    // If message contains a photo (or a document that is a photo), analyze it and store concise context
    try {
      const shouldAnalyzePhoto =
        !!message.photo ||
        (message.document && message.document.mime_type?.startsWith('image/'));
      if (shouldAnalyzePhoto) {
        logger.info(
          {
            chatId: ctx.chat.id,
            messageId: message.message_id,
            hasPhoto: !!message.photo,
            hasImageDocument:
              !!message.document &&
              !!message.document.mime_type?.startsWith('image/'),
          },
          'Image content detected; starting summarization',
        );
        // pick only one image: for photo use the largest size; for document use its file_id
        let selectedFileId: string | null = null;
        if (message.photo && message.photo.length > 0) {
          const largestPhoto = message.photo[message.photo.length - 1];
          selectedFileId = largestPhoto.file_id;
        } else if (
          message.document &&
          message.document.mime_type?.startsWith('image/')
        ) {
          selectedFileId = message.document.file_id;
        }

        if (selectedFileId) {
          try {
            const file = await ctx.api.getFile(selectedFileId);
            if (file.file_path) {
              const url = `https://api.telegram.org/file/bot${config.telegram.apiKey}/${file.file_path}`;
              // Determine MIME type based on Telegram metadata: documents have mime_type; photos default to JPEG
              const mimeType = message.document?.mime_type?.startsWith('image/')
                ? message.document.mime_type
                : 'image/jpeg';

              // Download the image and convert to base64 data URL
              logger.info(
                {
                  chatId: ctx.chat.id,
                  messageId: message.message_id,
                  filePath: file.file_path,
                  mimeType,
                },
                'Downloading image for analysis',
              );
              const resp = await fetch(url);
              if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
              const arrayBuffer = await resp.arrayBuffer();
              const base64 = Buffer.from(arrayBuffer).toString('base64');
              const dataUrl = `data:${mimeType};base64,${base64}`;

              logger.info(
                {
                  chatId: ctx.chat.id,
                  messageId: message.message_id,
                  imageBytes: base64.length * 0.75, // rough bytes estimation
                  base64Length: base64.length,
                },
                'Image downloaded and encoded; invoking vision model',
              );
              const contextSummary = await this.aiService.analyzeImage(dataUrl);
              logger.info(
                {
                  chatId: ctx.chat.id,
                  messageId: message.message_id,
                  summaryPresent: !!contextSummary,
                  summaryLength: contextSummary?.length || 0,
                  summaryPreview: contextSummary?.slice(0, 200),
                },
                'Vision model returned summary',
              );
              if (contextSummary && contextSummary.trim().length > 0) {
                await messageModel.updateMessageContext(
                  message.message_id,
                  ctx.chat.id,
                  contextSummary.trim(),
                );
                logger.info(
                  {
                    chatId: ctx.chat.id,
                    messageId: message.message_id,
                  },
                  'Stored image context summary in DB',
                );
              }
            }
          } catch (error) {
            logger.error(
              { error, selectedFileId },
              'Failed to analyze selected Telegram image',
            );
          }
        }
      }
    } catch (error) {
      logger.error(error, 'Failed to analyze image and store context');
    }

    // No explicit memory parsing here; the AI function calling decides when to save

    if (this.shouldRespond(message, ctx.from.id)) {
      await ctx.react('✍');
      await this.generateAndSendResponse(ctx, message);
    }
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

  private shouldRespond(message: TelegramMessage, fromUserId: number): boolean {
    if (fromUserId === this.bot.botInfo.id) {
      return false;
    }

    const { text } = this.deriveContentFields(message);

    if (text && text.includes(`@${this.botUsername}`)) {
      return true;
    }

    return !!(
      message.reply_to_message &&
      message.reply_to_message.from?.id === this.bot.botInfo.id
    );
  }

  private async generateAndSendResponse(
    ctx: MyContext,
    triggerMessage: TelegramMessage,
  ): Promise<void> {
    const chatId = ctx.chat!.id;

    try {
      const messageModel = database.getMessageModel();
      const recentMessages = await messageModel.getRecentMessages(chatId, 200);

      const dbTriggerMessage = await messageModel.findByMessageTelegramId(
        triggerMessage.message_id,
        chatId,
      );

      if (!dbTriggerMessage) {
        logger.error('Trigger message not found in database');
        return;
      }

      // Build hierarchical historical context sections
      const historicalSections: string[] =
        await this.buildHistoricalContextSections(chatId);

      const aiResponse = await this.aiService.generateResponse(
        recentMessages,
        dbTriggerMessage,
        this.botUsername,
        historicalSections,
      );

      // If tools were used, emit a technical message
      if (aiResponse.toolsUsed && aiResponse.toolsUsed.length > 0) {
        try {
          const toolNameList = aiResponse.toolsUsed
            .map((n) => `'${n}'`)
            .join(', ');
          const techText = `🛠️ AI used ${toolNameList} tool`;
          const techMsg = await ctx.reply(techText, {
            reply_to_message_id: triggerMessage.message_id,
          });
          await messageModel.saveMessage({
            telegramId: techMsg.message_id,
            chatTelegramId: chatId,
            userTelegramId: this.bot.botInfo.id,
            text: techText,
            replyToMessageTelegramId: triggerMessage.message_id,
            sentAt: new Date(techMsg.date * 1000),
            messageType: 'text',
            payload: JSON.parse(JSON.stringify(techMsg)),
          });
        } catch (error) {
          logger.error(
            { error },
            'Failed to send technical tool usage message',
          );
        }
      }

      const html = markdownToTelegramHtml(aiResponse.text);
      const sentMessage = await ctx.reply(html, {
        reply_to_message_id: triggerMessage.message_id,
      });

      await messageModel.saveMessage({
        telegramId: sentMessage.message_id,
        chatTelegramId: chatId,
        userTelegramId: this.bot.botInfo.id,
        text: aiResponse.text,
        replyToMessageTelegramId: triggerMessage.message_id,
        sentAt: new Date(sentMessage.date * 1000),
        messageType: 'text',
        payload: JSON.parse(JSON.stringify(sentMessage)),
      });

      // After persisting the bot message, ensure background summaries are up to date (non-blocking)
      this.ensureSummaries(chatId).catch((error) =>
        logger.error(
          { error, chatId },
          'Failed to maintain summaries after bot message',
        ),
      );

      logger.info(
        {
          chatId,
          triggerMessageId: triggerMessage.message_id,
          botMessageId: sentMessage.message_id,
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

  private async buildHistoricalContextSections(
    chatId: number,
  ): Promise<string[]> {
    const summaryModel = database.getSummaryModel();
    const memoryModel = database.getMemoryModel();
    const messageModel = database.getMessageModel();
    const sections: string[] = [];

    // Include pinned chat memory (user-stated facts to honor in replies)
    const memories = await memoryModel.listByChat(chatId, 100);
    if (memories.length > 0) {
      const lines = memories.map((m) => `• ${m.text}`);
      sections.push(
        `Pinned chat memory (facts to honor in replies):\n${lines.join('\n')}`,
      );
    }

    // Highest-level summaries first (very old), then lower levels, then level-0 ranges, then recent exact messages (added elsewhere)
    // Find highest existing level
    let probeLevel = 0;
    while ((await summaryModel.getCount(chatId, probeLevel)) > 0) {
      probeLevel += 1;
    }
    const maxLevel = probeLevel - 1;

    for (let l = maxLevel; l >= 1; l--) {
      const summaries = await summaryModel.getByLevelAscending(chatId, l);
      for (const s of summaries) {
        const title =
          l === maxLevel
            ? 'Very long time ago messages: SUMMARY of previous SUMMARIES'
            : 'Older messages: SUMMARY of previous SUMMARIES';
        sections.push(`${title}\n${s.summary}`);
      }
    }

    // Level 0: include a few recent blocks that are strictly before the last 200 exact messages
    const totalMessages = await messageModel.countMessages(chatId);
    const level0Summaries = await summaryModel.getByLevelAscending(chatId, 0);
    const completedBlocks = level0Summaries.length; // completed summaries from oldest to newest
    // Determine how many complete 200-message blocks exist strictly before the last 200 exact messages
    const blocksBeforeExact = Math.max(
      0,
      Math.floor(Math.max(0, totalMessages - 200) / 200),
    );
    // Include ALL completed blocks strictly before the last 200 exact messages
    const lastIncludedIdx = Math.min(
      blocksBeforeExact - 1,
      completedBlocks - 1,
    );
    // Indexing is oldest..newest; block 0 corresponds to 0-200 earliest.
    // Include all level-0 summaries strictly before the last 200 exact messages,
    // from oldest to newest so the AI reads chronology in order. Labels should
    // count down towards the present, e.g. 5400-5200 ... 400-200.
    const firstIncludedIdx = 0;
    for (let b = firstIncludedIdx; b <= lastIncludedIdx; b++) {
      const s = level0Summaries[b];
      if (!s) continue;
      const distanceFromEnd = lastIncludedIdx - b; // 0 = nearest to present
      const lower = (distanceFromEnd + 1) * 200; // 200, 400, 600, ...
      const upper = lower + 200; // 400, 600, 800, ...
      sections.push(`${upper}-${lower} messages:\n${s.summary}`);
    }

    return sections;
  }

  private getMessageType(message: TelegramMessage): MessageType {
    if (message.text) return MESSAGE_TYPE.TEXT;
    if (message.poll) return MESSAGE_TYPE.POLL;
    if (message.photo) return MESSAGE_TYPE.PHOTO;
    if (message.video) return MESSAGE_TYPE.VIDEO;
    if (message.video_note) return MESSAGE_TYPE.VIDEO_NOTE;
    if (message.document) return MESSAGE_TYPE.DOCUMENT;
    if (message.sticker) return MESSAGE_TYPE.STICKER;
    if (message.voice) return MESSAGE_TYPE.VOICE;
    if (message.audio) return MESSAGE_TYPE.AUDIO;
    return MESSAGE_TYPE.OTHER;
  }

  private deriveContentFields(message: TelegramMessage): {
    text?: string;
    fileName?: string;
    messageType: MessageType;
  } {
    const messageType = this.getMessageType(message);
    let text: string | undefined = message.text ?? undefined;
    let fileName: string | undefined = undefined;

    if (message.poll) {
      text = message.poll.question ?? text;
    }
    if (message.photo) {
      text = message.caption ?? text;
    }
    if (message.video) {
      text = message.caption ?? text;
      fileName = message.video.file_name ?? undefined;
    }
    if (message.document) {
      text = message.caption ?? text;
      fileName = message.document.file_name ?? undefined;
    }
    if (message.video_note) {
      text = message.caption ?? text;
    }

    return { text, fileName, messageType };
  }

  private buildPollContext(poll: TelegramPoll): string {
    const lines: string[] = [];
    const options = (poll.options || []).map((o) => o.text);
    lines.push('Poll details:');
    lines.push(`• Question: ${poll.question}`);
    lines.push(`• Options: ${options.join(' | ')}`);
    lines.push(
      `• Multiple answers: ${poll.allows_multiple_answers ? 'yes' : 'no'}`,
    );
    lines.push(`• Anonymous: ${poll.is_anonymous ? 'yes' : 'no'}`);
    lines.push(`• Type: ${poll.type}`);
    if (poll.correct_option_id !== undefined && poll.type === 'quiz') {
      lines.push(`• Correct option index: ${poll.correct_option_id}`);
    }
    if (poll.explanation && poll.type === 'quiz') {
      lines.push(`• Explanation: ${poll.explanation}`);
    }
    if (poll.open_period !== undefined) {
      lines.push(`• Open period (sec): ${poll.open_period}`);
    }
    if (poll.close_date !== undefined) {
      lines.push(`• Close date (unix): ${poll.close_date}`);
    }
    return lines.join('\n');
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

      try {
        await this.bot.api.setWebhook(config.telegram.webhookUrl!, {
          allowed_updates: API_CONSTANTS.ALL_UPDATE_TYPES,
          secret_token: config.telegram.webhookSecret,
        });
        logger.info('Webhook configured with reaction updates');
      } catch (error) {
        logger.error(error, 'Failed to configure webhook');
      }

      return;
    } else {
      logger.info('Starting bot in polling mode');

      await this.bot.start({
        allowed_updates: API_CONSTANTS.ALL_UPDATE_TYPES,
      });
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
