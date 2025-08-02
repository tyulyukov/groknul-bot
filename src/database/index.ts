import { databaseConnection } from './connection.js';
import { TelegramUser, TelegramUserModel } from './models/TelegramUser.js';
import { Message, MessageModel } from './models/Message.js';
import logger from '../common/logger.js';

export class Database {
  private telegramUserModel: TelegramUserModel | null = null;
  private messageModel: MessageModel | null = null;

  async initialize(): Promise<void> {
    const db = await databaseConnection.connect();

    const telegramUsersCollection =
      db.collection<TelegramUser>('telegramusers');
    const messagesCollection = db.collection<Message>('messages');

    this.telegramUserModel = new TelegramUserModel(telegramUsersCollection);
    this.messageModel = new MessageModel(messagesCollection);

    await this.createIndexes();

    logger.info('Database models initialized successfully');
  }

  private async createIndexes(): Promise<void> {
    try {
      logger.info('Creating database indexes...');

      await this.telegramUserModel!.createIndexes();
      await this.messageModel!.createIndexes();

      logger.info('Database indexes created successfully');
    } catch (error) {
      logger.error(error, 'Failed to create database indexes');
    }
  }

  getTelegramUserModel(): TelegramUserModel {
    if (!this.telegramUserModel) {
      throw new Error('Database not initialized. Call initialize() first.');
    }
    return this.telegramUserModel;
  }

  getMessageModel(): MessageModel {
    if (!this.messageModel) {
      throw new Error('Database not initialized. Call initialize() first.');
    }
    return this.messageModel;
  }

  async disconnect(): Promise<void> {
    await databaseConnection.disconnect();
  }
}

export const database = new Database();
