import assert from 'node:assert/strict';
import test from 'node:test';
import { ContextToolService } from '../src/services/context-tool.service.js';

test('getMessagesBefore returns messages immediately before a trigger', async () => {
  let seenInput: unknown;
  const service = new ContextToolService(
    {
      getMessageModel: () => ({
        getRecentMessages: async () => [],
        getMessagesBefore: async (...args: unknown[]) => {
          seenInput = args;
          return [
            {
              telegramId: 122,
              chatTelegramId: -100,
              userTelegramId: 777,
              user: {
                telegramId: 777,
                username: 'maksym',
                firstName: 'Maksym',
                isBot: false,
                history: [],
                createdAt: new Date('2026-06-19T00:00:00.000Z'),
                updatedAt: new Date('2026-06-19T00:00:00.000Z'),
              },
              text: 'а это ты ебнул tay keith?',
              context: 'Image: screenshot context above the current message.',
              sentAt: new Date('2026-06-19T09:32:00.000Z'),
              edits: [],
              reactions: [
                {
                  userTelegramId: 1,
                  emoji: '😁',
                  addedAt: new Date('2026-06-19T09:33:00.000Z'),
                },
                {
                  userTelegramId: 2,
                  addedAt: new Date('2026-06-19T09:34:00.000Z'),
                },
              ],
              messageType: 'text',
              payload: {},
              createdAt: new Date('2026-06-19T09:32:00.000Z'),
              updatedAt: new Date('2026-06-19T09:32:00.000Z'),
            },
          ];
        },
        searchMessages: async () => [],
        findByMessageTelegramId: async () => null,
        findRawByMessageTelegramId: async () => null,
        countMessages: async () => 0,
        getChatStats: async () => {
          throw new Error('unused');
        },
      }),
      getMemoryModel: () => ({
        searchByChat: async () => [],
        addMemory: async () => {
          throw new Error('unused');
        },
        deleteById: async () => false,
        listByChat: async () => [],
      }),
      getSummaryModel: () => ({
        getByLevelAscending: async () => [],
        getCount: async () => 0,
      }),
    },
    {
      summarizeText: async () => 'summary',
    },
    {
      maxMessages: 50,
      maxChars: 10_000,
      maxResults: 20,
    },
  );

  const result = await service.getMessagesBefore(-100, {
    messageId: 123,
    limit: 10,
  });

  assert.deepEqual(seenInput, [-100, 123, 10]);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.messages, [
    {
      id: 122,
      from: 'maksym',
      userTelegramId: 777,
      text: 'а это ты ебнул tay keith?',
      context: 'Image: screenshot context above the current message.',
      sentAt: new Date('2026-06-19T09:32:00.000Z'),
      replyToMessageId: undefined,
      reactions: ['😁'],
    },
  ]);
});

test('getRecentMessages returns too_large when requested context exceeds hard caps', async () => {
  const service = new ContextToolService(
    {
      getMessageModel: () => ({
        getRecentMessages: async () => [],
        getMessagesBefore: async () => [],
        searchMessages: async () => [],
        findByMessageTelegramId: async () => null,
        findRawByMessageTelegramId: async () => null,
        countMessages: async () => 0,
        getChatStats: async () => {
          throw new Error('unused');
        },
      }),
      getMemoryModel: () => ({
        searchByChat: async () => [],
        addMemory: async () => {
          throw new Error('unused');
        },
        deleteById: async () => false,
        listByChat: async () => [],
      }),
      getSummaryModel: () => ({
        getByLevelAscending: async () => [],
        getCount: async () => 0,
      }),
    },
    {
      summarizeText: async () => 'summary',
    },
    {
      maxMessages: 50,
      maxChars: 10_000,
      maxResults: 20,
    },
  );

  const result = await service.getRecentMessages(-100, {
    limit: 51,
  });

  assert.equal(result.status, 'too_large');
  assert.deepEqual(result.suggested, {
    limit: 50,
    sinceMinutes: undefined,
  });
});

