import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentRunner } from '../src/services/agent-runner.service.js';
import type {
  AgentChatClient,
  AgentToolRegistry,
} from '../src/services/agent-runner.service.js';

test('AgentRunner stops after 10 tool calls', async () => {
  let completions = 0;
  const client: AgentChatClient = {
    complete: async () => {
      completions += 1;
      return {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: `call_${completions}`,
              type: 'function',
              function: {
                name: 'get_recent_messages',
                arguments: '{"limit":1}',
              },
            },
          ],
        },
        usage: { total_tokens: 1 },
      };
    },
  };
  let executed = 0;
  const registry: AgentToolRegistry = {
    getToolDefinitions: () => [
      {
        type: 'function',
        function: {
          name: 'get_recent_messages',
          description: 'Get recent messages',
          parameters: { type: 'object', properties: {} },
        },
      },
    ],
    execute: async () => {
      executed += 1;
      return { status: 'ok', messages: [] };
    },
  };

  const runner = new AgentRunner(client, registry, {
    model: 'agent-model',
    maxToolCalls: 10,
  });

  const result = await runner.run({
    chatTelegramId: -100,
    triggerMessageId: 123,
    botUsername: 'groknul_bot',
    triggerText: '@groknul_bot search history',
  });

  assert.equal(executed, 10);
  assert.equal(result.status, 'tool_limit_reached');
  assert.equal(
    result.output.items[0]?.plainText,
    'need a narrower request to keep this sane',
  );
});

test('AgentRunner does not expose wrong-shape JSON as visible text', async () => {
  const client: AgentChatClient = {
    complete: async () => ({
      message: {
        role: 'assistant',
        content: '{"answer":"still useful"}',
      },
    }),
  };
  const registry: AgentToolRegistry = {
    getToolDefinitions: () => [],
    execute: async () => {
      throw new Error('unused');
    },
  };
  const runner = new AgentRunner(client, registry, {
    model: 'agent-model',
    maxToolCalls: 10,
  });

  const result = await runner.run({
    chatTelegramId: -100,
    triggerMessageId: 123,
    botUsername: 'groknul_bot',
  });

  assert.equal(result.status, 'final');
  assert.deepEqual(result.output.items, [
    {
      plainText: 'я на секунду зламав форматування, але я тут',
    },
  ]);
});

test('AgentRunner passes configured reasoning effort to chat client', async () => {
  let seenReasoningEffort: unknown;
  const client: AgentChatClient = {
    complete: async (input) => {
      seenReasoningEffort = input.reasoningEffort;
      return {
        message: {
          role: 'assistant',
          content: 'ok',
        },
      };
    },
  };
  const registry: AgentToolRegistry = {
    getToolDefinitions: () => [],
    execute: async () => {
      throw new Error('unused');
    },
  };
  const runner = new AgentRunner(client, registry, {
    model: 'agent-model',
    maxToolCalls: 10,
    reasoningEffort: 'low',
  });

  await runner.run({
    chatTelegramId: -100,
    triggerMessageId: 123,
    botUsername: 'groknul_bot',
  });

  assert.equal(seenReasoningEffort, 'low');
});

test('AgentRunner includes preloaded chat memories in model context', async () => {
  let userPayload: Record<string, unknown> | undefined;
  const client: AgentChatClient = {
    complete: async (input) => {
      userPayload = JSON.parse(String(input.messages[1]?.content));
      return {
        message: {
          role: 'assistant',
          content: 'ok',
        },
      };
    },
  };
  const registry: AgentToolRegistry = {
    getToolDefinitions: () => [],
    execute: async () => {
      throw new Error('unused');
    },
  };
  const runner = new AgentRunner(client, registry, {
    model: 'agent-model',
    maxToolCalls: 10,
  });

  await runner.run({
    chatTelegramId: -100,
    triggerMessageId: 123,
    botUsername: 'groknul_bot',
    chatMemories: ['maksym likes dutch steering wheels'],
  });

  assert.deepEqual(userPayload?.chatMemories, [
    'maksym likes dutch steering wheels',
  ]);
});

