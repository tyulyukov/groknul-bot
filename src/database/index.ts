import { databaseConnection } from './connection.js';
import { TelegramUser, TelegramUserModel } from './models/TelegramUser.js';
import { Message, MessageModel } from './models/Message.js';
import { Summary, SummaryModel } from './models/Summary.js';
import { Memory, MemoryModel } from './models/Memory.js';
import { CodexAuthDocument, CodexAuthModel } from './models/CodexAuth.js';
import logger from '../common/logger.js';

export class Database {
  private telegramUserModel: TelegramUserModel | null = null;
  private messageModel: MessageModel | null = null;
  private summaryModel: SummaryModel | null = null;
  private memoryModel: MemoryModel | null = null;
  private codexAuthModel: CodexAuthModel | null = null;

  async initialize(): Promise<void> {
    const db = await databaseConnection.connect();

    const telegramUsersCollection =
      db.collection<TelegramUser>('telegramusers');
    const messagesCollection = db.collection<Message>('messages');
    const summariesCollection = db.collection<Summary>('summaries');
    const memoriesCollection = db.collection<Memory>('memories');
    const codexAuthCollection = db.collection<CodexAuthDocument>('codexauth');

    this.telegramUserModel = new TelegramUserModel(telegramUsersCollection);
    this.messageModel = new MessageModel(messagesCollection);
    this.summaryModel = new SummaryModel(summariesCollection);
    this.memoryModel = new MemoryModel(memoriesCollection);
    this.codexAuthModel = new CodexAuthModel(codexAuthCollection);

    await this.createIndexes();
    await this.hydrateCodexAuthCache();

    logger.info('Database models initialized successfully');
  }

  private async createIndexes(): Promise<void> {
    try {
      logger.info('Creating database indexes...');

      await this.telegramUserModel!.createIndexes();
      await this.messageModel!.createIndexes();
      await this.summaryModel!.createIndexes();
      await this.memoryModel!.createIndexes();
      await this.codexAuthModel!.createIndexes();

      logger.info('Database indexes created successfully');
    } catch (error) {
      logger.error(error, 'Failed to create database indexes');
    }
  }

  private async hydrateCodexAuthCache(): Promise<void> {
    try {
      await this.codexAuthModel!.get();
    } catch (error) {
      logger.error(error, 'Failed to hydrate Codex auth cache');
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

  getSummaryModel(): SummaryModel {
    if (!this.summaryModel) {
      throw new Error('Database not initialized. Call initialize() first.');
    }
    return this.summaryModel;
  }

  getMemoryModel(): MemoryModel {
    if (!this.memoryModel) {
      throw new Error('Database not initialized. Call initialize() first.');
    }
    return this.memoryModel;
  }

  getCodexAuthModel(): CodexAuthModel {
    if (!this.codexAuthModel) {
      throw new Error('Database not initialized. Call initialize() first.');
    }
    return this.codexAuthModel;
  }

  tryGetCodexAuthModel(): CodexAuthModel | null {
    return this.codexAuthModel;
  }

  async disconnect(): Promise<void> {
    await databaseConnection.disconnect();
  }
}

export const database = new Database();
