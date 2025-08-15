import { Collection, CreateIndexesOptions, IndexSpecification, ObjectId } from 'mongodb';
import logger from '../../common/logger.js';

export interface Memory {
  _id?: string;
  chatTelegramId: number;
  addedByUserTelegramId: number;
  text: string;
  sourceMessageTelegramId?: number;
  createdAt: Date;
  updatedAt: Date;
}

export class MemoryModel {
  constructor(private collection: Collection<Memory>) {}

  async createIndexes(): Promise<void> {
    const indexDefinitions: {
      keys: IndexSpecification;
      options?: CreateIndexesOptions;
      description: string;
    }[] = [
      {
        keys: { chatTelegramId: 1, createdAt: 1 },
        description: 'Lookup memories by chat in chronological order',
      },
      {
        keys: { chatTelegramId: 1, text: 'text' },
        description: 'Full-text search over memory text within a chat',
      },
    ];

    for (const def of indexDefinitions) {
      try {
        await this.collection.createIndex(def.keys, def.options);
        logger.info(`Created Memory index successfully: ${def.description}`);
      } catch (error) {
        logger.error(
          error,
          `Memory index creation failed (may already exist): ${def.description}`,
        );
      }
    }
  }

  async addMemory(doc: Omit<Memory, '_id' | 'createdAt' | 'updatedAt'>): Promise<Memory> {
    const now = new Date();
    const memory: Memory = {
      chatTelegramId: doc.chatTelegramId,
      addedByUserTelegramId: doc.addedByUserTelegramId,
      text: doc.text.trim(),
      sourceMessageTelegramId: doc.sourceMessageTelegramId,
      createdAt: now,
      updatedAt: now,
    };
    await this.collection.insertOne(memory);
    return memory;
  }

  async listByChat(chatTelegramId: number, limit = 50): Promise<Memory[]> {
    return this.collection
      .find({ chatTelegramId })
      .sort({ createdAt: 1 })
      .limit(limit)
      .toArray();
  }

  async deleteById(chatTelegramId: number, id: string): Promise<boolean> {
    let objectId: ObjectId;
    try {
      objectId = new ObjectId(id);
    } catch {
      return false;
    }
    const res = await this.collection.deleteOne({ _id: objectId as unknown as string, chatTelegramId });
    return res.deletedCount === 1;
  }
}


