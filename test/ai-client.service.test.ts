import assert from 'node:assert/strict';
import test from 'node:test';
import type OpenAI from 'openai';
import { AiClient } from '../src/services/ai-client.service.js';
import {
  CodexAuthUnavailableError,
  CodexProviderUnavailableError,
} from '../src/services/codex-oauth.service.js';

const completion = (
  content = 'ok',
): OpenAI.Chat.Completions.ChatCompletion => ({
  id: 'chatcmpl_test',
  object: 'chat.completion',
  created: 1,
  model: 'test-model',
  choices: [
    {
      index: 0,
      finish_reason: 'stop',
      logprobs: null,
      message: {
        role: 'assistant',
        content,
        refusal: null,
      },
    },
  ],
});

const createOpenAiStub = (
  create: (
    params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  ) => Promise<OpenAI.Chat.Completions.ChatCompletion>,
): OpenAI =>
  ({
    chat: {
      completions: {
        create,
      },
    },
  }) as unknown as OpenAI;

test('AiClient retries retryable OpenRouter response body failures', async () => {
  let calls = 0;
  const openai = createOpenAiStub(async () => {
    calls += 1;

    if (calls === 1) {
      const error = new Error(
        'Invalid response body while trying to fetch https://openrouter.ai/api/v1/chat/completions: Premature close',
      ) as Error & { name: string; code: string; errno: string };
      error.name = 'FetchError';
      error.code = 'ERR_STREAM_PREMATURE_CLOSE';
      error.errno = 'ERR_STREAM_PREMATURE_CLOSE';
      throw error;
    }

    return completion('recovered');
  });
  const client = new AiClient(openai, {
    maxAttempts: 2,
    baseDelayMs: 0,
    maxDelayMs: 0,
  });

  const result = await client.complete({
    model: 'test-model',
    messages: [{ role: 'user', content: 'hello' }],
  });

  assert.equal(calls, 2);
  assert.equal(result.message.content, 'recovered');
});

test('AiClient does not retry non-retryable OpenRouter errors', async () => {
  let calls = 0;
  const openai = createOpenAiStub(async () => {
    calls += 1;
    const error = new Error('Bad request') as Error & { status: number };
    error.status = 400;
    throw error;
  });
  const client = new AiClient(openai, {
    maxAttempts: 3,
    baseDelayMs: 0,
    maxDelayMs: 0,
  });

  await assert.rejects(
    client.completeRaw({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }],
    }),
    /Bad request/,
  );

  assert.equal(calls, 1);
});

test('AiClient forwards reasoning effort to OpenRouter chat completions', async () => {
  let seenParams:
    | OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming
    | undefined;
  const openai = createOpenAiStub(async (params) => {
    seenParams = params;
    return completion('ok');
  });
  const client = new AiClient(openai, {
    maxAttempts: 1,
    baseDelayMs: 0,
    maxDelayMs: 0,
  });

  await client.complete({
    model: 'test-model',
    messages: [{ role: 'user', content: 'hello' }],
    reasoningEffort: 'low',
  });

  assert.deepEqual(
    (seenParams as Record<string, unknown> | undefined)?.reasoning,
    { effort: 'low' },
  );
});

