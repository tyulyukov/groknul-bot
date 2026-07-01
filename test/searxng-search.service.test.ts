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
      baseUrl: 'https://searx.example.com',
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

test('image search normalizes SearXNG image URLs and metadata', async () => {
  const requestedUrls: string[] = [];
  const fetcher: typeof fetch = async (url) => {
    requestedUrls.push(String(url));
    return new Response(
      JSON.stringify({
        results: [
          {
            title: 'Brabus B63',
            url: 'https://example.com/source/brabus-b63',
            img_src: 'https://images.example.com/brabus-b63.jpg',
            thumbnail_src: '/image_proxy?url=brabus-b63',
            content: 'Brabus badge close-up',
            source: 'example',
            resolution: '1200x800',
            engine: 'bing images',
            score: 4.5,
          },
          {
            title: 'missing image source',
            url: 'https://example.com/no-image',
          },
          {
            title: '',
            url: 'https://example.com/source/no-title',
            img_src: 'https://images.example.com/no-title.jpg',
            content: 'Brabus metadata without title',
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  const service = new SearxngSearchService(
    {
      baseUrl: 'https://searx.example.com',
      timeoutMs: 500,
      maxResults: 5,
      cacheTtlMs: 0,
      perChatRateLimit: { windowMs: 60_000, maxRequests: 10 },
    },
    fetcher,
  );

  const result = await service.searchImages({
    chatTelegramId: -1,
    query: 'brabus b63',
    limit: 3,
  });

  assert.equal(result.status, 'ok');
  assert.match(requestedUrls[0] ?? '', /categories=images/);
  assert.match(requestedUrls[0] ?? '', /safesearch=1/);
  assert.deepEqual(result.results, [
    {
      title: 'Brabus B63',
      imageUrl: 'https://images.example.com/brabus-b63.jpg',
      thumbnailUrl: 'https://searx.example.com/image_proxy?url=brabus-b63',
      sourceUrl: 'https://example.com/source/brabus-b63',
      snippet: 'Brabus badge close-up',
      source: 'example',
      resolution: '1200x800',
      engine: 'bing images',
      score: 4.5,
    },
    {
      title: '',
      imageUrl: 'https://images.example.com/no-title.jpg',
      sourceUrl: 'https://example.com/source/no-title',
      snippet: 'Brabus metadata without title',
    },
  ]);
});

test('image search drops local SearXNG proxy thumbnails that Telegram cannot fetch', async () => {
  const service = new SearxngSearchService(
    {
      baseUrl: 'http://127.0.0.1:8080',
      timeoutMs: 500,
      maxResults: 5,
      cacheTtlMs: 0,
      perChatRateLimit: { windowMs: 60_000, maxRequests: 10 },
    },
    async () =>
      new Response(
        JSON.stringify({
          results: [
            {
              title: 'Brabus B63',
              url: 'https://example.com/source/brabus-b63',
              img_src: 'https://images.example.com/brabus-b63.jpg',
              thumbnail_src: '/image_proxy?url=brabus-b63',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  );

  const result = await service.searchImages({
    chatTelegramId: -1,
    query: 'brabus b63',
  });

  assert.equal(result.status, 'ok');
  assert.deepEqual(result.results, [
    {
      title: 'Brabus B63',
      imageUrl: 'https://images.example.com/brabus-b63.jpg',
      sourceUrl: 'https://example.com/source/brabus-b63',
    },
  ]);
});

test('image search drops non-public SearXNG proxy thumbnails', async () => {
  const baseUrls = [
    'http://searx.localhost',
    'http://169.254.1.10',
    'http://100.64.0.10',
    'http://100.127.255.254',
    'http://[fd00::1]',
    'http://[fe80::1]',
    'http://[::ffff:127.0.0.1]',
    'http://[::ffff:10.0.0.1]',
  ];

  for (const baseUrl of baseUrls) {
    const service = new SearxngSearchService(
      {
        baseUrl,
        timeoutMs: 500,
        maxResults: 5,
        cacheTtlMs: 0,
        perChatRateLimit: { windowMs: 60_000, maxRequests: 10 },
      },
      async () =>
        new Response(
          JSON.stringify({
            results: [
              {
                title: 'Brabus B63',
                url: 'https://example.com/source/brabus-b63',
                img_src: 'https://images.example.com/brabus-b63.jpg',
                thumbnail_src: '/image_proxy?url=brabus-b63',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );

    const result = await service.searchImages({
      chatTelegramId: -1,
      query: 'brabus b63',
    });

    assert.equal(result.status, 'ok');
    assert.equal(result.results[0]?.thumbnailUrl, undefined, baseUrl);
  }
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
