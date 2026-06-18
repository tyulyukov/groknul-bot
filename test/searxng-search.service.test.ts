import assert from 'node:assert/strict';
import test from 'node:test';
import { SearxngSearchService } from '../src/services/searxng-search.service.js';

test('web search normalizes SearXNG JSON results and honors requested limit', async () => {
  const requestedUrls: string[] = [];
  const fetcher: typeof fetch = async (url) => {
    requestedUrls.push(String(url));
    return new Response(
      JSON.stringify({
        results: [
          {
            title: 'First',
            url: 'https://example.com/first',
            content: 'First snippet',
            engine: 'duckduckgo',
            score: 2.5,
          },
          {
            title: 'Second',
            url: 'https://example.com/second',
            content: 'Second snippet',
            engine: 'brave',
          },
          {
            title: '',
            url: '',
            content: 'ignored',
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  const service = new SearxngSearchService(
    {
      baseUrl: 'http://searx.local',
      timeoutMs: 500,
      maxResults: 5,
      cacheTtlMs: 0,
      perChatRateLimit: { windowMs: 60_000, maxRequests: 10 },
    },
    fetcher,
  );

  const result = await service.search({
    chatTelegramId: -1,
    query: 'telegram bot api',
    limit: 1,
    categories: ['general'],
    language: 'en',
    timeRange: 'month',
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.results.length, 1);
  assert.deepEqual(result.results[0], {
    title: 'First',
    url: 'https://example.com/first',
    snippet: 'First snippet',
    engine: 'duckduckgo',
    score: 2.5,
  });
  assert.match(requestedUrls[0] ?? '', /format=json/);
  assert.match(requestedUrls[0] ?? '', /categories=general/);
  assert.match(requestedUrls[0] ?? '', /language=en/);
  assert.match(requestedUrls[0] ?? '', /time_range=month/);
});

test('web search rate limits per chat', async () => {
  const service = new SearxngSearchService(
    {
      baseUrl: 'http://searx.local',
      timeoutMs: 500,
      maxResults: 5,
      cacheTtlMs: 0,
      perChatRateLimit: { windowMs: 60_000, maxRequests: 1 },
    },
    async () =>
      new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );

  await service.search({ chatTelegramId: -1, query: 'first' });
  const limited = await service.search({ chatTelegramId: -1, query: 'second' });

  assert.equal(limited.status, 'rate_limited');
});

test('web search serves cache hits without consuming per-chat rate limit', async () => {
  let fetchCount = 0;
  const service = new SearxngSearchService(
    {
      baseUrl: 'http://searx.local',
      timeoutMs: 500,
      maxResults: 5,
      cacheTtlMs: 60_000,
      perChatRateLimit: { windowMs: 60_000, maxRequests: 1 },
    },
    async () => {
      fetchCount += 1;
      return new Response(
        JSON.stringify({
          results: [{ title: 'Cached', url: 'https://example.com' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  );

  const first = await service.search({ chatTelegramId: -1, query: 'same' });
  const second = await service.search({ chatTelegramId: -1, query: 'same' });

  assert.equal(first.status, 'ok');
  assert.equal(second.status, 'ok');
  assert.equal(fetchCount, 1);
});