test('searchMessages returns a stable continuation cursor', async () => {
  let seenInput: unknown;
  const messages = [103, 102, 101].map((telegramId) => ({
    telegramId,
    chatTelegramId: -100,
    userTelegramId: 777,
    user: { username: 'maksym' },
    text: `prediction ${telegramId}`,
    sentAt: new Date(`2026-06-0${telegramId - 100}T00:00:00.000Z`),
    edits: [],
    reactions: [],
    messageType: 'text' as const,
    payload: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  }));
  const service = new ContextToolService(
    {
      getMessageModel: () => ({
        getRecentMessages: async () => [],
        getMessagesBefore: async () => [],
        searchMessages: async (input: unknown) => {
          seenInput = input;
          return messages as never;
        },
        findByMessageTelegramId: async () => null,
        findRawByMessageTelegramId: async () => null,
        countMessages: async () => 0,
        getChatStats: async () => {
          throw new Error('unused');
        },
      }),
      getMemoryModel: () => ({
        searchByChat: async () => [],
        addMemory: async () => {
          throw new Error('unused');
        },
        deleteById: async () => false,
        listByChat: async () => [],
      }),
      getSummaryModel: () => ({
        getByLevelAscending: async () => [],
        getCount: async () => 0,
      }),
    },
    { summarizeText: async () => 'summary' },
    { maxMessages: 50, maxChars: 10_000, maxResults: 20 },
  );

  const result = await service.searchMessages(-100, {
    since: '2026-06-01T00:00:00.000Z',
    beforeMessageId: 200,
    limit: 2,
  });

  assert.deepEqual(seenInput, {
    chatTelegramId: -100,
    query: undefined,
    since: new Date('2026-06-01T00:00:00.000Z'),
    until: undefined,
    fromUserTelegramId: undefined,
    beforeMessageTelegramId: 200,
    limit: 3,
  });
  assert.equal(result.status, 'ok');
  assert.deepEqual(
    result.messages?.map((message) => message.id),
    [103, 102],
  );
  assert.deepEqual(result.page, {
    hasMore: true,
    nextBeforeMessageId: 102,
  });
});

test('getChatDigest reads highest-level summaries before recent level-0 summaries', async () => {
  const service = new ContextToolService(
    {
      getMessageModel: () => ({
        getRecentMessages: async () => [],
        getMessagesBefore: async () => [],
        searchMessages: async () => [],
        findByMessageTelegramId: async () => null,
        findRawByMessageTelegramId: async () => null,
        countMessages: async () => 0,
        getChatStats: async () => {
          throw new Error('unused');
        },
      }),
      getMemoryModel: () => ({
        searchByChat: async () => [],
        addMemory: async () => {
          throw new Error('unused');
        },
        deleteById: async () => false,
        listByChat: async () => [],
      }),
      getSummaryModel: () => ({
        getCount: async (_chatId: number, level: number) =>
          level <= 1 ? 1 : 0,
        getByLevelAscending: async (_chatId: number, level: number) =>
          level === 1
            ? [
                {
                  chatTelegramId: -100,
                  level,
                  index: 0,
                  summary: 'high-level old digest',
                  createdAt: new Date(),
                  updatedAt: new Date(),
                },
              ]
            : [
                {
                  chatTelegramId: -100,
                  level,
                  index: 0,
                  summary: 'recent level zero',
                  createdAt: new Date(),
                  updatedAt: new Date(),
                },
              ],
      }),
    },
    {
      summarizeText: async () => 'summary',
    },
    {
      maxMessages: 50,
      maxChars: 10_000,
      maxResults: 20,
    },
  );

  const result = await service.getChatDigest(-100, { period: 'all' });

  assert.equal(result.status, 'ok');
  assert.match(result.digest ?? '', /high-level old digest/);
  assert.match(result.digest ?? '', /recent level zero/);
});

