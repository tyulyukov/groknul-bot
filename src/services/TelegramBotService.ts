import { Bot, Context, GrammyError, HttpError, session } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import { hydrate, HydrateFlavor } from '@grammyjs/hydrate';
import { parseMode } from '@grammyjs/parse-mode';
import { run } from '@grammyjs/runner';
import { MongoDBAdapter } from '@grammyjs/storage-mongodb';
import { apiThrottler } from '@grammyjs/transformer-throttler';
import { config } from '../common/config.js';
import logger from '../common/logger.js';
import { database } from '../database/index.js';
import { AIService } from './AIService.js';
import { databaseConnection } from '../database/connection.js';
import { MessageOriginUser, Message as TelegramMessage } from 'grammy/types';
import { MessageEntity } from '@grammyjs/types/message';
import {
  MessageReaction,
  PopulatedMessage,
} from '../database/models/Message.js';
import { API_CONSTANTS } from 'grammy';

interface SessionData {
  messageCount: number;
}

type MyContext = HydrateFlavor<Context & { session: SessionData }>;

export class TelegramBotService {
  private readonly bot: Bot<MyContext>;
  private aiService: AIService;
  private botUsername: string = '';

  constructor() {
    this.bot = new Bot(config.telegram.apiKey);
    this.aiService = new AIService();
    this.setupMiddleware();
    this.setupHandlers();
  }

