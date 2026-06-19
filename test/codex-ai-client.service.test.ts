import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CodexAiClient,
  CodexBearerAuthProvider,
} from '../src/services/codex-ai-client.service.js';
import { CodexProviderUnavailableError } from '../src/services/codex-oauth.service.js';

const sseResponse = (...events: Record<string, unknown>[]): Response =>
  new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
    {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    },
  );

const makeAuthProvider = (): CodexBearerAuthProvider => ({
  getBearerAuth: async () => ({
    accessToken: 'access-token-test',
    accountId: 'workspace-test',
    isFedrampAccount: true,
  }),
  refreshAuthAfterUnauthorized: async () => {},
});

test('CodexAiClient converts chat completion params to Codex Responses requests', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return sseResponse(
      {
        type: 'response.output_item.done',
        item: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'hello from codex' }],
        },
      },
      {
        type: 'response.completed',
        response: {
          id: 'resp_test',
          usage: { total_tokens: 17 },
        },
      },
    );
  };
  const client = new CodexAiClient(
    makeAuthProvider(),
    fetchFn,
    'https://chat.example.test/backend-api',
  );

  const result = await client.completeRaw({
    model: 'openai/gpt-5.5',
    messages: [
      { role: 'system', content: 'system rules' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is in this image?' },
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,abc' },
          },
        ],
      },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'search',
          description: 'Search the web',
          parameters: {
            type: 'object',
            properties: { q: { type: 'string' } },
            required: ['q'],
          },
        },
      },
    ],
    temperature: 0.2,
    top_p: 0.9,
    max_completion_tokens: 100,
  });

  assert.equal(calls[0]?.url, 'https://chat.example.test/backend-api/codex/responses');
  const headers = calls[0]?.init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer access-token-test');
  assert.equal(headers.Originator, 'codex_cli_rs');
  assert.equal(headers['ChatGPT-Account-ID'], 'workspace-test');
  assert.equal(headers['X-OpenAI-Fedramp'], 'true');

  const body = JSON.parse(String(calls[0]?.init?.body)) as {
    model: string;
    instructions: string;
    input: Array<{
      role: string;
      content: Array<Record<string, string>>;
    }>;
    tools: Array<{ name: string; description: string; strict: boolean }>;
    max_output_tokens?: number;
    store: boolean;
    temperature?: number;
    top_p?: number;
  };
  assert.equal(body.model, 'gpt-5.5');
  assert.equal(body.store, false);
  assert.equal(body.instructions, 'system rules');
  assert.deepEqual(body.input[0]?.content, [
    { type: 'input_text', text: 'what is in this image?' },
    { type: 'input_image', image_url: 'data:image/png;base64,abc' },
  ]);
  assert.equal(body.tools[0]?.name, 'search');
  assert.equal(body.tools[0]?.description, 'Search the web');
  assert.equal(body.tools[0]?.strict, false);
  assert.equal(body.temperature, undefined);
  assert.equal(body.top_p, undefined);
  assert.equal(body.max_output_tokens, undefined);

  assert.equal(result.id, 'resp_test');
  assert.equal(result.choices[0]?.message.content, 'hello from codex');
  assert.equal(result.usage?.total_tokens, 17);
});

test('CodexAiClient declines unsupported chat completion parameters', async () => {
  const client = new CodexAiClient(
    makeAuthProvider(),
    async () => {
      throw new Error('fetch should not be called');
    },
    'https://chat.example.test/backend-api',
  );

  await assert.rejects(
    client.completeRaw({
      model: 'openai/gpt-5.5',
      messages: [{ role: 'user', content: 'hello' }],
      presence_penalty: 0.4,
      frequency_penalty: 0.6,
    }),
    CodexProviderUnavailableError,
  );
});

test('CodexAiClient refreshes auth and retries once after a 401', async () => {
  let authCalls = 0;
  let refreshCalls = 0;
  const authProvider: CodexBearerAuthProvider = {
    getBearerAuth: async () => {
      authCalls += 1;
      return {
        accessToken: authCalls === 1 ? 'stale-token' : 'fresh-token',
        isFedrampAccount: false,
      };
    },
    refreshAuthAfterUnauthorized: async () => {
      refreshCalls += 1;
    },
  };
  const seenTokens: string[] = [];
  const fetchFn: typeof fetch = async (_input, init) => {
    const headers = init?.headers as Record<string, string>;
    seenTokens.push(headers.Authorization);

    if (seenTokens.length === 1) {
      return new Response('unauthorized', { status: 401 });
    }

    return sseResponse({
      type: 'response.output_text.delta',
      delta: 'retried',
    });
  };
  const client = new CodexAiClient(
    authProvider,
    fetchFn,
    'https://chat.example.test/backend-api',
  );

  const result = await client.completeRaw({
    model: 'openai/gpt-5.5',
    messages: [{ role: 'user', content: 'hello' }],
  });

  assert.deepEqual(seenTokens, ['Bearer stale-token', 'Bearer fresh-token']);
  assert.equal(refreshCalls, 1);
  assert.equal(result.choices[0]?.message.content, 'retried');
});

test('CodexAiClient maps Codex function-call SSE events to chat completions', async () => {
  const fetchFn: typeof fetch = async () =>
    sseResponse({
      type: 'response.output_item.done',
      item: {
        type: 'function_call',
        call_id: 'call_test',
        name: 'search',
        arguments: '{"q":"codex"}',
      },
    });
  const client = new CodexAiClient(
    makeAuthProvider(),
    fetchFn,
    'https://chat.example.test/backend-api',
  );

  const result = await client.completeRaw({
    model: 'openai/gpt-5.5',
    messages: [{ role: 'user', content: 'search please' }],
  });

  assert.equal(result.choices[0]?.finish_reason, 'tool_calls');
  assert.deepEqual(result.choices[0]?.message.tool_calls, [
    {
      id: 'call_test',
      type: 'function',
      function: {
        name: 'search',
        arguments: '{"q":"codex"}',
      },
    },
  ]);
});

test('CodexAiClient rejects malformed function-call SSE events', async () => {
  const fetchFn: typeof fetch = async () =>
    sseResponse({
      type: 'response.output_item.done',
      item: {
        type: 'function_call',
        call_id: 'call_test',
        name: 'search',
      },
    });
  const client = new CodexAiClient(
    makeAuthProvider(),
    fetchFn,
    'https://chat.example.test/backend-api',
  );

  await assert.rejects(
    client.completeRaw({
      model: 'openai/gpt-5.5',
      messages: [{ role: 'user', content: 'search please' }],
    }),
    CodexProviderUnavailableError,
  );
});

test('CodexAiClient rejects malformed successful streams without usable output', async () => {
  const fetchFn: typeof fetch = async () =>
    new Response('data: not-json\n\n', {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  const client = new CodexAiClient(
    makeAuthProvider(),
    fetchFn,
    'https://chat.example.test/backend-api',
  );

  await assert.rejects(
    client.completeRaw({
      model: 'openai/gpt-5.5',
      messages: [{ role: 'user', content: 'hello' }],
    }),
    CodexProviderUnavailableError,
  );
});
