import assert from 'node:assert/strict';
import test from 'node:test';
import { createConfig } from '../src/common/config.js';

const requiredEnv = {
  TELEGRAM_BOT_API_KEY: 'telegram-token',
  OPENROUTER_API_KEY: 'openrouter-token',
  MONGODB_URI: 'mongodb://localhost:27017/groknul',
};

test('createConfig loads model names from env with production defaults', () => {
  const config = createConfig({
    ...requiredEnv,
    OPENROUTER_REPLY_MODEL: 'custom/reply',
    OPENROUTER_AGENT_MODEL: 'custom/agent',
    OPENROUTER_SUMMARY_MODEL: 'custom/summary',
    OPENROUTER_VISION_MODEL: 'custom/vision',
  });

  assert.deepEqual(config.openRouter.models, {
    reply: 'custom/reply',
    agent: 'custom/agent',
    summary: 'custom/summary',
    vision: 'custom/vision',
  });
});

test('createConfig defaults OpenRouter and SearXNG agent settings', () => {
  const config = createConfig(requiredEnv);

  assert.equal(config.openRouter.models.reply, 'openai/gpt-5.5');
  assert.equal(config.openRouter.models.agent, 'openai/gpt-5.5');
  assert.equal(config.openRouter.models.summary, 'openai/gpt-5.4-mini');
  assert.equal(config.openRouter.models.vision, 'openai/gpt-5.4-mini');
  assert.equal(config.codex.ownerTelegramId, 870_452_692);
  assert.equal(config.codex.authFilePath, '.data/codex-auth.json');
  assert.equal(config.codex.issuer, 'https://auth.openai.com');
  assert.equal(config.codex.clientId, 'app_EMoamEEZ73f0CkXaXp7hrann');
  assert.equal(config.codex.chatgptBaseUrl, 'https://chatgpt.com/backend-api');
  assert.equal(config.searxng.baseUrl, 'http://127.0.0.1:8080');
  assert.equal(config.searxng.maxResults, 5);
  assert.equal(config.telegram.webhookTimeoutMs, 9_000);
  assert.equal(config.agent.maxToolCalls, 10);
});

test('createConfig allows overriding Codex OAuth settings', () => {
  const config = createConfig({
    ...requiredEnv,
    CODEX_OAUTH_OWNER_TELEGRAM_ID: '42',
    CODEX_OAUTH_AUTH_FILE: '/tmp/codex-auth.json',
    CODEX_OAUTH_ISSUER: 'https://auth.example.test',
    CODEX_OAUTH_CLIENT_ID: 'client-test',
    CODEX_CHATGPT_BASE_URL: 'https://chat.example.test/backend-api',
    CODEX_OAUTH_DEVICE_POLL_MAX_MS: '1000',
  });

  assert.equal(config.codex.ownerTelegramId, 870_452_692);
  assert.equal(config.codex.authFilePath, '/tmp/codex-auth.json');
  assert.equal(config.codex.issuer, 'https://auth.example.test');
  assert.equal(config.codex.clientId, 'client-test');
  assert.equal(config.codex.chatgptBaseUrl, 'https://chat.example.test/backend-api');
  assert.equal(config.codex.devicePollMaxMs, 1_000);
});

test('createConfig allows overriding Telegram webhook timeout', () => {
  const config = createConfig({
    ...requiredEnv,
    TELEGRAM_BOT_WEBHOOK_TIMEOUT_MS: '5000',
  });

  assert.equal(config.telegram.webhookTimeoutMs, 5_000);
});

test('createConfig loads local media processing settings', () => {
  const config = createConfig({
    ...requiredEnv,
    MEDIA_MAX_VIDEO_FRAMES: '6',
    MEDIA_MAX_TRANSCRIPT_CHARS: '1200',
    MEDIA_DOWNLOAD_TIMEOUT_MS: '15000',
    WHISPER_MODEL: 'small',
    WHISPER_TIMEOUT_MS: '90000',
    FFMPEG_TIMEOUT_MS: '30000',
  });

  assert.equal(config.media.maxVideoFrames, 6);
  assert.equal(config.media.maxTranscriptChars, 1_200);
  assert.equal(config.media.downloadTimeoutMs, 15_000);
  assert.equal(config.media.whisperModel, 'small');
  assert.equal(config.media.whisperTimeoutMs, 90_000);
  assert.equal(config.media.ffmpegTimeoutMs, 30_000);
  assert.equal(config.media.whisperPythonPath, '/opt/whisper-venv/bin/python');
  assert.equal(
    config.media.whisperScriptPath,
    `${process.cwd()}/scripts/transcribe-media.py`,
  );
});

test('createConfig caps local media frame extraction at the hard maximum', () => {
  const config = createConfig({
    ...requiredEnv,
    MEDIA_MAX_VIDEO_FRAMES: '99',
  });

  assert.equal(config.media.maxVideoFrames, 10);
});
