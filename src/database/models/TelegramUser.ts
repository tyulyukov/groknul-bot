import { Collection, CreateIndexesOptions, IndexSpecification } from 'mongodb';
import logger from '../../common/logger.js';

export interface TelegramUserHistory {
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  languageCode?: string | null;
  isPremium?: boolean | null;
  timestamp: Date;
}

export interface TelegramUser {
  _id?: string;
  telegramId: number;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  isBot: boolean;
  isPremium?: boolean;
  languageCode?: string | null;
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
      const normalizeString = (value?: string | null): string =>
        (value ?? '').trim();
      const normalizeBoolean = (value?: boolean | null): boolean =>
        value === true;

      const hasChanged =
        normalizeString(existingUser.username) !==
          normalizeString(userData.username) ||
        normalizeString(existingUser.firstName) !==
          normalizeString(userData.firstName) ||
        normalizeString(existingUser.lastName) !==
          normalizeString(userData.lastName) ||
        normalizeString(existingUser.languageCode) !==
          normalizeString(userData.languageCode) ||
        normalizeBoolean(existingUser.isPremium) !==
          normalizeBoolean(userData.isPremium);

      if (hasChanged) {
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
              username: userData.username ?? null,
              firstName: userData.firstName ?? null,
              lastName: userData.lastName ?? null,
              isPremium: (userData.isPremium ?? false) === true,
              languageCode: userData.languageCode ?? null,
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
      const newUser: TelegramUser = {
        telegramId: userData.telegramId!,
        username: userData.username ?? null,
        firstName: userData.firstName ?? null,
        lastName: userData.lastName ?? null,
        isBot: userData.isBot || false,
        isPremium: (userData.isPremium ?? false) === true,
        languageCode: userData.languageCode ?? null,
        history: [],
        createdAt: now,
        updatedAt: now,
      };

      await this.collection.insertOne(newUser);
      return newUser;
    }
  }

  async createIndexes(): Promise<void> {
    const indexDefinitions: {
      keys: IndexSpecification;
      options?: CreateIndexesOptions;
      description: string;
    }[] = [
      {
        keys: { telegramId: 1 },
        options: { unique: true },
        description: 'Primary lookup index',
      },
    ];

    for (const def of indexDefinitions) {
      try {
        await this.collection.createIndex(def.keys, def.options);
        logger.info(
          `Created TelegramUser index successfully: ${def.description}`,
        );
      } catch (error) {
        logger.error(
          error,
          `TelegramUser index creation failed (may already exist): ${def.description}`,
        );
      }
    }
  }
}
