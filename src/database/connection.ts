import { MongoClient, Db } from 'mongodb';
import { config } from '../common/config.js';
import logger from '../common/logger.js';

class DatabaseConnection {
  private client: MongoClient | null = null;
  private db: Db | null = null;

  async connect(): Promise<Db> {
    if (this.db) {
      return this.db;
    }

    try {
      logger.info('Connecting to MongoDB...');
      this.client = new MongoClient(config.mongodb.uri);
      await this.client.connect();

      this.db = this.client.db();
      logger.info('Connected to MongoDB successfully');

      return this.db;
    } catch (error) {
      logger.error(error, 'Failed to connect to MongoDB');
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.db = null;
      logger.info('Disconnected from MongoDB');
    }
  }

  getDb(): Db {
    if (!this.db) {
      throw new Error('Database not connected. Call connect() first.');
    }
    return this.db;
  }
}

export const databaseConnection = new DatabaseConnection();
