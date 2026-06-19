import type { Message as TelegramMessage } from 'grammy/types';
import logger from '../common/logger.js';
import {
  normalizeMediaTextLimit,
  normalizeVideoContextFrameLimit,
  type DownloadedTelegramMedia,
  type MediaProcessorLike,
  type SelectedTelegramMedia,
  type TelegramFileApi,
} from '../common/media-context.js';

export type {
  DownloadedTelegramMedia,
  MediaProcessorLike,
  SelectedTelegramMedia,
  TelegramFileApi,
};

export interface MediaContextVisionAnalyzer {
  analyzeImages(imageBase64DataUrls: string[], prompt: string): Promise<string>;
}

export interface MediaContextServiceOptions {
  maxVideoFrames: number;
  maxTranscriptChars: number;
}

interface ContextSectionTask {
  order: number;
  run(): Promise<string | undefined>;
}

export const selectTelegramMedia = (
  message: TelegramMessage,
): SelectedTelegramMedia | null => {
  if (message.photo?.length) {
    const largestPhoto = message.photo[message.photo.length - 1];
    return mediaSelection({
      kind: 'photo',
      label: 'Image',
      fileId: largestPhoto.file_id,
      mimeType: 'image/jpeg',
      transcribe: false,
      analyzeFrames: false,
    });
  }

  if (message.document?.mime_type?.startsWith('image/')) {
    return mediaSelection({
      kind: 'image_document',
      label: 'Image',
      fileId: message.document.file_id,
      mimeType: message.document.mime_type,
      transcribe: false,
      analyzeFrames: false,
      fileName: message.document.file_name,
    });
  }

  if (message.video) {
    return mediaSelection({
      kind: 'video',
      label: 'Video attachment',
      fileId: message.video.file_id,
      mimeType: message.video.mime_type ?? 'video/mp4',
      transcribe: true,
      analyzeFrames: true,
      fileName: message.video.file_name,
      duration: message.video.duration,
    });
  }

  if (message.video_note) {
    return mediaSelection({
      kind: 'video_note',
      label: 'Circle video message',
      fileId: message.video_note.file_id,
      mimeType: 'video/mp4',
      transcribe: true,
      analyzeFrames: true,
      duration: message.video_note.duration,
    });
  }

  if (message.document?.mime_type?.startsWith('video/')) {
    return mediaSelection({
      kind: 'video_document',
      label: 'Video document',
      fileId: message.document.file_id,
      mimeType: message.document.mime_type,
      transcribe: true,
      analyzeFrames: true,
      fileName: message.document.file_name,
    });
  }

  if (message.document?.mime_type?.startsWith('audio/')) {
    return mediaSelection({
      kind: 'audio_document',
      label: 'Audio document',
      fileId: message.document.file_id,
      mimeType: message.document.mime_type,
      transcribe: true,
      analyzeFrames: false,
      fileName: message.document.file_name,
    });
  }

  if (message.voice) {
    return mediaSelection({
      kind: 'voice',
      label: 'Voice message',
      fileId: message.voice.file_id,
      mimeType: message.voice.mime_type ?? 'audio/ogg',
      transcribe: true,
      analyzeFrames: false,
      duration: message.voice.duration,
    });
  }

  if (message.audio) {
    return mediaSelection({
      kind: 'audio',
      label: 'Audio attachment',
      fileId: message.audio.file_id,
      mimeType: message.audio.mime_type ?? 'audio/mpeg',
      transcribe: true,
      analyzeFrames: false,
      fileName: message.audio.file_name,
      duration: message.audio.duration,
    });
  }

  return null;
};

export class MediaContextService {
  private readonly maxVideoFrames: number;
  private readonly maxTranscriptChars: number;

  constructor(
    private readonly processor: MediaProcessorLike,
    private readonly visionAnalyzer: MediaContextVisionAnalyzer,
    options: MediaContextServiceOptions,
  ) {
    this.maxVideoFrames = normalizeVideoContextFrameLimit(
      options.maxVideoFrames,
    );
    this.maxTranscriptChars = normalizeMediaTextLimit(
      options.maxTranscriptChars,
    );
  }

