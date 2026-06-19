import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Message as TelegramMessage } from 'grammy/types';
import { LocalMediaProcessor } from '../src/services/local-media-processor.service.js';
import {
  MediaContextService,
  selectTelegramMedia,
  type DownloadedTelegramMedia,
  type MediaProcessorLike,
} from '../src/services/media-context.service.js';

const createMediaContextService = (
  processor: MediaProcessorLike,
  analyzer: {
    analyzeImages: (images: string[], prompt: string) => Promise<string>;
  },
  options: { maxVideoFrames?: number; maxTranscriptChars?: number } = {},
): MediaContextService =>
  new MediaContextService(processor, analyzer, {
    maxVideoFrames: options.maxVideoFrames ?? 10,
    maxTranscriptChars: options.maxTranscriptChars ?? 8_000,
  });

class FakeMediaProcessor implements MediaProcessorLike {
  downloaded: DownloadedTelegramMedia[] = [];
  cleaned: DownloadedTelegramMedia[] = [];
  transcribed: DownloadedTelegramMedia[] = [];
  extracted: { media: DownloadedTelegramMedia; maxFrames: number }[] = [];
  imageDataUrls: string[] = [];

  constructor(private readonly file: DownloadedTelegramMedia) {}

  async downloadTelegramFile(): Promise<DownloadedTelegramMedia> {
    this.downloaded.push(this.file);
    return this.file;
  }

  async readAsDataUrl(): Promise<string> {
    return this.imageDataUrls[0] ?? 'data:image/jpeg;base64,image';
  }

  async transcribe(media: DownloadedTelegramMedia): Promise<string> {
    this.transcribed.push(media);
    return 'hello from local whisper';
  }

  async extractFrameDataUrls(
    media: DownloadedTelegramMedia,
    maxFrames: number,
  ): Promise<string[]> {
    this.extracted.push({ media, maxFrames });
    return Array.from(
      { length: Math.min(12, maxFrames) },
      (_, index) => `data:image/jpeg;base64,frame-${index + 1}`,
    );
  }

  async cleanup(media: DownloadedTelegramMedia): Promise<void> {
    this.cleaned.push(media);
  }
}

test('selectTelegramMedia treats Telegram video notes as circle video messages', () => {
  const selected = selectTelegramMedia({
    message_id: 100,
    date: 1_778_800_000,
    chat: { id: -100, type: 'group', title: 'chat' },
    video_note: {
      file_id: 'circle-file',
      file_unique_id: 'circle-unique',
      length: 384,
      duration: 7,
    },
  } as TelegramMessage);

  assert.deepEqual(selected, {
    kind: 'video_note',
    label: 'Circle video message',
    fileId: 'circle-file',
    mimeType: 'video/mp4',
    transcribe: true,
    analyzeFrames: true,
    duration: 7,
  });
});

test('selectTelegramMedia treats audio documents as transcribable media', () => {
  const selected = selectTelegramMedia({
    message_id: 100,
    date: 1_778_800_000,
    chat: { id: -100, type: 'group', title: 'chat' },
    document: {
      file_id: 'audio-doc',
      file_unique_id: 'audio-doc-unique',
      file_name: 'meeting.ogg',
      mime_type: 'audio/ogg',
    },
  } as TelegramMessage);

  assert.deepEqual(selected, {
    kind: 'audio_document',
    label: 'Audio document',
    fileId: 'audio-doc',
    mimeType: 'audio/ogg',
    transcribe: true,
    analyzeFrames: false,
    fileName: 'meeting.ogg',
  });
});

test('MediaContextService transcribes voice messages and stores no frame context', async () => {
  const media = {
    localPath: '/tmp/voice.oga',
    cleanupPaths: ['/tmp/voice.oga'],
    mimeType: 'audio/ogg',
  };
  const processor = new FakeMediaProcessor(media);
  const analyzedImages: string[][] = [];
  const service = createMediaContextService(processor, {
    analyzeImages: async (images) => {
      analyzedImages.push(images);
      return 'should not be used';
    },
  });

  const context = await service.buildContext(
    {
      message_id: 101,
      date: 1_778_800_000,
      chat: { id: -100, type: 'group', title: 'chat' },
      voice: {
        file_id: 'voice-file',
        file_unique_id: 'voice-unique',
        duration: 4,
        mime_type: 'audio/ogg',
      },
    } as TelegramMessage,
    { getFile: async () => ({ file_path: 'voice/file.oga' }) },
  );

  assert.match(context ?? '', /Voice message transcript:/);
  assert.match(context ?? '', /hello from local whisper/);
  assert.equal(processor.transcribed.length, 1);
  assert.equal(processor.extracted.length, 0);
  assert.equal(analyzedImages.length, 0);
  assert.deepEqual(processor.cleaned, [media]);
});

