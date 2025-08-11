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
import { MessageOriginUser, Message as TelegramMessage } from 'grammy/types';
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

    await messageModel.saveMessage({
      telegramId: message.message_id,
      chatTelegramId: ctx.chat.id,
      userTelegramId: ctx.from.id,
      text: derived.text,
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

    // If message contains a photo (or a document that is a photo), analyze it and store concise context
    try {
      const shouldAnalyzePhoto =
        !!message.photo ||
        (message.document && message.document.mime_type?.startsWith('image/'));
      if (shouldAnalyzePhoto) {
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
              // Download the image and convert to base64 data URL
              const resp = await fetch(url);
              if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
              const contentType =
                resp.headers.get('content-type') || 'image/jpeg';
              const arrayBuffer = await resp.arrayBuffer();
              const base64 = Buffer.from(arrayBuffer).toString('base64');
              const dataUrl = `data:${contentType};base64,${base64}`;

              const contextSummary = await this.aiService.analyzeImage(dataUrl);
              if (contextSummary && contextSummary.trim().length > 0) {
                await messageModel.updateMessageContext(
                  message.message_id,
                  ctx.chat.id,
                  contextSummary.trim(),
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

      const aiResponse = await this.aiService.generateResponse(
        recentMessages,
        dbTriggerMessage,
        this.botUsername,
      );

      const html = markdownToTelegramHtml(aiResponse);
      const sentMessage = await ctx.reply(html, {
        reply_to_message_id: triggerMessage.message_id,
      });

      await messageModel.saveMessage({
        telegramId: sentMessage.message_id,
        chatTelegramId: chatId,
        userTelegramId: this.bot.botInfo.id,
        text: aiResponse,
        replyToMessageTelegramId: triggerMessage.message_id,
        sentAt: new Date(sentMessage.date * 1000),
        messageType: 'text',
        payload: JSON.parse(JSON.stringify(sentMessage)),
      });

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

  private getMessageType(message: TelegramMessage): MessageType {
    if (message.text) return MESSAGE_TYPE.TEXT;
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