test('AgentRunner includes reply context in model context', async () => {
  let userPayload: Record<string, unknown> | undefined;
  const client: AgentChatClient = {
    complete: async (input) => {
      userPayload = JSON.parse(String(input.messages[1]?.content));
      return {
        message: {
          role: 'assistant',
          content: 'ok',
        },
      };
    },
  };
  const registry: AgentToolRegistry = {
    getToolDefinitions: () => [],
    execute: async () => {
      throw new Error('unused');
    },
  };
  const runner = new AgentRunner(client, registry, {
    model: 'agent-model',
    maxToolCalls: 10,
  });

  await runner.run({
    chatTelegramId: -100,
    triggerMessageId: 123,
    botUsername: 'groknul_bot',
    triggerText: '@groknul_bot новости на стол',
    replyContext: [
      {
        id: 123,
        from: 'maksym',
        text: '@groknul_bot новости на стол',
        replyToMessageId: 122,
      },
      {
        id: 122,
        from: 'maksym',
        text: 'а это ты ебнул tay keith?',
        replyToMessageId: 121,
      },
      {
        id: 121,
        from: 'sanyochek',
        text: 'мне надо на треп хату там в корее',
      },
    ],
  });

  assert.deepEqual(userPayload?.replyContext, [
    {
      id: 123,
      from: 'maksym',
      text: '@groknul_bot новости на стол',
      replyToMessageId: 122,
    },
    {
      id: 122,
      from: 'maksym',
      text: 'а это ты ебнул tay keith?',
      replyToMessageId: 121,
    },
    {
      id: 121,
      from: 'sanyochek',
      text: 'мне надо на треп хату там в корее',
    },
  ]);
});

test('AgentRunner includes current message details in model context', async () => {
  let userPayload: Record<string, unknown> | undefined;
  const client: AgentChatClient = {
    complete: async (input) => {
      userPayload = JSON.parse(String(input.messages[1]?.content));
      return {
        message: {
          role: 'assistant',
          content: 'ok',
        },
      };
    },
  };
  const registry: AgentToolRegistry = {
    getToolDefinitions: () => [],
    execute: async () => {
      throw new Error('unused');
    },
  };
  const runner = new AgentRunner(client, registry, {
    model: 'agent-model',
    maxToolCalls: 10,
  });

  await runner.run({
    chatTelegramId: -100,
    triggerMessageId: 123,
    botUsername: 'groknul_bot',
    triggerText: '@groknul_bot что там',
    currentMessageDetails: {
      id: 123,
      from: 'maksym',
      userTelegramId: 777,
      text: '@groknul_bot что там',
      context: 'Image: screenshot of a Telegram chat about Tay Keith.',
      messageType: 'photo',
      fileName: 'photo.jpg',
      sentAt: '2026-06-19T09:33:00.000Z',
      reactions: ['😁'],
    },
  });

  assert.deepEqual(userPayload?.currentMessageDetails, {
    id: 123,
    from: 'maksym',
    userTelegramId: 777,
    text: '@groknul_bot что там',
    context: 'Image: screenshot of a Telegram chat about Tay Keith.',
    messageType: 'photo',
    fileName: 'photo.jpg',
    sentAt: '2026-06-19T09:33:00.000Z',
    reactions: ['😁'],
  });
});

test('AgentRunner prompt makes progress bubbles conditional', async () => {
  let systemPrompt = '';
  const client: AgentChatClient = {
    complete: async (input) => {
      systemPrompt = String(input.messages[0]?.content);
      return {
        message: {
          role: 'assistant',
          content: 'ok',
        },
      };
    },
  };
  const registry: AgentToolRegistry = {
    getToolDefinitions: () => [],
    execute: async () => {
      throw new Error('unused');
    },
  };
  const runner = new AgentRunner(client, registry, {
    model: 'agent-model',
    maxToolCalls: 10,
  });

  await runner.run({
    chatTelegramId: -100,
    triggerMessageId: 123,
    botUsername: 'groknul_bot',
  });

  assert.match(systemPrompt, /Progress bubbles are optional/);
  assert.match(
    systemPrompt,
    /Do not send a progress bubble for quick follow-ups/,
  );
  assert.match(systemPrompt, /replyContext/);
  assert.match(systemPrompt, /short ambiguous commands/);
  assert.match(systemPrompt, /get_messages_before/);
  assert.match(systemPrompt, /currentMessageDetails/);
});