test('MediaContextService truncates long transcripts before storing context', async () => {
  const media = {
    localPath: '/tmp/voice.oga',
    cleanupPaths: ['/tmp/voice.oga'],
    mimeType: 'audio/ogg',
  };
  const processor = new FakeMediaProcessor(media);
  processor.transcribe = async () => 'abcdefghijklmnopqrstuvwxyz';
  const service = createMediaContextService(
    processor,
    {
      analyzeImages: async () => 'should not be used',
    },
    { maxTranscriptChars: 12 },
  );

  const context = await service.buildContext(
    {
      message_id: 106,
      date: 1_778_800_000,
      chat: { id: -100, type: 'group', title: 'chat' },
      voice: {
        file_id: 'voice-file',
        file_unique_id: 'voice-unique',
        duration: 4,
        mime_type: 'audio/ogg',
      },
    } as TelegramMessage,
    { getFile: async () => ({ file_path: 'voice/file.oga' }) },
  );

  assert.match(context ?? '', /abcdefghijkl/);
  assert.match(context ?? '', /Transcript truncated to 12 characters/);
  assert.doesNotMatch(context ?? '', /mnopqrstuvwxyz/);
});

test('MediaContextService gives video notes transcript and at most ten visual frames', async () => {
  const media = {
    localPath: '/tmp/circle.mp4',
    cleanupPaths: ['/tmp/circle.mp4'],
    mimeType: 'video/mp4',
  };
  const processor = new FakeMediaProcessor(media);
  const analyzedImages: string[][] = [];
  const service = createMediaContextService(processor, {
    analyzeImages: async (images, prompt) => {
      analyzedImages.push(images);
      assert.match(prompt, /chronological frames/i);
      return 'a person is speaking to camera';
    },
  });

  const context = await service.buildContext(
    {
      message_id: 102,
      date: 1_778_800_000,
      chat: { id: -100, type: 'group', title: 'chat' },
      video_note: {
        file_id: 'circle-file',
        file_unique_id: 'circle-unique',
        length: 384,
        duration: 7,
      },
    } as TelegramMessage,
    { getFile: async () => ({ file_path: 'video/file.mp4' }) },
  );

  assert.match(context ?? '', /Circle video message transcript:/);
  assert.match(context ?? '', /hello from local whisper/);
  assert.match(context ?? '', /Circle video message visual context:/);
  assert.match(context ?? '', /a person is speaking to camera/);
  assert.equal(processor.extracted[0]?.maxFrames, 10);
  assert.equal(analyzedImages[0]?.length, 10);
  assert.deepEqual(processor.cleaned, [media]);
});

test('MediaContextService clamps video frame analysis to the hard maximum', async () => {
  const media = {
    localPath: '/tmp/video.mp4',
    cleanupPaths: ['/tmp/video.mp4'],
    mimeType: 'video/mp4',
  };
  const processor = new FakeMediaProcessor(media);
  const service = createMediaContextService(
    processor,
    {
      analyzeImages: async (images) => `saw ${images.length} frames`,
    },
    { maxVideoFrames: 99 },
  );

  await service.buildContext(
    {
      message_id: 104,
      date: 1_778_800_000,
      chat: { id: -100, type: 'group', title: 'chat' },
      video: {
        file_id: 'video-file',
        file_unique_id: 'video-unique',
        width: 1280,
        height: 720,
        duration: 12,
      },
    } as TelegramMessage,
    { getFile: async () => ({ file_path: 'video/file.mp4' }) },
  );

  assert.equal(processor.extracted[0]?.maxFrames, 10);
});

test('MediaContextService keeps photo analysis on the media context path', async () => {
  const media = {
    localPath: '/tmp/photo.jpg',
    cleanupPaths: ['/tmp/photo.jpg'],
    mimeType: 'image/jpeg',
  };
  const processor = new FakeMediaProcessor(media);
  const service = createMediaContextService(processor, {
    analyzeImages: async (images, prompt) => {
      assert.deepEqual(images, ['data:image/jpeg;base64,image']);
      assert.match(prompt, /single Telegram image/i);
      return 'a screenshot of a release checklist';
    },
  });

  const context = await service.buildContext(
    {
      message_id: 103,
      date: 1_778_800_000,
      chat: { id: -100, type: 'group', title: 'chat' },
      photo: [
        {
          file_id: 'small',
          file_unique_id: 'small-unique',
          width: 90,
          height: 90,
        },
        {
          file_id: 'large',
          file_unique_id: 'large-unique',
          width: 1280,
          height: 720,
        },
      ],
    } as TelegramMessage,
    { getFile: async () => ({ file_path: 'photo/file.jpg' }) },
  );

  assert.match(context ?? '', /Image context:/);
  assert.match(context ?? '', /a screenshot of a release checklist/);
  assert.equal(processor.transcribed.length, 0);
  assert.equal(processor.extracted.length, 0);
  assert.deepEqual(processor.cleaned, [media]);
});