  private async setupMiddleware(): Promise<void> {
    // Auto-retry for network errors
    this.bot.api.config.use(autoRetry());

    // Rate limiting
    this.bot.api.config.use(apiThrottler());

    // Hydration for better message handling
    this.bot.use(hydrate());

    // Parse mode for better formatting
    this.bot.api.config.use(parseMode('HTML'));

    // Session middleware
    const adapter = new MongoDBAdapter({
      collection: databaseConnection.getDb().collection('sessions'),
    });

    this.bot.use(
      session({
        initial: (): SessionData => ({ messageCount: 0 }),
        storage: adapter,
      }),
    );

    // Error handling
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

    // Logging middleware
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
    // Start command (only works in private chats)
    this.bot.command('start', async (ctx) => {
      if (ctx.chat?.type !== 'private') {
        return; // Ignore start command in groups
      }

      const startMessage = `🤖 <b>Groknul Bot</b>

I'm a bold, opinionated, yet helpful group chat assistant that observes conversations and provides informative responses!

<b>How to use me:</b>
• Add me to your group chat
• Mention me (@${this.botUsername}) in a message or reply to my messages
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

      await ctx.reply(startMessage);
    });

    // Handle all messages in groups
    this.bot.on('message', async (ctx) => {
      // Only process messages in groups/supergroups
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

    // Handle message edits
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

    // Handle message reactions
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

    // Handle channel posts and edited channel posts if bot is added to channels
    this.bot.on(['channel_post', 'edited_channel_post'], async (ctx) => {
      // For now, we'll ignore channel posts, but this can be extended
      logger.info({ chatId: ctx.chat?.id }, 'Channel post received (ignored)');
    });
  }

  private async handleMessage(ctx: MyContext): Promise<void> {
    const message = ctx.message;
    if (!message || !ctx.from || !ctx.chat) {
      logger.warn({ message, ctx }, 'Skipping message handling');
      return;
    }

    // Save user to database
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

    // Save message to database
    const messageModel = database.getMessageModel();
    await messageModel.saveMessage({
      telegramId: message.message_id,
      chatTelegramId: ctx.chat.id,
      userTelegramId: ctx.from.id,
      text: message.text,
      replyToMessageTelegramId: message.reply_to_message?.message_id,
      sentAt: new Date(message.date * 1000),
      messageType: this.getMessageType(message),
      forwardOrigin: message.forward_origin,
      forwardFromUserTelegramId: (message.forward_origin as MessageOriginUser)
        ?.sender_user?.id,
      payload: JSON.parse(JSON.stringify(ctx)),
    });

    // Check if bot should respond
    if (this.shouldRespond(message, ctx.from.id)) {
      await this.generateAndSendResponse(ctx, message);
    }
  }

  private async handleMessageEdit(ctx: MyContext): Promise<void> {
    const editedMessage = ctx.editedMessage;
    if (!editedMessage || !ctx.chat) return;

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
    if (!messageReaction || !ctx.from || !ctx.chat) return;

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

      // Create simple reaction data objects (updateReactions will add userId and addedAt)
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
    // Don't respond to bot's own messages
    if (fromUserId === this.bot.botInfo.id) {
      return false;
    }

    // Respond if bot is mentioned
    if (message.text && message.text.includes(`@${this.botUsername}`)) {
      return true;
    }

    // Respond if replying to bot's message
    if (
      message.reply_to_message &&
      message.reply_to_message.from?.id === this.bot.botInfo.id
    ) {
      return true;
    }

    return false;
  }

  private async generateAndSendResponse(
    ctx: MyContext,
    triggerMessage: TelegramMessage,
  ): Promise<void> {
    const chatId = ctx.chat!.id;

    try {
      // Get recent messages for context (now populated with user data)
      const messageModel = database.getMessageModel();
      const recentMessages = await messageModel.getRecentMessages(chatId, 500);

      // Find the trigger message in our database
      const dbTriggerMessage = await messageModel.findByMessageTelegramId(
        triggerMessage.message_id,
        chatId,
      );
      if (!dbTriggerMessage) {
        logger.error('Trigger message not found in database');
        return;
      }

      // Generate AI response
      const aiResponse = await this.aiService.generateResponse(
        recentMessages,
        dbTriggerMessage,
        this.botUsername,
      );

      // Send response
      const sentMessage = await ctx.reply(aiResponse.text, {
        reply_to_message_id: triggerMessage.message_id,
      });

      // Save bot's message to database
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

      logger.info(
        {
          chatId,
          triggerMessageId: triggerMessage.message_id,
          responseLength: aiResponse.text.length,
          tokensUsed: aiResponse.tokensUsed,
          botMessageId: sentMessage.message_id,
        },
        'AI response sent and saved successfully',
      );
    } catch (error) {
      logger.error(error, 'Failed to generate or send AI response');

      // Send error message to user
      try {
        const errorMessage = await ctx.reply(
          'Sorry, I encountered an error while generating a response. Please try again later.',
          { reply_to_message_id: triggerMessage.message_id },
        );

        // Save error message to database
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

  private getMessageType(
    message: any,
  ):
    | 'text'
    | 'photo'
    | 'video'
    | 'document'
    | 'sticker'
    | 'voice'
    | 'audio'
    | 'other' {
    if (message.text) return 'text';
    if (message.photo) return 'photo';
    if (message.video) return 'video';
    if (message.document) return 'document';
    if (message.sticker) return 'sticker';
    if (message.voice) return 'voice';
    if (message.audio) return 'audio';
    return 'other';
  }

  async start(): Promise<void> {
    // Get bot info
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

    // Save bot's user information to the database
    await this.saveBotUserProfile(botInfo);

    if (config.telegram.mode === 'webhook') {
      logger.info('Starting bot in webhook mode');

      // Configure webhook with allowed updates to include reactions
      try {
        await this.bot.api.setWebhook(config.telegram.webhookUrl!, {
          allowed_updates: API_CONSTANTS.ALL_UPDATE_TYPES,
          secret_token: config.telegram.webhookSecret,
        });
        logger.info('Webhook configured with reaction updates');
      } catch (error) {
        logger.error(error, 'Failed to configure webhook');
      }

      // Webhook will be handled by Hono server
      return;
    } else {
      logger.info('Starting bot in polling mode');
      // Enable reaction updates for polling mode
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

  /**
   * Save the bot's user profile to the database
   * This ensures that when the bot sends messages, they can be properly
   * linked to the bot's user profile in the database
   */
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