test('getChatSummaries returns the last matching stored summaries', async () => {
  const service = new ContextToolService(
    {
      getMessageModel: () => ({
        getRecentMessages: async () => [],
        getMessagesBefore: async () => [],
        searchMessages: async () => [],
        findByMessageTelegramId: async () => null,
        findRawByMessageTelegramId: async () => null,
        countMessages: async () => 0,
        getChatStats: async () => {
          throw new Error('unused');
        },
      }),
      getMemoryModel: () => ({
        searchByChat: async () => [],
        addMemory: async () => {
          throw new Error('unused');
        },
        deleteById: async () => false,
        listByChat: async () => [],
      }),
      getSummaryModel: () => ({
        getCount: async () => 2,
        getByLevelAscending: async () => [
          {
            chatTelegramId: -100,
            level: 0,
            index: 0,
            summary: 'older',
            startSentAt: new Date('2026-06-18T00:00:00.000Z'),
            endSentAt: new Date('2026-06-18T01:00:00.000Z'),
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          {
            chatTelegramId: -100,
            level: 0,
            index: 1,
            summary: 'newer',
            startSentAt: new Date('2026-06-19T00:00:00.000Z'),
            endSentAt: new Date('2026-06-19T01:00:00.000Z'),
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      }),
    },
    {
      summarizeText: async () => 'summary',
    },
    {
      maxMessages: 50,
      maxChars: 10_000,
      maxResults: 20,
    },
  );

  const result = await service.getChatSummaries(-100, {
    limit: 1,
    since: '2026-06-18T12:00:00.000Z',
  });

  assert.equal(result.status, 'ok');
  assert.deepEqual(result.summaries, [
    {
      level: 0,
      index: 1,
      summary: 'newer',
      startSentAt: new Date('2026-06-19T00:00:00.000Z'),
      endSentAt: new Date('2026-06-19T01:00:00.000Z'),
    },
  ]);
});

test('summarizeMessages can summarize a bounded message period', async () => {
  let searchInput: unknown;
  const service = new ContextToolService(
    {
      getMessageModel: () => ({
        getRecentMessages: async () => {
          throw new Error('unused');
        },
        getMessagesBefore: async () => [],
        searchMessages: async (input: unknown) => {
          searchInput = input;
          return [
            {
              telegramId: 101,
              chatTelegramId: -100,
              userTelegramId: 777,
              user: {
                telegramId: 777,
                firstName: 'alice',
                isBot: false,
                history: [],
                createdAt: new Date('2026-06-19T00:00:00.000Z'),
                updatedAt: new Date('2026-06-19T00:00:00.000Z'),
              },
              text: 'period message',
              sentAt: new Date('2026-06-19T00:30:00.000Z'),
              edits: [],
              reactions: [],
              messageType: 'text',
              payload: {},
              createdAt: new Date('2026-06-19T00:30:00.000Z'),
              updatedAt: new Date('2026-06-19T00:30:00.000Z'),
            },
          ];
        },
        findByMessageTelegramId: async () => null,
        findRawByMessageTelegramId: async () => null,
        countMessages: async () => 0,
        getChatStats: async () => {
          throw new Error('unused');
        },
      }),
      getMemoryModel: () => ({
        searchByChat: async () => [],
        addMemory: async () => {
          throw new Error('unused');
        },
        deleteById: async () => false,
        listByChat: async () => [],
      }),
      getSummaryModel: () => ({
        getByLevelAscending: async () => [],
        getCount: async () => 0,
      }),
    },
    {
      summarizeText: async (blocks) => blocks.join('\n'),
    },
    {
      maxMessages: 50,
      maxChars: 10_000,
      maxResults: 20,
    },
  );

  const result = await service.summarizeMessages(-100, {
    range: {
      limit: 5,
      since: '2026-06-19T00:00:00.000Z',
      until: '2026-06-19T01:00:00.000Z',
    },
  });

  assert.equal(result.status, 'ok');
  assert.match(result.summary ?? '', /period message/);
  assert.deepEqual(searchInput, {
    chatTelegramId: -100,
    since: new Date('2026-06-19T00:00:00.000Z'),
    until: new Date('2026-06-19T01:00:00.000Z'),
    fromUserTelegramId: undefined,
    limit: 5,
  });
});

test('getChatStats returns stored message accounting for the requested period', async () => {
  let statsInput: unknown;
  const service = new ContextToolService(
    {
      getMessageModel: () => ({
        getRecentMessages: async () => [],
        getMessagesBefore: async () => [],
        searchMessages: async () => [],
        findByMessageTelegramId: async () => null,
        findRawByMessageTelegramId: async () => null,
        countMessages: async () => 0,
        getChatStats: async (input: unknown) => {
          statsInput = input;
          return {
            totalMessages: 4,
            firstSentAt: new Date('2026-06-25T08:00:00.000Z'),
            lastSentAt: new Date('2026-06-25T10:00:00.000Z'),
            byDay: [{ day: '2026-06-25', count: 4 }],
            topUsers: [
              {
                userTelegramId: 111,
                username: 'stasik',
                firstName: 'Стасік',
                count: 3,
              },
              {
                userTelegramId: 222,
                firstName: 'maksym',
                count: 1,
              },
            ],
            peakHours: [{ hour: '2026-06-25 13:00', count: 2 }],
          };
        },
      }),
      getMemoryModel: () => ({
        searchByChat: async () => [],
        addMemory: async () => {
          throw new Error('unused');
        },
        deleteById: async () => false,
        listByChat: async () => [],
      }),
      getSummaryModel: () => ({
        getByLevelAscending: async () => [],
        getCount: async () => 0,
      }),
    },
    {
      summarizeText: async () => 'summary',
    },
    {
      maxMessages: 50,
      maxChars: 10_000,
      maxResults: 20,
    },
  );

  const result = await service.getChatStats(-100, {
    period: 'today',
    timeZone: 'Europe/Kiev',
    topUsersLimit: 2,
    topHoursLimit: 3,
    dayLimit: 7,
    excludeUserTelegramId: 999,
    now: new Date('2026-06-25T12:00:00.000Z'),
  });

  assert.equal(result.status, 'ok');
  assert.deepEqual(statsInput, {
    chatTelegramId: -100,
    since: new Date('2026-06-24T21:00:00.000Z'),
    until: new Date('2026-06-25T21:00:00.000Z'),
    timeZone: 'Europe/Kiev',
    topUsersLimit: 2,
    topHoursLimit: 3,
    dayLimit: 7,
    excludeUserTelegramId: 999,
  });
  assert.deepEqual(result.stats, {
    period: 'today',
    timeZone: 'Europe/Kiev',
    totalMessages: 4,
    firstSentAt: new Date('2026-06-25T08:00:00.000Z'),
    lastSentAt: new Date('2026-06-25T10:00:00.000Z'),
    byDay: [{ date: '2026-06-25', count: 4 }],
    topUsers: [
      {
        userTelegramId: 111,
        from: 'stasik',
        count: 3,
      },
      {
        userTelegramId: 222,
        from: 'maksym',
        count: 1,
      },
    ],
    peakHours: [{ hour: '2026-06-25 13:00', count: 2 }],
    source: 'stored_messages',
  });
});

test('getRawMessage returns a bounded stored Telegram payload snapshot', async () => {
  const service = new ContextToolService(
    {
      getMessageModel: () => ({
        getRecentMessages: async () => [],
        getMessagesBefore: async () => [],
        searchMessages: async () => [],
        findByMessageTelegramId: async () => null,
        findRawByMessageTelegramId: async (messageId: number) => ({
          telegramId: messageId,
          sentAt: new Date('2026-06-25T10:00:00.000Z'),
          messageType: 'poll',
          payload: {
            update_id: 1,
            message: {
              message_id: messageId,
              poll: {
                question: 'Дата для дс',
                fresh_telegram_field: 'future value',
              },
            },
          },
        }),
        countMessages: async () => 0,
        getChatStats: async () => {
          throw new Error('unused');
        },
      }),
      getMemoryModel: () => ({
        searchByChat: async () => [],
        addMemory: async () => {
          throw new Error('unused');
        },
        deleteById: async () => false,
        listByChat: async () => [],
      }),
      getSummaryModel: () => ({
        getByLevelAscending: async () => [],
        getCount: async () => 0,
      }),
    },
    {
      summarizeText: async () => 'summary',
    },
    {
      maxMessages: 50,
      maxChars: 10_000,
      maxResults: 20,
    },
  );

  const result = await service.getRawMessage(-100, { messageId: 456 });

  assert.equal(result.status, 'ok');
  assert.equal(result.rawMessage?.id, 456);
  assert.equal(result.rawMessage?.messageType, 'poll');
  assert.equal(result.rawMessage?.truncated, false);
  assert.match(
    result.rawMessage?.payloadJson ?? '',
    /"fresh_telegram_field": "future value"/,
  );
});

test('getChatStats maps yesterday across daylight-saving calendar boundaries', async () => {
  let statsInput: unknown;
  const service = new ContextToolService(
    {
      getMessageModel: () => ({
        getRecentMessages: async () => [],
        getMessagesBefore: async () => [],
        searchMessages: async () => [],
        findByMessageTelegramId: async () => null,
        findRawByMessageTelegramId: async () => null,
        countMessages: async () => 0,
        getChatStats: async (input: unknown) => {
          statsInput = input;
          return {
            totalMessages: 0,
            byDay: [],
            topUsers: [],
            peakHours: [],
          };
        },
      }),
      getMemoryModel: () => ({
        searchByChat: async () => [],
        addMemory: async () => {
          throw new Error('unused');
        },
        deleteById: async () => false,
        listByChat: async () => [],
      }),
      getSummaryModel: () => ({
        getByLevelAscending: async () => [],
        getCount: async () => 0,
      }),
    },
    {
      summarizeText: async () => 'summary',
    },
    {
      maxMessages: 50,
      maxChars: 10_000,
      maxResults: 20,
    },
  );

  await service.getChatStats(-100, {
    period: 'yesterday',
    timeZone: 'Europe/Kiev',
    now: new Date('2026-03-29T21:30:00.000Z'),
  });

  assert.deepEqual(statsInput, {
    chatTelegramId: -100,
    since: new Date('2026-03-28T22:00:00.000Z'),
    until: new Date('2026-03-29T21:00:00.000Z'),
    timeZone: 'Europe/Kiev',
    topUsersLimit: 10,
    topHoursLimit: 5,
    dayLimit: 14,
  });
});
