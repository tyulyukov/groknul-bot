import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '../common/config.js';
import logger from '../common/logger.js';
import type {
  DownloadedTelegramMedia,
  MediaProcessorLike,
  SelectedTelegramMedia,
  TelegramFileApi,
} from '../common/media-context.js';

const execFileAsync = promisify(execFile);
const WHISPER_STDOUT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

export interface LocalMediaProcessorOptions {
  telegramBotToken: string;
  tempDir: string;
  downloadTimeoutMs: number;
  whisperPythonPath: string;
  whisperScriptPath: string;
  whisperModel: string;
  whisperTimeoutMs: number;
  ffmpegPath: string;
  ffprobePath: string;
  ffmpegTimeoutMs: number;
  fetchFn: typeof fetch;
}

type WhisperOutput = {
  text?: unknown;
  language?: unknown;
  duration?: unknown;
};

export class LocalMediaProcessor implements MediaProcessorLike {
  constructor(
    private readonly options: LocalMediaProcessorOptions = {
      telegramBotToken: config.telegram.apiKey,
      tempDir: config.media.tempDir,
      downloadTimeoutMs: config.media.downloadTimeoutMs,
      whisperPythonPath: config.media.whisperPythonPath,
      whisperScriptPath: config.media.whisperScriptPath,
      whisperModel: config.media.whisperModel,
      whisperTimeoutMs: config.media.whisperTimeoutMs,
      ffmpegPath: config.media.ffmpegPath,
      ffprobePath: config.media.ffprobePath,
      ffmpegTimeoutMs: config.media.ffmpegTimeoutMs,
      fetchFn: fetch,
    },
  ) {}

  async downloadTelegramFile(
    media: SelectedTelegramMedia,
    api: TelegramFileApi,
  ): Promise<DownloadedTelegramMedia | null> {
    const telegramFile = await api.getFile(media.fileId);
    if (!telegramFile.file_path) return null;

    await mkdir(this.options.tempDir, { recursive: true });
    const workDir = await mkdtemp(path.join(this.options.tempDir, 'telegram-'));
    try {
      const extension = this.extensionFor(media, telegramFile.file_path);
      const localPath = path.join(workDir, `media${extension}`);

      if (path.isAbsolute(telegramFile.file_path)) {
        await copyFile(telegramFile.file_path, localPath);
      } else {
        const url = `https://api.telegram.org/file/bot${this.options.telegramBotToken}/${telegramFile.file_path}`;
        const response = await this.options.fetchFn(url, {
          signal: AbortSignal.timeout(this.options.downloadTimeoutMs),
        });
        if (!response.ok) {
          throw new Error(
            `Telegram file download failed with HTTP ${response.status}`,
          );
        }

        const arrayBuffer = await response.arrayBuffer();
        await writeFile(localPath, Buffer.from(arrayBuffer));
      }

      return {
        localPath,
        cleanupPaths: [workDir],
        mimeType: media.mimeType,
      };
    } catch (error) {
      await rm(workDir, { recursive: true, force: true }).catch(
        (cleanupError) =>
          logger.warn(
            { error: cleanupError, cleanupPath: workDir },
            'Failed to remove media temp path after download failure',
          ),
      );
      throw error;
    }
  }

  async readAsDataUrl(media: DownloadedTelegramMedia): Promise<string> {
    const content = await readFile(media.localPath);
    return `data:${media.mimeType};base64,${content.toString('base64')}`;
  }

  async transcribe(media: DownloadedTelegramMedia): Promise<string> {
    const { stdout } = await execFileAsync(
      this.options.whisperPythonPath,
      [this.options.whisperScriptPath, media.localPath],
      {
        env: {
          ...process.env,
          WHISPER_MODEL: this.options.whisperModel,
        },
        timeout: this.options.whisperTimeoutMs,
        maxBuffer: WHISPER_STDOUT_MAX_BUFFER_BYTES,
      },
    );

    const parsed = JSON.parse(stdout) as WhisperOutput;
    return typeof parsed.text === 'string' ? parsed.text.trim() : '';
  }

  async extractFrameDataUrls(
    media: DownloadedTelegramMedia,
    maxFrames: number,
  ): Promise<string[]> {
    const frameLimit = Math.max(1, Math.floor(maxFrames));
    const frameDir = await mkdtemp(
      path.join(path.dirname(media.localPath), 'frames-'),
    );

    const duration = await this.probeDuration(media.localPath);
    const frameRate =
      duration && duration > 0 ? Math.min(1, frameLimit / duration) : 1 / 3;
    const outputPattern = path.join(frameDir, 'frame-%03d.jpg');

    await execFileAsync(
      this.options.ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        media.localPath,
        '-vf',
        `fps=${frameRate.toFixed(4)},scale=640:-2`,
        '-frames:v',
        String(frameLimit),
        outputPattern,
      ],
      {
        timeout: this.options.ffmpegTimeoutMs,
        maxBuffer: 1024 * 1024,
      },
    );

    const files = (await readdir(frameDir))
      .filter((file) => file.endsWith('.jpg'))
      .sort()
      .slice(0, frameLimit);

    return Promise.all(
      files.map(async (file) => {
        const content = await readFile(path.join(frameDir, file));
        return `data:image/jpeg;base64,${content.toString('base64')}`;
      }),
    );
  }

  async cleanup(media: DownloadedTelegramMedia): Promise<void> {
    await Promise.all(
      media.cleanupPaths.map((cleanupPath) =>
        rm(cleanupPath, { recursive: true, force: true }).catch((error) =>
          logger.warn(
            { error, cleanupPath },
            'Failed to remove media temp path',
          ),
        ),
      ),
    );
  }

  private async probeDuration(localPath: string): Promise<number | null> {
    try {
      const { stdout } = await execFileAsync(
        this.options.ffprobePath,
        [
          '-v',
          'error',
          '-show_entries',
          'format=duration',
          '-of',
          'default=noprint_wrappers=1:nokey=1',
          localPath,
        ],
        {
          timeout: Math.min(this.options.ffmpegTimeoutMs, 10_000),
          maxBuffer: 64 * 1024,
        },
      );
      const duration = Number.parseFloat(stdout.trim());
      return Number.isFinite(duration) ? duration : null;
    } catch (error) {
      logger.warn(
        { error, fileHash: this.pathHash(localPath) },
        'Failed to probe media duration; using default frame sampling',
      );
      return null;
    }
  }

  private extensionFor(media: SelectedTelegramMedia, filePath: string): string {
    const parsed = path.extname(filePath.split('?')[0] ?? '');
    if (parsed) return parsed;
    if (media.fileName) {
      const fileNameExt = path.extname(media.fileName);
      if (fileNameExt) return fileNameExt;
    }

    if (media.mimeType === 'image/jpeg') return '.jpg';
    if (media.mimeType === 'image/png') return '.png';
    if (media.mimeType === 'audio/ogg') return '.ogg';
    if (media.mimeType === 'audio/mpeg') return '.mp3';
    if (media.mimeType === 'video/mp4') return '.mp4';
    return '.bin';
  }

  private pathHash(localPath: string): string {
    return createHash('sha256')
      .update(path.basename(localPath))
      .digest('hex')
      .slice(0, 12);
  }
}
