import assert from 'node:assert/strict';
import test from 'node:test';
import type OpenAI from 'openai';
import { AiClient } from '../src/services/ai-client.service.js';

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