test('AiClient uses Codex first for OpenAI models', async () => {
  let openRouterCalls = 0;
  let codexCalls = 0;
  const openai = createOpenAiStub(async () => {
    openRouterCalls += 1;
    return completion('openrouter');
  });
  const codex = {
    canUseModel: (model: string) => model.startsWith('openai/'),
    completeRaw: async () => {
      codexCalls += 1;
      return completion('codex');
    },
  };
  const client = new AiClient(
    openai,
    { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    codex,
  );

  const result = await client.completeRaw({
    model: 'openai/gpt-5.5',
    messages: [{ role: 'user', content: 'hello' }],
  });

  assert.equal(result.choices[0]?.message.content, 'codex');
  assert.equal(codexCalls, 1);
  assert.equal(openRouterCalls, 0);
});

test('AiClient falls back to OpenRouter when Codex fails', async () => {
  let openRouterCalls = 0;
  let codexCalls = 0;
  const openai = createOpenAiStub(async () => {
    openRouterCalls += 1;
    return completion('openrouter fallback');
  });
  const codex = {
    canUseModel: (model: string) => model.startsWith('openai/'),
    completeRaw: async () => {
      codexCalls += 1;
      const error = new Error('rate limited') as Error & { status: number };
      error.status = 429;
      throw error;
    },
  };
  const client = new AiClient(
    openai,
    { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    codex,
  );

  const result = await client.completeRaw({
    model: 'openai/gpt-5.5',
    messages: [{ role: 'user', content: 'hello' }],
  });

  assert.equal(result.choices[0]?.message.content, 'openrouter fallback');
  assert.equal(codexCalls, 1);
  assert.equal(openRouterCalls, 1);
});

test('AiClient falls back to OpenRouter when Codex auth is not connected', async () => {
  let openRouterCalls = 0;
  const openai = createOpenAiStub(async () => {
    openRouterCalls += 1;
    return completion('openrouter fallback');
  });
  const codex = {
    canUseModel: (model: string) => model.startsWith('openai/'),
    completeRaw: async () => {
      throw new CodexAuthUnavailableError('Codex OAuth is not connected');
    },
  };
  const client = new AiClient(
    openai,
    { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    codex,
  );

  const result = await client.completeRaw({
    model: 'openai/gpt-5.5',
    messages: [{ role: 'user', content: 'hello' }],
  });

  assert.equal(result.choices[0]?.message.content, 'openrouter fallback');
  assert.equal(openRouterCalls, 1);
});

test('AiClient falls back to OpenRouter when Codex refresh fails', async () => {
  let openRouterCalls = 0;
  const openai = createOpenAiStub(async () => {
    openRouterCalls += 1;
    return completion('openrouter fallback');
  });
  const codex = {
    canUseModel: (model: string) => model.startsWith('openai/'),
    completeRaw: async () => {
      throw new CodexProviderUnavailableError('refresh failed', 500);
    },
  };
  const client = new AiClient(
    openai,
    { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    codex,
  );

  const result = await client.completeRaw({
    model: 'openai/gpt-5.5',
    messages: [{ role: 'user', content: 'hello' }],
  });

  assert.equal(result.choices[0]?.message.content, 'openrouter fallback');
  assert.equal(openRouterCalls, 1);
});

test('AiClient falls back to OpenRouter on Codex network TypeErrors', async () => {
  let openRouterCalls = 0;
  const openai = createOpenAiStub(async () => {
    openRouterCalls += 1;
    return completion('openrouter fallback');
  });
  const codex = {
    canUseModel: (model: string) => model.startsWith('openai/'),
    completeRaw: async () => {
      throw new TypeError('fetch failed');
    },
  };
  const client = new AiClient(
    openai,
    { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    codex,
  );

  const result = await client.completeRaw({
    model: 'openai/gpt-5.5',
    messages: [{ role: 'user', content: 'hello' }],
  });

  assert.equal(result.choices[0]?.message.content, 'openrouter fallback');
  assert.equal(openRouterCalls, 1);
});

test('AiClient does not fall back to OpenRouter on Codex programmer TypeErrors', async () => {
  let openRouterCalls = 0;
  const openai = createOpenAiStub(async () => {
    openRouterCalls += 1;
    return completion('openrouter fallback');
  });
  const codex = {
    canUseModel: (model: string) => model.startsWith('openai/'),
    completeRaw: async () => {
      throw new TypeError('Cannot read properties of undefined');
    },
  };
  const client = new AiClient(
    openai,
    { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    codex,
  );

  await assert.rejects(
    client.completeRaw({
      model: 'openai/gpt-5.5',
      messages: [{ role: 'user', content: 'hello' }],
    }),
    /Cannot read properties/,
  );

  assert.equal(openRouterCalls, 0);
});

test('AiClient does not fall back to OpenRouter on non-outage Codex errors', async () => {
  let openRouterCalls = 0;
  const openai = createOpenAiStub(async () => {
    openRouterCalls += 1;
    return completion('openrouter fallback');
  });
  const codex = {
    canUseModel: (model: string) => model.startsWith('openai/'),
    completeRaw: async () => {
      const error = new Error('bad request') as Error & { status: number };
      error.status = 400;
      throw error;
    },
  };
  const client = new AiClient(
    openai,
    { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    codex,
  );

  await assert.rejects(
    client.completeRaw({
      model: 'openai/gpt-5.5',
      messages: [{ role: 'user', content: 'hello' }],
    }),
    /bad request/,
  );

  assert.equal(openRouterCalls, 0);
});

test('AiClient does not use Codex for non-OpenAI models', async () => {
  let codexCalls = 0;
  const openai = createOpenAiStub(async () => completion('openrouter'));
  const codex = {
    canUseModel: (model: string) => model.startsWith('openai/'),
    completeRaw: async () => {
      codexCalls += 1;
      return completion('codex');
    },
  };
  const client = new AiClient(
    openai,
    { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    codex,
  );

  const result = await client.completeRaw({
    model: 'anthropic/claude-test',
    messages: [{ role: 'user', content: 'hello' }],
  });

  assert.equal(result.choices[0]?.message.content, 'openrouter');
  assert.equal(codexCalls, 0);
});

test('AiClient generates an image through OpenRouter chat completions', async () => {
  let seenParams:
    | OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming
    | undefined;
  const openai = createOpenAiStub(async (params) => {
    seenParams = params;
    return {
      ...completion('done'),
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          logprobs: null,
          message: {
            role: 'assistant',
            content: 'done',
            refusal: null,
            images: [
              {
                image_url: {
                  url: 'data:image/png;base64,aW1hZ2U=',
                },
              },
            ],
          },
        },
      ],
    } as unknown as OpenAI.Chat.Completions.ChatCompletion;
  });
  const client = new AiClient(openai, {
    maxAttempts: 1,
    baseDelayMs: 0,
    maxDelayMs: 0,
  });

  const result = await client.generateImage({
    model: 'openai/gpt-5.4-image-2',
    prompt: 'make a tiny meme about flaky tests',
    aspectRatio: '1:1',
    imageSize: '1K',
  });

  assert.equal(result.dataUrl, 'data:image/png;base64,aW1hZ2U=');
  assert.equal(seenParams?.model, 'openai/gpt-5.4-image-2');
  assert.deepEqual(
    (seenParams as unknown as Record<string, unknown> | undefined)?.modalities,
    ['image', 'text'],
  );
  assert.deepEqual(
    (seenParams as unknown as Record<string, unknown> | undefined)
      ?.image_config,
    {
      aspect_ratio: '1:1',
      image_size: '1K',
    },
  );
});

test('AiClient rejects unsupported generated image data URL formats', async () => {
  const openai = createOpenAiStub(
    async () =>
      ({
        ...completion('done'),
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            logprobs: null,
            message: {
              role: 'assistant',
              content: 'done',
              refusal: null,
              images: [
                {
                  image_url: {
                    url: 'data:image/gif;base64,R0lGODlh',
                  },
                },
              ],
            },
          },
        ],
      }) as unknown as OpenAI.Chat.Completions.ChatCompletion,
  );
  const client = new AiClient(openai, {
    maxAttempts: 1,
    baseDelayMs: 0,
    maxDelayMs: 0,
  });

  await assert.rejects(
    client.generateImage({
      model: 'openai/gpt-5.4-image-2',
      prompt: 'make a tiny meme',
    }),
    /supported image data URL/,
  );
});
