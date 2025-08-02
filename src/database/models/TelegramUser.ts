import { Collection } from 'mongodb';
import logger from '../../common/logger.js';

export interface TelegramUserHistory {
  username?: string;
  firstName?: string;
  lastName?: string;
  languageCode?: string;
  isPremium?: boolean;
  timestamp: Date;
}

export interface TelegramUser {
  _id?: string;
  telegramId: number;
  username?: string;
  firstName?: string;
  lastName?: string;
  isBot: boolean;
  isPremium?: boolean;
  languageCode?: string;
  history: TelegramUserHistory[];
  createdAt: Date;
  updatedAt: Date;
}

export class TelegramUserModel {
  constructor(private collection: Collection<TelegramUser>) {}

  async findByTelegramId(telegramId: number): Promise<TelegramUser | null> {
    return await this.collection.findOne({ telegramId });
  }

  async upsertUser(userData: Partial<TelegramUser>): Promise<TelegramUser> {
    const existingUser = await this.findByTelegramId(userData.telegramId!);
    const now = new Date();

    if (existingUser) {
      // Check if user data has changed
      const hasChanged =
        existingUser.username !== userData.username ||
        existingUser.firstName !== userData.firstName ||
        existingUser.lastName !== userData.lastName ||
        existingUser.languageCode !== userData.languageCode ||
        existingUser.isPremium !== userData.isPremium;

      if (hasChanged) {
        // Add current data to history before updating
        const historyEntry: TelegramUserHistory = {
          username: existingUser.username,
          firstName: existingUser.firstName,
          lastName: existingUser.lastName,
          languageCode: existingUser.languageCode,
          isPremium: existingUser.isPremium,
          timestamp: now,
        };

        await this.collection.updateOne(
          { telegramId: userData.telegramId },
          {
            $set: {
              username: userData.username,
              firstName: userData.firstName,
              lastName: userData.lastName,
              isPremium: userData.isPremium,
              languageCode: userData.languageCode,
              updatedAt: now,
            },
            $push: { history: historyEntry },
          },
        );
      }

      const updatedUser = await this.findByTelegramId(userData.telegramId!);
      if (!updatedUser) {
        throw new Error('Failed to retrieve updated user');
      }
      return updatedUser;
    } else {
      // Create new user
      const newUser: TelegramUser = {
        telegramId: userData.telegramId!,
        username: userData.username,
        firstName: userData.firstName,
        lastName: userData.lastName,
        isBot: userData.isBot || false,
        isPremium: userData.isPremium,
        languageCode: userData.languageCode,
        history: [],
        createdAt: now,
        updatedAt: now,
      };

      await this.collection.insertOne(newUser);
      return newUser;
    }
  }

  /**
   * Create database indexes for optimal query performance
   */
  async createIndexes(): Promise<void> {
    const indexCreations = [
      // Primary lookup index
      async () =>
        this.collection.createIndex({ telegramId: 1 }, { unique: true }),
    ];

    for (const createIndex of indexCreations) {
      try {
        await createIndex();
        logger.info(`Created TelegramUser index successfully`);
      } catch (error) {
        // Index might already exist, log but don't throw
        logger.info(
          error,
          `TelegramUser index creation skipped (may already exist)`,
        );
      }
    }
  }
}
