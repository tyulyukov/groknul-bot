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
  assert.equal(config.openRouter.models.agent, 'openai/gpt-5.4-mini');
  assert.equal(config.openRouter.models.summary, 'openai/gpt-5.4-mini');
  assert.equal(config.openRouter.models.vision, 'openai/gpt-5.4-mini');
  assert.equal(config.searxng.baseUrl, 'http://127.0.0.1:8080');
  assert.equal(config.searxng.maxResults, 5);
  assert.equal(config.agent.maxToolCalls, 10);
});
