export type PhotoTaskStatus = 'queued' | 'searching' | 'sending';

export interface PhotoTaskSnapshot {
  id: string;
  chatTelegramId: number;
  triggerMessageId: number;
  query: string;
  status: PhotoTaskStatus;
  startedAt: string;
  updatedAt: string;
  selectedCount?: number;
  error?: string;
}

export interface StartPhotoTaskInput {
  chatTelegramId: number;
  triggerMessageId: number;
  query: string;
}

export class PhotoTaskRegistry {
  private readonly tasks = new Map<number, PhotoTaskSnapshot>();
  private counter = 0;

  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly activeTtlMs = 10 * 60 * 1000,
  ) {}

  start(input: StartPhotoTaskInput): PhotoTaskSnapshot {
    this.cleanup(input.chatTelegramId);

    const now = this.now().toISOString();
    const task: PhotoTaskSnapshot = {
      id: `photo-${this.now().getTime()}-${++this.counter}`,
      chatTelegramId: input.chatTelegramId,
      triggerMessageId: input.triggerMessageId,
      query: input.query,
      status: 'queued',
      startedAt: now,
      updatedAt: now,
    };

    this.tasks.set(input.chatTelegramId, task);
    return task;
  }

  getActive(chatTelegramId: number): PhotoTaskSnapshot | undefined {
    this.cleanup(chatTelegramId);
    return this.tasks.get(chatTelegramId);
  }

  get(task: PhotoTaskSnapshot): PhotoTaskSnapshot | undefined {
    this.cleanup(task.chatTelegramId);
    const current = this.tasks.get(task.chatTelegramId);
    return current?.id === task.id ? current : undefined;
  }

  update(
    task: PhotoTaskSnapshot,
    patch: Partial<
      Pick<PhotoTaskSnapshot, 'status' | 'selectedCount' | 'error'>
    >,
  ): PhotoTaskSnapshot | undefined {
    const current = this.get(task);
    if (!current) return undefined;

    const updated: PhotoTaskSnapshot = {
      ...current,
      ...patch,
      updatedAt: this.now().toISOString(),
    };

    this.tasks.set(task.chatTelegramId, updated);
    return updated;
  }

  complete(
    task: PhotoTaskSnapshot,
    patch: Partial<Pick<PhotoTaskSnapshot, 'selectedCount'>> = {},
  ): void {
    if (this.update(task, patch)) {
      this.tasks.delete(task.chatTelegramId);
    }
  }

  fail(task: PhotoTaskSnapshot, error: string): void {
    if (this.update(task, { error })) {
      this.tasks.delete(task.chatTelegramId);
    }
  }

  private cleanup(chatTelegramId: number): void {
    const current = this.tasks.get(chatTelegramId);
    if (!current) return;

    const updatedAt = new Date(current.updatedAt).getTime();
    if (!Number.isFinite(updatedAt)) {
      this.tasks.delete(chatTelegramId);
      return;
    }

    if (this.now().getTime() - updatedAt > this.activeTtlMs) {
      this.tasks.delete(chatTelegramId);
    }
  }
}
