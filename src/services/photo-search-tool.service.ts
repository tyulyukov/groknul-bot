import logger from '../common/logger.js';
import {
  resolvePhotoCandidates,
  type PhotoCandidate,
} from './photo-candidate.service.js';
import {
  PhotoTaskRegistry,
  type PhotoTaskSnapshot,
} from './photo-task-registry.service.js';
import type { SearxngSearchService } from './searxng-search.service.js';
import type { TelegramRichDeliveryService } from './telegram-rich-delivery.service.js';

export interface PhotoSearchToolInput {
  chatTelegramId: number;
  triggerMessageId?: number;
  delivery: TelegramRichDeliveryService;
  searchService: SearxngSearchService;
  photoTasks?: PhotoTaskRegistry;
  runInBackground?: (task: () => Promise<void>) => void;
}

export class PhotoSearchToolService {
  constructor(private readonly input: PhotoSearchToolInput) {}

  async execute(args: Record<string, unknown>): Promise<unknown> {
    const query = this.stringArg(args.query)?.trim().slice(0, 200) ?? '';
    if (!query) {
      return { status: 'invalid_args', reason: 'query_required' };
    }

    const activeTask = this.input.photoTasks?.getActive(
      this.input.chatTelegramId,
    );
    if (activeTask) {
      return {
        status: 'ok',
        reason: 'photo_task_already_running',
        photoTask: activeTask,
      };
    }

    if (!this.input.photoTasks) {
      return { status: 'error', reason: 'photo_task_registry_unavailable' };
    }

    const task = this.input.photoTasks.start({
      chatTelegramId: this.input.chatTelegramId,
      triggerMessageId:
        this.optionalNumberArg(args.replyToMessageId) ??
        this.input.triggerMessageId ??
        0,
      query,
    });
    const requiredTerms = this.stringArrayArg(args.requiredTerms);
    const negativeTerms = this.stringArrayArg(args.negativeTerms);
    const caption = this.stringArg(args.caption)?.trim().slice(0, 200) || query;
    const limit = Math.max(1, Math.min(10, this.numberArg(args.limit, 3)));
    this.runInBackground(() =>
      this.runPhotoSearchTask(task, {
        query,
        caption,
        requiredTerms,
        negativeTerms,
        limit,
      }),
    );

    return {
      status: 'ok',
      reason: 'photo_task_queued',
      photoTask: task,
    };
  }