test('AgentRunner does not mark invalid send tool payloads as sent', async () => {
  let completions = 0;
  const client: AgentChatClient = {
    complete: async () => {
      completions += 1;
      if (completions === 1) {
        return {
          message: {
            role: 'assistant',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'send',
                  arguments: '{"items":[]}',
                },
              },
            ],
          },
        };
      }

      return {
        message: {
          role: 'assistant',
          content: 'fallback text',
        },
      };
    },
  };
  const registry: AgentToolRegistry = {
    getToolDefinitions: () => [],
    execute: async () => ({ status: 'invalid_args' }),
  };
  const runner = new AgentRunner(client, registry, {
    model: 'agent-model',
    maxToolCalls: 10,
  });

  const result = await runner.run({
    chatTelegramId: -100,
    triggerMessageId: 123,
    botUsername: 'groknul_bot',
  });

  assert.equal(result.status, 'final');
  assert.equal(result.output.items[0]?.plainText, 'fallback text');
});

test('AgentRunner continues after progress send when requested', async () => {
  let completions = 0;
  const client: AgentChatClient = {
    complete: async () => {
      completions += 1;
      if (completions === 1) {
        return {
          message: {
            role: 'assistant',
            tool_calls: [
              {
                id: 'call_progress',
                type: 'function',
                function: {
                  name: 'send',
                  arguments:
                    '{"continueAfter":true,"items":[{"plainText":"lemme check"}]}',
                },
              },
            ],
          },
        };
      }

      if (completions === 2) {
        return {
          message: {
            role: 'assistant',
            tool_calls: [
              {
                id: 'call_search',
                type: 'function',
                function: {
                  name: 'web_search',
                  arguments: '{"query":"test"}',
                },
              },
            ],
          },
        };
      }

      return {
        message: {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_final',
              type: 'function',
              function: {
                name: 'send',
                arguments: '{"items":[{"plainText":"found it"}]}',
              },
            },
          ],
        },
      };
    },
  };
  const executedTools: string[] = [];
  const registry: AgentToolRegistry = {
    getToolDefinitions: () => [],
    execute: async (name) => {
      executedTools.push(name);
      return name === 'send'
        ? { status: 'ok', deliveries: [{ telegramId: executedTools.length }] }
        : { status: 'ok', results: [] };
    },
  };
  const runner = new AgentRunner(client, registry, {
    model: 'agent-model',
    maxToolCalls: 10,
  });

  const result = await runner.run({
    chatTelegramId: -100,
    triggerMessageId: 123,
    botUsername: 'groknul_bot',
  });

  assert.equal(result.status, 'sent');
  assert.deepEqual(executedTools, ['send', 'web_search', 'send']);
  assert.deepEqual(result.toolsUsed, ['send', 'web_search', 'send']);
});

test('AgentRunner stops after a generated image is sent', async () => {
  const client: AgentChatClient = {
    complete: async () => ({
      message: {
        role: 'assistant',
        tool_calls: [
          {
            id: 'call_image',
            type: 'function',
            function: {
              name: 'generate_image',
              arguments: '{"prompt":"make a tiny meme","caption":"done"}',
            },
          },
        ],
      },
    }),
  };
  const registry: AgentToolRegistry = {
    getToolDefinitions: () => [],
    execute: async () => ({
      status: 'ok',
      deliveries: [{ telegramId: 777, format: 'photo' }],
    }),
  };
  const runner = new AgentRunner(client, registry, {
    model: 'agent-model',
    maxToolCalls: 10,
  });

  const result = await runner.run({
    chatTelegramId: -100,
    triggerMessageId: 123,
    botUsername: 'groknul_bot',
  });

  assert.equal(result.status, 'sent');
  assert.deepEqual(result.toolsUsed, ['generate_image']);
});

