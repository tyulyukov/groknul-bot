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
  aggregateResult: unknown[] = [];
  lastPipeline: unknown[] = [];
  findOneResult: Partial<Message> | null = null;
  findOneCall: { filter: unknown; options?: unknown } | undefined;

  updateOne(filter: unknown, update: unknown, options?: unknown) {
    this.updateCalls.push({ filter, update, options });
    return Promise.resolve({
      matchedCount: 1,
      modifiedCount: 1,
      upsertedCount: 0,
    });
  }

  aggregate<T>(pipeline: unknown[]) {
    this.lastPipeline = pipeline;
    return {
      toArray: async () => this.aggregateResult as T[],
    };
  }

  findOne(filter: unknown, options?: unknown) {
    this.findOneCall = { filter, options };
    return Promise.resolve(this.findOneResult);
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

test('getMessagesBefore reads messages above the trigger by telegram id', async () => {
  const collection = new FakeMessageCollection();
  const model = new MessageModel(collection as never);

  await model.getMessagesBefore(-100, 123, 10);

  assert.deepEqual(collection.lastPipeline.slice(0, 2), [
    {
      $match: {
        chatTelegramId: -100,
        telegramId: { $lt: 123 },
      },
    },
    { $sort: { telegramId: -1 } },
  ]);
  assert.deepEqual(collection.lastPipeline[2], { $limit: 10 });
});

test('findRawByMessageTelegramId reads only raw payload fields', async () => {
  const collection = new FakeMessageCollection();
  collection.findOneResult = {
    telegramId: 123,
    sentAt: new Date('2026-06-25T10:00:00.000Z'),
    messageType: 'poll',
    payload: { message: { poll: { question: 'Дата для дс' } } },
  };
  const model = new MessageModel(collection as never);

  const raw = await model.findRawByMessageTelegramId(123, -100);

  assert.deepEqual(raw, {
    telegramId: 123,
    sentAt: new Date('2026-06-25T10:00:00.000Z'),
    messageType: 'poll',
    payload: { message: { poll: { question: 'Дата для дс' } } },
  });
  assert.deepEqual(collection.findOneCall, {
    filter: { telegramId: 123, chatTelegramId: -100 },
    options: {
      projection: {
        _id: 0,
        telegramId: 1,
        sentAt: 1,
        messageType: 1,
        payload: 1,
      },
    },
  });
});

test('getChatStats aggregates stored messages with user and hourly breakdowns', async () => {
  const collection = new FakeMessageCollection();
  collection.aggregateResult = [
    {
      totals: [
        {
          totalMessages: 4,
          firstSentAt: new Date('2026-06-25T08:00:00.000Z'),
          lastSentAt: new Date('2026-06-25T10:00:00.000Z'),
        },
      ],
      byDay: [{ _id: '2026-06-25', count: 4 }],
      topUsers: [
        {
          _id: 111,
          count: 3,
          user: {
            username: 'stasik',
            firstName: 'Стасік',
            lastName: 'Thumb',
            isBot: false,
          },
        },
      ],
      peakHours: [{ _id: '2026-06-25 13:00', count: 2 }],
    },
  ];
  const model = new MessageModel(collection as never);

  const stats = await model.getChatStats({
    chatTelegramId: -100,
    since: new Date('2026-06-24T21:00:00.000Z'),
    until: new Date('2026-06-25T21:00:00.000Z'),
    timeZone: 'Europe/Kiev',
    dayLimit: 7,
    topUsersLimit: 5,
    topHoursLimit: 3,
    excludeUserTelegramId: 999,
  });

  assert.deepEqual(stats, {
    totalMessages: 4,
    firstSentAt: new Date('2026-06-25T08:00:00.000Z'),
    lastSentAt: new Date('2026-06-25T10:00:00.000Z'),
    byDay: [{ day: '2026-06-25', count: 4 }],
    topUsers: [
      {
        userTelegramId: 111,
        username: 'stasik',
        firstName: 'Стасік',
        lastName: 'Thumb',
        isBot: false,
        count: 3,
      },
    ],
    peakHours: [{ hour: '2026-06-25 13:00', count: 2 }],
  });
  assert.deepEqual(collection.lastPipeline[0], {
    $match: {
      chatTelegramId: -100,
      sentAt: {
        $gte: new Date('2026-06-24T21:00:00.000Z'),
        $lt: new Date('2026-06-25T21:00:00.000Z'),
      },
      userTelegramId: { $ne: 999 },
    },
  });
  assert.deepEqual(collection.lastPipeline[1], {
    $facet: {
      totals: [
        {
          $group: {
            _id: null,
            totalMessages: { $sum: 1 },
            firstSentAt: { $min: '$sentAt' },
            lastSentAt: { $max: '$sentAt' },
          },
        },
      ],
      byDay: [
        {
          $group: {
            _id: {
              $dateToString: {
                format: '%Y-%m-%d',
                date: '$sentAt',
                timezone: 'Europe/Kiev',
              },
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: -1 } },
        { $limit: 7 },
      ],
      topUsers: [
        { $group: { _id: '$userTelegramId', count: { $sum: 1 } } },
        { $sort: { count: -1, _id: 1 } },
        { $limit: 5 },
        {
          $lookup: {
            from: 'telegramusers',
            localField: '_id',
            foreignField: 'telegramId',
            as: 'user',
          },
        },
        { $addFields: { user: { $arrayElemAt: ['$user', 0] } } },
        {
          $project: {
            _id: 1,
            count: 1,
            'user.username': 1,
            'user.firstName': 1,
            'user.lastName': 1,
            'user.isBot': 1,
          },
        },
      ],
      peakHours: [
        {
          $group: {
            _id: {
              $dateToString: {
                format: '%Y-%m-%d %H:00',
                date: '$sentAt',
                timezone: 'Europe/Kiev',
              },
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { count: -1, _id: -1 } },
        { $limit: 3 },
      ],
    },
  });
});