  private async runPhotoSearchTask(
    task: PhotoTaskSnapshot,
    input: {
      query: string;
      caption: string;
      requiredTerms: string[];
      negativeTerms: string[];
      limit: number;
    },
  ): Promise<void> {
    const photoTasks = this.input.photoTasks;
    if (!photoTasks) return;

    try {
      if (!photoTasks.update(task, { status: 'searching' })) return;
      const searchResult = await this.input.searchService.searchImages({
        chatTelegramId: this.input.chatTelegramId,
        query: input.query,
        categories: ['images'],
        limit: Math.min(10, Math.max(input.limit * 3, input.limit)),
      });

      if (searchResult.status === 'rate_limited') {
        if (!photoTasks.get(task)) return;
        await this.sendPhotoTaskText(
          task,
          `поиск фото на кулдауне, попробуй через ${Math.ceil(
            searchResult.retryAfterMs / 1000,
          )}с`,
        );
        photoTasks.fail(task, 'rate_limited');
        return;
      }

      if (searchResult.status === 'error') {
        if (!photoTasks.get(task)) return;
        await this.sendPhotoTaskText(
          task,
          `не смог поискать фото: ${searchResult.error}`,
        );
        photoTasks.fail(task, searchResult.error);
        return;
      }

      const resolution = resolvePhotoCandidates({
        query: input.query,
        requiredTerms: input.requiredTerms,
        negativeTerms: input.negativeTerms,
        limit: input.limit,
        results: searchResult.results,
      });

      logger.info(
        {
          chatTelegramId: this.input.chatTelegramId,
          query: input.query,
          selected: resolution.selected.map((candidate) =>
            this.logCandidate(candidate),
          ),
          rejectedCount: resolution.rejected.length,
        },
        'Photo search candidates resolved',
      );

      if (resolution.selected.length === 0) {
        if (!photoTasks.get(task)) return;
        await this.sendPhotoTaskText(
          task,
          `не нашел уверенное фото по: ${input.query}`,
        );
        photoTasks.fail(task, 'low_confidence_photo_candidates');
        return;
      }

      if (!photoTasks.update(task, { status: 'sending' })) return;
      const delivery = await this.input.delivery.send(
        this.input.chatTelegramId,
        {
          items: [
            {
              plainText: input.caption,
              replyToMessageId: task.triggerMessageId || undefined,
              attachments: resolution.selected.map((candidate, index) => ({
                type: 'photo',
                fileIdOrUrl: this.photoDeliveryUrl(candidate),
                captionPlainText: index === 0 ? input.caption : undefined,
              })),
            },
          ],
        },
      );
      photoTasks.complete(task, { selectedCount: delivery.deliveries.length });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ error, task }, 'Photo search task failed');
      try {
        await this.sendPhotoTaskText(
          task,
          `не смог отправить фото: ${message}`,
        );
      } catch (sendError) {
        logger.error({ error: sendError, task }, 'Failed to report photo task');
      }
      photoTasks.fail(task, message);
    }
  }

  private async sendPhotoTaskText(
    task: PhotoTaskSnapshot,
    plainText: string,
  ): Promise<void> {
    await this.input.delivery.send(this.input.chatTelegramId, {
      items: [
        {
          plainText,
          replyToMessageId: task.triggerMessageId || undefined,
        },
      ],
    });
  }

  private logCandidate(candidate: PhotoCandidate): Record<string, unknown> {
    return {
      id: candidate.id,
      title: candidate.title,
      imageUrl: candidate.imageUrl,
      deliveryUrl: this.photoDeliveryUrl(candidate),
      sourceUrl: candidate.sourceUrl,
      confidence: candidate.confidence,
      reason: candidate.reason,
    };
  }

  private photoDeliveryUrl(candidate: PhotoCandidate): string {
    if (
      candidate.thumbnailUrl &&
      this.isHttpUrl(candidate.thumbnailUrl) &&
      this.shouldPreferThumbnail(candidate)
    ) {
      return candidate.thumbnailUrl;
    }

    return candidate.imageUrl;
  }

  private shouldPreferThumbnail(candidate: PhotoCandidate): boolean {
    const resolution = this.parseResolution(candidate.resolution);
    if (!resolution) {
      return this.hasUnsupportedPhotoExtension(candidate.imageUrl);
    }

    return (
      resolution.width > 4_096 ||
      resolution.height > 4_096 ||
      resolution.width * resolution.height > 16_777_216 ||
      this.hasUnsupportedPhotoExtension(candidate.imageUrl)
    );
  }

  private parseResolution(
    value: string | undefined,
  ): { width: number; height: number } | null {
    const match = value?.match(/(\d{2,5})\s*[x×]\s*(\d{2,5})/i);
    if (!match) return null;

    const width = Number.parseInt(match[1]!, 10);
    const height = Number.parseInt(match[2]!, 10);
    return Number.isFinite(width) && Number.isFinite(height)
      ? { width, height }
      : null;
  }

  private hasUnsupportedPhotoExtension(value: string): boolean {
    try {
      const pathname = new URL(value).pathname.toLowerCase();
      return /\.(gif|svg|webp)$/i.test(pathname);
    } catch {
      return false;
    }
  }

  private isHttpUrl(value: string): boolean {
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }

  private runInBackground(task: () => Promise<void>): void {
    const runner =
      this.input.runInBackground ??
      ((backgroundTask: () => Promise<void>) => {
        void backgroundTask();
      });
    runner(task);
  }

  private stringArg(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
  }

  private stringArrayArg(value: unknown): string[] {
    return Array.isArray(value)
      ? value
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
      : [];
  }

  private numberArg(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value)
      ? value
      : fallback;
  }

  private optionalNumberArg(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value)
      ? value
      : undefined;
  }
}