test('MediaContextService does not store metadata-only media context', async () => {
  const media = {
    localPath: '/tmp/video.mp4',
    cleanupPaths: ['/tmp/video.mp4'],
    mimeType: 'video/mp4',
  };
  const processor = new FakeMediaProcessor(media);
  processor.transcribe = async () => '';
  processor.extractFrameDataUrls = async () => [];
  const service = createMediaContextService(processor, {
    analyzeImages: async () => 'should not be used',
  });

  const context = await service.buildContext(
    {
      message_id: 105,
      date: 1_778_800_000,
      chat: { id: -100, type: 'group', title: 'chat' },
      video: {
        file_id: 'video-file',
        file_unique_id: 'video-unique',
        width: 1280,
        height: 720,
        duration: 12,
      },
    } as TelegramMessage,
    { getFile: async () => ({ file_path: 'video/file.mp4' }) },
  );

  assert.equal(context, undefined);
});

test('LocalMediaProcessor downloads Telegram cloud files into a temp file', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'groknul-test-'));
  const processor = new LocalMediaProcessor({
    telegramBotToken: 'telegram-token',
    tempDir,
    downloadTimeoutMs: 1_000,
    whisperPythonPath: 'python',
    whisperScriptPath: 'script.py',
    whisperModel: 'base',
    whisperTimeoutMs: 1_000,
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
    ffmpegTimeoutMs: 1_000,
    fetchFn: async (url) => {
      assert.equal(
        String(url),
        'https://api.telegram.org/file/bottelegram-token/voice/file.oga',
      );
      return new Response('audio bytes');
    },
  });

  try {
    const downloaded = await processor.downloadTelegramFile(
      {
        kind: 'voice',
        label: 'Voice message',
        fileId: 'voice-file',
        mimeType: 'audio/ogg',
        transcribe: true,
        analyzeFrames: false,
      },
      { getFile: async () => ({ file_path: 'voice/file.oga' }) },
    );

    assert.ok(downloaded);
    assert.equal(downloaded.mimeType, 'audio/ogg');
    assert.equal(await readFile(downloaded.localPath, 'utf8'), 'audio bytes');
    await processor.cleanup(downloaded);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('LocalMediaProcessor removes temp directory when Telegram download fails', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'groknul-test-'));
  const processor = new LocalMediaProcessor({
    telegramBotToken: 'telegram-token',
    tempDir,
    downloadTimeoutMs: 1_000,
    whisperPythonPath: 'python',
    whisperScriptPath: 'script.py',
    whisperModel: 'base',
    whisperTimeoutMs: 1_000,
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
    ffmpegTimeoutMs: 1_000,
    fetchFn: async () => new Response('nope', { status: 500 }),
  });

  try {
    await assert.rejects(
      processor.downloadTelegramFile(
        {
          kind: 'voice',
          label: 'Voice message',
          fileId: 'voice-file',
          mimeType: 'audio/ogg',
          transcribe: true,
          analyzeFrames: false,
        },
        { getFile: async () => ({ file_path: 'voice/file.oga' }) },
      ),
      /HTTP 500/,
    );

    assert.deepEqual(await readdir(tempDir), []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('LocalMediaProcessor aborts stalled Telegram downloads and removes temp files', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'groknul-test-'));
  const processor = new LocalMediaProcessor({
    telegramBotToken: 'telegram-token',
    tempDir,
    downloadTimeoutMs: 5,
    whisperPythonPath: 'python',
    whisperScriptPath: 'script.py',
    whisperModel: 'base',
    whisperTimeoutMs: 1_000,
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
    ffmpegTimeoutMs: 1_000,
    fetchFn: (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      }),
  });

  try {
    await assert.rejects(
      processor.downloadTelegramFile(
        {
          kind: 'voice',
          label: 'Voice message',
          fileId: 'voice-file',
          mimeType: 'audio/ogg',
          transcribe: true,
          analyzeFrames: false,
        },
        { getFile: async () => ({ file_path: 'voice/file.oga' }) },
      ),
      /AbortError|aborted/,
    );

    assert.deepEqual(await readdir(tempDir), []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('LocalMediaProcessor copies absolute paths from a local Telegram Bot API server', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'groknul-test-'));
  const source = path.join(tempDir, 'source.mp4');
  await writeFile(source, 'video bytes');
  const processor = new LocalMediaProcessor({
    telegramBotToken: 'telegram-token',
    tempDir,
    downloadTimeoutMs: 1_000,
    whisperPythonPath: 'python',
    whisperScriptPath: 'script.py',
    whisperModel: 'base',
    whisperTimeoutMs: 1_000,
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
    ffmpegTimeoutMs: 1_000,
    fetchFn: async () => {
      throw new Error('fetch should not be used for local file paths');
    },
  });

  try {
    const downloaded = await processor.downloadTelegramFile(
      {
        kind: 'video',
        label: 'Video attachment',
        fileId: 'video-file',
        mimeType: 'video/mp4',
        transcribe: true,
        analyzeFrames: true,
      },
      { getFile: async () => ({ file_path: source }) },
    );

    assert.ok(downloaded);
    assert.equal(await readFile(downloaded.localPath, 'utf8'), 'video bytes');
    await processor.cleanup(downloaded);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