  async buildContext(
    message: TelegramMessage,
    api: TelegramFileApi,
  ): Promise<string | undefined> {
    const selected = selectTelegramMedia(message);
    if (!selected) return undefined;

    const downloaded = await this.processor.downloadTelegramFile(selected, api);
    if (!downloaded) return undefined;

    try {
      const sectionTasks: ContextSectionTask[] = [];
      const metadata = this.buildMetadata(selected);

      if (selected.transcribe) {
        sectionTasks.push({
          order: 1,
          run: async () => {
            const transcript = await this.safeTranscribe(selected, downloaded);
            return transcript
              ? `${selected.label} transcript:\n${transcript}`
              : undefined;
          },
        });
      }

      if (selected.analyzeFrames) {
        sectionTasks.push({
          order: 2,
          run: async () => {
            const visualContext = await this.safeAnalyzeVideoFrames(
              selected,
              downloaded,
            );
            return visualContext
              ? `${selected.label} visual context:\n${visualContext}`
              : undefined;
          },
        });
      } else if (
        selected.kind === 'photo' ||
        selected.kind === 'image_document'
      ) {
        sectionTasks.push({
          order: 1,
          run: async () => {
            const imageContext = await this.safeAnalyzeImage(
              selected,
              downloaded,
            );
            return imageContext ? `Image context:\n${imageContext}` : undefined;
          },
        });
      }

      const contentSections = (
        await Promise.all(
          sectionTasks.map(async (task) => ({
            order: task.order,
            section: await task.run(),
          })),
        )
      )
        .sort((left, right) => left.order - right.order)
        .map((result) => result.section)
        .filter((section): section is string => !!section);

      const sections =
        metadata && contentSections.length > 0
          ? [metadata, ...contentSections]
          : contentSections;

      return sections.length > 0 ? sections.join('\n\n') : undefined;
    } finally {
      await this.processor.cleanup(downloaded);
    }
  }

  private buildMetadata(selected: SelectedTelegramMedia): string | null {
    const parts: string[] = [];
    if (selected.fileName) parts.push(`file: ${selected.fileName}`);
    if (typeof selected.duration === 'number') {
      parts.push(`duration: ${selected.duration}s`);
    }

    return parts.length > 0
      ? `${selected.label} metadata: ${parts.join(', ')}`
      : null;
  }

  private async safeTranscribe(
    selected: SelectedTelegramMedia,
    downloaded: DownloadedTelegramMedia,
  ): Promise<string> {
    try {
      return this.truncateTranscript(
        (await this.processor.transcribe(downloaded)).trim(),
      );
    } catch (error) {
      logger.error(
        { error, mediaKind: selected.kind },
        'Failed to transcribe Telegram media',
      );
      return '';
    }
  }

  private truncateTranscript(transcript: string): string {
    if (transcript.length <= this.maxTranscriptChars) return transcript;

    return `${transcript.slice(0, this.maxTranscriptChars).trimEnd()}\n[Transcript truncated to ${this.maxTranscriptChars} characters.]`;
  }

  private async safeAnalyzeVideoFrames(
    selected: SelectedTelegramMedia,
    downloaded: DownloadedTelegramMedia,
  ): Promise<string> {
    try {
      const frames = await this.processor.extractFrameDataUrls(
        downloaded,
        this.maxVideoFrames,
      );
      if (frames.length === 0) return '';

      return (
        await this.visionAnalyzer.analyzeImages(
          frames,
          `${selected.label}: analyze these chronological frames from a Telegram video. Describe the visible sequence, people, objects, environment, on-screen text, gestures, notable changes across frames, and any context useful for replying in chat. Do not speculate beyond what is visible.`,
        )
      ).trim();
    } catch (error) {
      logger.error(
        { error, mediaKind: selected.kind },
        'Failed to analyze Telegram video frames',
      );
      return '';
    }
  }

  private async safeAnalyzeImage(
    selected: SelectedTelegramMedia,
    downloaded: DownloadedTelegramMedia,
  ): Promise<string> {
    try {
      const image = await this.processor.readAsDataUrl(downloaded);
      return (
        await this.visionAnalyzer.analyzeImages(
          [image],
          `${selected.label}: analyze this single Telegram image. Describe the overall scene, key objects, spatial relationships, visible text, UI elements, mood, and chat-relevant context.`,
        )
      ).trim();
    } catch (error) {
      logger.error(
        { error, mediaKind: selected.kind },
        'Failed to analyze Telegram image',
      );
      return '';
    }
  }
}

const mediaSelection = (
  media: SelectedTelegramMedia,
): SelectedTelegramMedia => {
  const selected: SelectedTelegramMedia = {
    kind: media.kind,
    label: media.label,
    fileId: media.fileId,
    mimeType: media.mimeType,
    transcribe: media.transcribe,
    analyzeFrames: media.analyzeFrames,
  };

  if (media.fileName) selected.fileName = media.fileName;
  if (typeof media.duration === 'number') selected.duration = media.duration;

  return selected;
};