test('AgentRunner stops after a photo search task queues visible progress', async () => {
  const client: AgentChatClient = {
    complete: async () => ({
      message: {
        role: 'assistant',
        tool_calls: [
          {
            id: 'call_photo_search',
            type: 'function',
            function: {
              name: 'send_photo_search',
              arguments: '{"query":"brabus b63","requiredTerms":["brabus"]}',
            },
          },
        ],
      },
    }),
  };
  const registry: AgentToolRegistry = {
    getToolDefinitions: () => [],
    execute: async () => ({
      status: 'ok',
      photoTask: { status: 'queued', query: 'brabus b63' },
      deliveries: [{ telegramId: 888, format: 'plain' }],
    }),
  };
  const runner = new AgentRunner(client, registry, {
    model: 'agent-model',
    maxToolCalls: 10,
  });

  const result = await runner.run({
    chatTelegramId: -100,
    triggerMessageId: 123,
    botUsername: 'groknul_bot',
  });

  assert.equal(result.status, 'sent');
  assert.deepEqual(result.toolsUsed, ['send_photo_search']);
});

test('AgentRunner includes active photo task context in the model input', async () => {
  const seenUserPayloads: unknown[] = [];
  const client: AgentChatClient = {
    complete: async (input) => {
      seenUserPayloads.push(JSON.parse(input.messages[1]?.content ?? '{}'));
      return {
        message: {
          role: 'assistant',
          content: 'still searching',
        },
      };
    },
  };
  const registry: AgentToolRegistry = {
    getToolDefinitions: () => [],
    execute: async () => {
      throw new Error('unused');
    },
  };
  const runner = new AgentRunner(client, registry, {
    model: 'agent-model',
    maxToolCalls: 10,
  });

  await runner.run({
    chatTelegramId: -100,
    triggerMessageId: 124,
    botUsername: 'groknul_bot',
    activePhotoTask: {
      id: 'photo-1',
      chatTelegramId: -100,
      triggerMessageId: 123,
      query: 'brabus b63',
      status: 'searching',
      startedAt: '2026-07-01T10:00:00.000Z',
      updatedAt: '2026-07-01T10:00:05.000Z',
    },
  });

  assert.deepEqual(
    (seenUserPayloads[0] as { activePhotoTask?: unknown }).activePhotoTask,
    {
      id: 'photo-1',
      chatTelegramId: -100,
      triggerMessageId: 123,
      query: 'brabus b63',
      status: 'searching',
      startedAt: '2026-07-01T10:00:00.000Z',
      updatedAt: '2026-07-01T10:00:05.000Z',
    },
  );
});

test('AgentRunner stops after a reaction-only tool call', async () => {
  let completions = 0;
  const client: AgentChatClient = {
    complete: async () => {
      completions += 1;
      return {
        message: {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_react',
              type: 'function',
              function: {
                name: 'react_to_message',
                arguments: '{"messageId":123,"reaction":"😁"}',
              },
            },
          ],
        },
      };
    },
  };
  const registry: AgentToolRegistry = {
    getToolDefinitions: () => [],
    execute: async () => ({ status: 'ok', reacted: true }),
  };
  const runner = new AgentRunner(client, registry, {
    model: 'agent-model',
    maxToolCalls: 10,
  });

  const result = await runner.run({
    chatTelegramId: -100,
    triggerMessageId: 123,
    botUsername: 'groknul_bot',
  });

  assert.equal(completions, 1);
  assert.equal(result.status, 'reacted');
  assert.deepEqual(result.toolsUsed, ['react_to_message']);
});

