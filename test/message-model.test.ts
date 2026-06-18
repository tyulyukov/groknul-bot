import assert from 'node:assert/strict';
import test from 'node:test';
import { MessageModel, type Message } from '../src/database/models/Message.js';

const createMessage = (overrides: Partial<Message> = {}): Message => ({
  telegramId: 10,
  chatTelegramId: -100,
  userTelegramId: 42,
  text: 'hello',
  sentAt: new Date('2026-01-01T00:00:00.000Z'),
  edits: [],
  reactions: [],
  messageType: 'text',
  payload: {},
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

type UpdateCall = {
  filter: unknown;
  update: unknown;
  options?: unknown;
};

class FakeMessageCollection {
  updateCalls: UpdateCall[] = [];
  createIndexCalls: { keys: unknown; options?: unknown }[] = [];
  dropIndexCalls: string[] = [];
  aggregateResult: Message[] = [];
  lastPipeline: unknown[] = [];

  updateOne(filter: unknown, update: unknown, options?: unknown) {
    this.updateCalls.push({ filter, update, options });
    return Promise.resolve({ matchedCount: 1, modifiedCount: 1, upsertedCount: 0 });
  }

  aggregate<T>(pipeline: unknown[]) {
    this.lastPipeline = pipeline;
    return {
      toArray: async () => this.aggregateResult as T[],
    };
  }

  createIndex(keys: unknown, options?: unknown) {
    this.createIndexCalls.push({ keys, options });
    return Promise.resolve('index_name');
  }

  dropIndex(name: string) {
    this.dropIndexCalls.push(name);
    return Promise.resolve({ ok: 1 });
  }

  countDocuments() {
    return Promise.resolve(0);
  }
}

test('saveMessage upserts by telegram id within chat', async () => {
  const collection = new FakeMessageCollection();
  const model = new MessageModel(collection as never);

  const saved = await model.saveMessage({
    telegramId: 123,
    chatTelegramId: -100123,
    userTelegramId: 99,
    text: 'same telegram id in one chat',
    sentAt: new Date('2026-06-19T08:00:00.000Z'),
    messageType: 'text',
    payload: { message_id: 123 },
  });

  assert.equal(saved.telegramId, 123);
  assert.equal(collection.updateCalls.length, 1);
  assert.deepEqual(collection.updateCalls[0]?.filter, {
    telegramId: 123,
    chatTelegramId: -100123,
  });
  assert.deepEqual(collection.updateCalls[0]?.options, { upsert: true });
});

test('editMessage updates by telegram id within chat', async () => {
  const collection = new FakeMessageCollection();
  collection.aggregateResult = [
    createMessage({
      telegramId: 123,
      chatTelegramId: -100123,
      text: 'before',
      edits: [],
    }),
  ];
  const model = new MessageModel(collection as never);

  await model.editMessage(123, -100123, 'after');

  assert.equal(collection.updateCalls.length, 1);
  assert.deepEqual(collection.updateCalls[0]?.filter, {
    telegramId: 123,
    chatTelegramId: -100123,
  });
});

test('createIndexes drops the legacy global telegramId index and keeps compound uniqueness', async () => {
  const collection = new FakeMessageCollection();
  const model = new MessageModel(collection as never);

  await model.createIndexes();

  assert.deepEqual(collection.dropIndexCalls, ['telegramId_1']);
  assert.ok(
    collection.createIndexCalls.some(
      (call) =>
        JSON.stringify(call.keys) ===
          JSON.stringify({ telegramId: 1, chatTelegramId: 1 }) &&
        JSON.stringify(call.options) === JSON.stringify({ unique: true }),
    ),
  );
  assert.equal(
    collection.createIndexCalls.some(
      (call) =>
        JSON.stringify(call.keys) === JSON.stringify({ telegramId: 1 }) &&
        JSON.stringify(call.options) === JSON.stringify({ unique: true }),
    ),
    false,
  );
});

test('searchMessages escapes regex metacharacters in user query', async () => {
  const collection = new FakeMessageCollection();
  const model = new MessageModel(collection as never);

  await model.searchMessages({
    chatTelegramId: -100,
    query: 'a+b?(test)',
    limit: 5,
  });

  const pipeline = (collection as unknown as { lastPipeline: unknown[] })
    .lastPipeline;
  assert.deepEqual(pipeline[0], {
    $match: {
      chatTelegramId: -100,
      text: { $regex: 'a\\+b\\?\\(test\\)', $options: 'i' },
    },
  });
});
