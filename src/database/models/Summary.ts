import { Collection, CreateIndexesOptions, IndexSpecification } from 'mongodb';
import logger from '../../common/logger.js';

export interface Summary {
  _id?: string;
  chatTelegramId: number;
  level: number; // 0 = 200 messages, 1 = 200 summaries of level 0, etc.
  index: number; // sequence index at this level
  summary: string;
  startSentAt?: Date;
  endSentAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export class SummaryModel {
  constructor(private collection: Collection<Summary>) {}

  async createIndexes(): Promise<void> {
    const indexDefinitions: {
      keys: IndexSpecification;
      options?: CreateIndexesOptions;
      description: string;
    }[] = [
      {
        keys: { chatTelegramId: 1, level: 1, index: 1 },
        options: { unique: true },
        description: 'Unique summary per chat/level/index',
      },
      {
        keys: { chatTelegramId: 1, level: 1 },
        description: 'Lookup summaries by chat and level',
      },
    ];

    for (const def of indexDefinitions) {
      try {
        await this.collection.createIndex(def.keys, def.options);
        logger.info(`Created Summary index successfully: ${def.description}`);
      } catch (error) {
        logger.error(
          error,
          `Summary index creation failed (may already exist): ${def.description}`,
        );
      }
    }
  }

  async getCount(chatTelegramId: number, level: number): Promise<number> {
    return this.collection.countDocuments({ chatTelegramId, level });
  }

  async exists(
    chatTelegramId: number,
    level: number,
    index: number,
  ): Promise<boolean> {
    const doc = await this.collection.findOne({ chatTelegramId, level, index });
    return !!doc;
  }

  async getByLevelAscending(
    chatTelegramId: number,
    level: number,
  ): Promise<Summary[]> {
    return this.collection
      .find({ chatTelegramId, level })
      .sort({ index: 1 })
      .toArray();
  }

  async getRangeByLevelAscending(
    chatTelegramId: number,
    level: number,
    skip: number,
    limit: number,
  ): Promise<Summary[]> {
    return this.collection
      .find({ chatTelegramId, level })
      .sort({ index: 1 })
      .skip(skip)
      .limit(limit)
      .toArray();
  }

  async upsertSummary(doc: Omit<Summary, '_id' | 'createdAt' | 'updatedAt'>): Promise<void> {
    const now = new Date();
    await this.collection.updateOne(
      { chatTelegramId: doc.chatTelegramId, level: doc.level, index: doc.index },
      {
        $set: {
          summary: doc.summary,
          startSentAt: doc.startSentAt,
          endSentAt: doc.endSentAt,
          updatedAt: now,
        },
        $setOnInsert: {
          chatTelegramId: doc.chatTelegramId,
          level: doc.level,
          index: doc.index,
          createdAt: now,
        },
      },
      { upsert: true },
    );
  }
}


