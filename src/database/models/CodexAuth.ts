import { Collection } from 'mongodb';

export const CODEX_AUTH_DOCUMENT_ID = 'codex-oauth';

export interface CodexAuthDocument {
  _id: string;
  data: Record<string, unknown>;
  updatedAt: Date;
}

export class CodexAuthModel {
  private cached: Record<string, unknown> | null = null;

  constructor(private collection: Collection<CodexAuthDocument>) {}

  async createIndexes(): Promise<void> {
    // Single fixed-key document keyed by _id; no secondary indexes needed.
  }

  async get(): Promise<Record<string, unknown> | null> {
    const doc = await this.collection.findOne({ _id: CODEX_AUTH_DOCUMENT_ID });
    this.cached = doc?.data ?? null;
    return this.cached;
  }

  getCached(): Record<string, unknown> | null {
    return this.cached;
  }

  async save(data: Record<string, unknown>): Promise<void> {
    await this.collection.updateOne(
      { _id: CODEX_AUTH_DOCUMENT_ID },
      { $set: { data, updatedAt: new Date() } },
      { upsert: true },
    );
    this.cached = data;
  }

  async delete(): Promise<boolean> {
    const result = await this.collection.deleteOne({
      _id: CODEX_AUTH_DOCUMENT_ID,
    });
    this.cached = null;
    return result.deletedCount === 1;
  }
}
