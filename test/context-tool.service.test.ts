import assert from 'node:assert/strict';
import test from 'node:test';
import { ContextToolService } from '../src/services/context-tool.service.js';

test('getRecentMessages returns too_large when requested context exceeds hard caps', async () => {
  const service = new ContextToolService(
    {
      getMessageModel: () => ({
        getRecentMessages: async () => [],
        searchMessages: async () => [],
        findByMessageTelegramId: async () => null,
        countMessages: async () => 0,
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

test('getChatDigest reads highest-level summaries before recent level-0 summaries', async () => {
  const service = new ContextToolService(
    {
      getMessageModel: () => ({
        getRecentMessages: async () => [],
        searchMessages: async () => [],
        findByMessageTelegramId: async () => null,
        countMessages: async () => 0,
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
