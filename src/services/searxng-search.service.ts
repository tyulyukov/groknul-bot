import type { Config } from '../common/config.js';
import logger from '../common/logger.js';

export interface WebSearchInput {
  chatTelegramId: number;
  query: string;
  categories?: string[];
  language?: string;
  timeRange?: 'day' | 'month' | 'year';
  limit?: number;
}

export interface WebSearchResultItem {
  title: string;
  url: string;
  snippet: string;
  engine?: string;
  score?: number;
}

export type WebSearchResult =
  | {
      status: 'ok';
      query: string;
      results: WebSearchResultItem[];
      cached: boolean;
    }
  | {
      status: 'rate_limited';
      retryAfterMs: number;
    }
  | {
      status: 'error';
      error: string;
    };

interface SearxngRawResult {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  engine?: unknown;
  score?: unknown;
}

interface SearxngRawResponse {
  results?: SearxngRawResult[];
}

export class SearxngSearchService {
  private readonly cache = new Map<
    string,
    { expiresAt: number; result: WebSearchResult }
  >();
  private readonly chatRequests = new Map<number, number[]>();

  constructor(
    private readonly options: Config['searxng'],
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async search(input: WebSearchInput): Promise<WebSearchResult> {
    const limit = Math.max(
      1,
      Math.min(input.limit ?? this.options.maxResults, this.options.maxResults),
    );
    const cacheKey = JSON.stringify({
      query: input.query,
      categories: input.categories,
      language: input.language,
      timeRange: input.timeRange,
      limit,
    });
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return { ...cached.result, cached: true } as WebSearchResult;
    }

    const limited = this.checkRateLimit(input.chatTelegramId);
    if (limited) return limited;

    try {
      const url = new URL('/search', this.options.baseUrl);
      url.searchParams.set('q', input.query);
      url.searchParams.set('format', 'json');
      url.searchParams.set('pageno', '1');
      if (input.categories?.length) {
        url.searchParams.set('categories', input.categories.join(','));
      }
      if (input.language) {
        url.searchParams.set('language', input.language);
      }
      if (input.timeRange) {
        url.searchParams.set('time_range', input.timeRange);
      }

      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        this.options.timeoutMs,
      );
      const response = await this.fetcher(url, { signal: controller.signal });
      clearTimeout(timeout);

      if (!response.ok) {
        return {
          status: 'error',
          error: `SearXNG returned HTTP ${response.status}`,
        };
      }

      const raw = (await response.json()) as SearxngRawResponse;
      const result: WebSearchResult = {
        status: 'ok',
        query: input.query,
        results: this.normalize(raw.results ?? []).slice(0, limit),
        cached: false,
      };

      if (this.options.cacheTtlMs > 0) {
        this.cache.set(cacheKey, {
          expiresAt: Date.now() + this.options.cacheTtlMs,
          result,
        });
      }

      logger.info(
        {
          queryLength: input.query.length,
          resultCount: result.results.length,
        },
        'SearXNG search completed',
      );

      return result;
    } catch (error) {
      return {
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private normalize(rawResults: SearxngRawResult[]): WebSearchResultItem[] {
    return rawResults
      .map((item) => ({
        title: typeof item.title === 'string' ? item.title.trim() : '',
        url: typeof item.url === 'string' ? item.url.trim() : '',
        snippet: typeof item.content === 'string' ? item.content.trim() : '',
        engine: typeof item.engine === 'string' ? item.engine : undefined,
        score: typeof item.score === 'number' ? item.score : undefined,
      }))
      .filter((item) => item.title.length > 0 && item.url.length > 0);
  }

  private checkRateLimit(chatTelegramId: number): WebSearchResult | null {
    const now = Date.now();
    const windowStart = now - this.options.perChatRateLimit.windowMs;
    const requests = (this.chatRequests.get(chatTelegramId) ?? []).filter(
      (timestamp) => timestamp >= windowStart,
    );

    if (requests.length >= this.options.perChatRateLimit.maxRequests) {
      const oldest = requests[0] ?? now;
      return {
        status: 'rate_limited',
        retryAfterMs:
          oldest + this.options.perChatRateLimit.windowMs - now,
      };
    }

    requests.push(now);
    this.chatRequests.set(chatTelegramId, requests);
    return null;
  }
}
