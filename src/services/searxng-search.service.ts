import type { Config } from '../common/config.js';
import logger from '../common/logger.js';

export interface WebSearchInput {
  chatTelegramId: number;
  query: string;
  categories?: string[];
  language?: string;
  safeSearch?: 0 | 1 | 2;
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

export interface ImageSearchResultItem {
  title: string;
  imageUrl: string;
  sourceUrl: string;
  snippet?: string;
  thumbnailUrl?: string;
  source?: string;
  resolution?: string;
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

export type ImageSearchResult =
  | {
      status: 'ok';
      query: string;
      results: ImageSearchResultItem[];
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

type RateLimitedSearchResult = {
  status: 'rate_limited';
  retryAfterMs: number;
};

interface SearxngRawResult {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  img_src?: unknown;
  thumbnail_src?: unknown;
  source?: unknown;
  resolution?: unknown;
  engine?: unknown;
  score?: unknown;
}

interface SearxngRawResponse {
  results?: SearxngRawResult[];
}

export class SearxngSearchService {
  private readonly cache = new Map<
    string,
    { expiresAt: number; result: WebSearchResult | ImageSearchResult }
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
      safeSearch: input.safeSearch,
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
      if (typeof input.safeSearch === 'number') {
        url.searchParams.set('safesearch', String(input.safeSearch));
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

  async searchImages(input: WebSearchInput): Promise<ImageSearchResult> {
    const limit = Math.max(
      1,
      Math.min(input.limit ?? this.options.maxResults, this.options.maxResults),
    );
    const categories = input.categories?.length ? input.categories : ['images'];
    const safeSearch = input.safeSearch ?? 1;
    const cacheKey = JSON.stringify({
      kind: 'images',
      query: input.query,
      categories,
      language: input.language,
      safeSearch,
      timeRange: input.timeRange,
      limit,
    });
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return { ...cached.result, cached: true } as ImageSearchResult;
    }

    const limited = this.checkRateLimit(input.chatTelegramId);
    if (limited) return limited;

    try {
      const raw = await this.fetchRawResults({
        ...input,
        categories,
        safeSearch,
      });
      const result: ImageSearchResult = {
        status: 'ok',
        query: input.query,
        results: this.normalizeImages(raw.results ?? []).slice(0, limit),
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
        'SearXNG image search completed',
      );

      return result;
    } catch (error) {
      return {
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async fetchRawResults(
    input: WebSearchInput,
  ): Promise<SearxngRawResponse> {
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
    if (typeof input.safeSearch === 'number') {
      url.searchParams.set('safesearch', String(input.safeSearch));
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
      throw new Error(`SearXNG returned HTTP ${response.status}`);
    }

    return (await response.json()) as SearxngRawResponse;
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

  private normalizeImages(
    rawResults: SearxngRawResult[],
  ): ImageSearchResultItem[] {
    return rawResults
      .map((item) => {
        const title = stringField(item.title) ?? '';
        const imageUrl = this.normalizeExternalHttpUrl(item.img_src, {
          allowRelative: false,
        });
        const sourceUrl = stringField(item.url);
        const thumbnailUrl = this.normalizeExternalHttpUrl(item.thumbnail_src, {
          allowRelative: true,
        });
        if (!imageUrl || !sourceUrl) {
          return null;
        }

        return {
          title,
          imageUrl,
          sourceUrl,
          ...optionalString('snippet', item.content),
          ...(thumbnailUrl ? { thumbnailUrl } : {}),
          ...optionalString('source', item.source),
          ...optionalString('resolution', item.resolution),
          ...optionalString('engine', item.engine),
          ...(typeof item.score === 'number' ? { score: item.score } : {}),
        };
      })
      .filter((item): item is ImageSearchResultItem => item !== null);
  }

  private normalizeExternalHttpUrl(
    value: unknown,
    input: { allowRelative: boolean },
  ): string | undefined {
    const text = stringField(value);
    if (!text) return undefined;

    try {
      const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(text);
      if (!hasScheme && !input.allowRelative) return undefined;

      const url = hasScheme
        ? new URL(text)
        : new URL(text, this.options.baseUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return undefined;
      }

      return isPrivateHost(url.hostname) ? undefined : url.toString();
    } catch {
      return undefined;
    }
  }

  private checkRateLimit(
    chatTelegramId: number,
  ): RateLimitedSearchResult | null {
    const now = Date.now();
    const windowStart = now - this.options.perChatRateLimit.windowMs;
    const requests = (this.chatRequests.get(chatTelegramId) ?? []).filter(
      (timestamp) => timestamp >= windowStart,
    );

    if (requests.length >= this.options.perChatRateLimit.maxRequests) {
      const oldest = requests[0] ?? now;
      return {
        status: 'rate_limited',
        retryAfterMs: oldest + this.options.perChatRateLimit.windowMs - now,
      };
    }

    requests.push(now);
    this.chatRequests.set(chatTelegramId, requests);
    return null;
  }
}

const stringField = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;

const optionalString = <TKey extends string>(
  key: TKey,
  value: unknown,
): Partial<Record<TKey, string>> => {
  const text = stringField(value);
  return text ? ({ [key]: text } as Partial<Record<TKey, string>>) : {};
};

const isPrivateHost = (hostname: string): boolean => {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    host === '::' ||
    host.startsWith('::ffff:') ||
    host === '0.0.0.0' ||
    host.endsWith('.local')
  ) {
    return true;
  }

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const first = Number.parseInt(ipv4[1]!, 10);
    const second = Number.parseInt(ipv4[2]!, 10);
    const third = Number.parseInt(ipv4[3]!, 10);
    const fourth = Number.parseInt(ipv4[4]!, 10);
    if (
      [first, second, third, fourth].some(
        (octet) => !Number.isInteger(octet) || octet < 0 || octet > 255,
      )
    ) {
      return true;
    }

    if (first === 0 || first === 10 || first === 127) return true;
    if (first === 100 && second >= 64 && second <= 127) return true;
    if (first === 169 && second === 254) return true;
    if (first === 172 && second >= 16 && second <= 31) return true;
    if (first === 192 && second === 168) return true;
    if (first >= 224) return true;

    return false;
  }

  const ipv6 = host.includes(':') ? host.match(/^([0-9a-f]{1,4})/i) : null;
  if (ipv6) {
    const firstHextet = Number.parseInt(ipv6[1]!, 16);
    if (!Number.isFinite(firstHextet)) return true;
    if ((firstHextet & 0xfe00) === 0xfc00) return true;
    if ((firstHextet & 0xffc0) === 0xfe80) return true;
    if ((firstHextet & 0xff00) === 0xff00) return true;
  }

  return false;
};
