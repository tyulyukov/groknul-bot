export const MAX_VIDEO_CONTEXT_FRAMES = 10;
export const DEFAULT_MEDIA_MAX_TRANSCRIPT_CHARS = 8_000;

export const normalizeVideoContextFrameLimit = (value: number): number => {
  if (!Number.isFinite(value)) return MAX_VIDEO_CONTEXT_FRAMES;

  const normalized = Math.floor(value);
  if (normalized < 1) return 1;
  return Math.min(normalized, MAX_VIDEO_CONTEXT_FRAMES);
};

export const normalizeMediaTextLimit = (
  value: number,
  fallback = DEFAULT_MEDIA_MAX_TRANSCRIPT_CHARS,
): number => {
  if (!Number.isFinite(value)) return fallback;

  const normalized = Math.floor(value);
  return normalized < 1 ? fallback : normalized;
};

export type TelegramMediaKind =
  | 'photo'
  | 'image_document'
  | 'voice'
  | 'audio'
  | 'audio_document'
  | 'video'
  | 'video_document'
  | 'video_note';

export interface SelectedTelegramMedia {
  kind: TelegramMediaKind;
  label: string;
  fileId: string;
  mimeType: string;
  transcribe: boolean;
  analyzeFrames: boolean;
  fileName?: string;
  duration?: number;
}

export interface TelegramFileApi {
  getFile(fileId: string): Promise<{ file_path?: string }>;
}

export interface DownloadedTelegramMedia {
  localPath: string;
  cleanupPaths: string[];
  mimeType: string;
}

export interface MediaProcessorLike {
  downloadTelegramFile(
    media: SelectedTelegramMedia,
    api: TelegramFileApi,
  ): Promise<DownloadedTelegramMedia | null>;
  readAsDataUrl(media: DownloadedTelegramMedia): Promise<string>;
  transcribe(media: DownloadedTelegramMedia): Promise<string>;
  extractFrameDataUrls(
    media: DownloadedTelegramMedia,
    maxFrames: number,
  ): Promise<string[]>;
  cleanup(media: DownloadedTelegramMedia): Promise<void>;
}