test('AgentRunner can react and then continue when requested', async () => {
  let completions = 0;
  const client: AgentChatClient = {
    complete: async () => {
      completions += 1;
      if (completions === 1) {
        return {
          message: {
            role: 'assistant',
            tool_calls: [
              {
                id: 'call_react',
                type: 'function',
                function: {
                  name: 'react_to_message',
                  arguments:
                    '{"messageId":123,"reaction":"😁","continueAfter":true}',
                },
              },
            ],
          },
        };
      }

      return {
        message: {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_send',
              type: 'function',
              function: {
                name: 'send',
                arguments: '{"items":[{"plainText":"also, yes"}]}',
              },
            },
          ],
        },
      };
    },
  };
  const executedTools: string[] = [];
  const registry: AgentToolRegistry = {
    getToolDefinitions: () => [],
    execute: async (name) => {
      executedTools.push(name);
      return name === 'send'
        ? { status: 'ok', deliveries: [{ telegramId: 1 }] }
        : { status: 'ok', reacted: true };
    },
  };
  const runner = new AgentRunner(client, registry, {
    model: 'agent-model',
    maxToolCalls: 10,
  });

  const result = await runner.run({
    chatTelegramId: -100,
    triggerMessageId: 123,
    botUsername: 'groknul_bot',
  });

  assert.equal(result.status, 'sent');
  assert.deepEqual(executedTools, ['react_to_message', 'send']);
});

test('AgentRunner stops after an intentional ignore tool call', async () => {
  let completions = 0;
  const client: AgentChatClient = {
    complete: async () => {
      completions += 1;
      return {
        message: {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_ignore',
              type: 'function',
              function: {
                name: 'ignore_message',
                arguments: '{"reason":"just laughter after my joke"}',
              },
            },
          ],
        },
      };
    },
  };
  const registry: AgentToolRegistry = {
    getToolDefinitions: () => [],
    execute: async () => ({ status: 'ok', ignored: true }),
  };
  const runner = new AgentRunner(client, registry, {
    model: 'agent-model',
    maxToolCalls: 10,
  });

  const result = await runner.run({
    chatTelegramId: -100,
    triggerMessageId: 123,
    botUsername: 'groknul_bot',
  });

  assert.equal(completions, 1);
  assert.equal(result.status, 'ignored');
  assert.deepEqual(result.toolsUsed, ['ignore_message']);
});

test('AgentRunner normalizes structured final output through the send payload schema', async () => {
  const client: AgentChatClient = {
    complete: async () => ({
      message: {
        role: 'assistant',
        content: JSON.stringify({
          items: [
            {
              plainText: 'poll without enough options',
              poll: { question: 'q', options: ['one'] },
            },
          ],
        }),
      },
    }),
  };
  const registry: AgentToolRegistry = {
    getToolDefinitions: () => [],
    execute: async () => {
      throw new Error('unused');
    },
  };
  const runner = new AgentRunner(client, registry, {
    model: 'agent-model',
    maxToolCalls: 10,
  });

  const result = await runner.run({
    chatTelegramId: -100,
    triggerMessageId: 123,
    botUsername: 'groknul_bot',
  });

  assert.deepEqual(result.output.items, [
    {
      plainText: 'poll without enough options',
      richHtml: undefined,
      richMarkdown: undefined,
      replyToMessageId: undefined,
      attachments: undefined,
      poll: undefined,
      delayHintMs: undefined,
    },
  ]);
});

test('AgentRunner normalizes fenced structured final output without exposing JSON', async () => {
  const client: AgentChatClient = {
    complete: async () => ({
      message: {
        role: 'assistant',
        content:
          '```json\n{"items":[{"plainText":"ні, JSON не показуємо","richMarkdown":"ні, JSON не показуємо"}]}\n```',
      },
    }),
  };
  const registry: AgentToolRegistry = {
    getToolDefinitions: () => [],
    execute: async () => {
      throw new Error('unused');
    },
  };
  const runner = new AgentRunner(client, registry, {
    model: 'agent-model',
    maxToolCalls: 10,
  });

  const result = await runner.run({
    chatTelegramId: -100,
    triggerMessageId: 123,
    botUsername: 'groknul_bot',
  });

  assert.deepEqual(result.output.items, [
    {
      plainText: 'ні, JSON не показуємо',
      richMarkdown: 'ні, JSON не показуємо',
      richHtml: undefined,
      replyToMessageId: undefined,
      attachments: undefined,
      poll: undefined,
      delayHintMs: undefined,
    },
  ]);
});
