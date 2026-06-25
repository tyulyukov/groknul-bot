import assert from 'node:assert/strict';
import test from 'node:test';
import { TelegramToolRegistry } from '../src/services/telegram-tool-registry.service.js';

const disabledImageService = {
  generateImage: async () => null,
};

const disabledCodexOAuthStatus = {
  isAvailable: () => false,
};

const enabledCodexOAuthStatus = {
  isAvailable: () => true,
};

test('getToolDefinitions hides generate_image when Codex OAuth is unavailable', () => {
  const registry = new TelegramToolRegistry({
    chatTelegramId: -100,
    botUserTelegramId: 999,
    api: {
      deleteMessage: async () => true,
      editMessageText: async () => true,
      setMessageReaction: async () => true,
    },
    delivery: {} as never,
    imageService: disabledImageService,
    codexOAuthStatus: disabledCodexOAuthStatus,
    contextTools: {} as never,
    searchService: {} as never,
    messageModel: {
      findByMessageTelegramId: async () => null,
    } as never,
  });

  assert.equal(
    registry
      .getToolDefinitions()
      .some((tool) => tool.function.name === 'generate_image'),
    false,
  );
});

test('generate_image is blocked at execution time when Codex OAuth is unavailable', async () => {
  let generateCalls = 0;
  const registry = new TelegramToolRegistry({
    chatTelegramId: -100,
    botUserTelegramId: 999,
    api: {
      deleteMessage: async () => true,
      editMessageText: async () => true,
      setMessageReaction: async () => true,
    },
    delivery: {
      send: async () => {
        throw new Error('unused');
      },
    } as never,
    imageService: {
      generateImage: async () => {
        generateCalls += 1;
        return { dataUrl: 'data:image/png;base64,aW1hZ2U=' };
      },
    },
    codexOAuthStatus: disabledCodexOAuthStatus,
    contextTools: {} as never,
    searchService: {} as never,
    messageModel: {
      findByMessageTelegramId: async () => null,
    } as never,
  });

  const result = await registry.execute('generate_image', {
    prompt: 'please draw a cursed deployment graph',
  });

  assert.equal(generateCalls, 0);
  assert.deepEqual(result, {
    status: 'disabled',
    reason: 'codex_oauth_required',
  });
});

test('delete_own_message rejects messages not sent by this bot', async () => {
  let deleteCalled = false;
  const registry = new TelegramToolRegistry({
    chatTelegramId: -100,
    botUserTelegramId: 999,
    api: {
      deleteMessage: async () => {
        deleteCalled = true;
        return true;
      },
      editMessageText: async () => true,
      setMessageReaction: async () => true,
    },
    delivery: {} as never,
    imageService: disabledImageService,
    contextTools: {} as never,
    searchService: {} as never,
    messageModel: {
      findByMessageTelegramId: async () => ({
        telegramId: 123,
        chatTelegramId: -100,
        userTelegramId: 111,
      }),
    } as never,
  });

  const result = await registry.execute('delete_own_message', {
    messageId: 123,
  });

  assert.equal(deleteCalled, false);
  assert.deepEqual(result, {
    status: 'forbidden',
    reason: 'message_not_sent_by_this_bot',
  });
});

test('send rejects empty or malformed item arrays before delivery', async () => {
  let sendCalled = false;
  const registry = new TelegramToolRegistry({
    chatTelegramId: -100,
    botUserTelegramId: 999,
    api: {
      deleteMessage: async () => true,
      editMessageText: async () => true,
      setMessageReaction: async () => true,
    },
    delivery: {
      send: async () => {
        sendCalled = true;
        return { status: 'ok', deliveries: [] };
      },
    } as never,
    imageService: disabledImageService,
    contextTools: {} as never,
    searchService: {} as never,
    messageModel: {
      findByMessageTelegramId: async () => null,
    } as never,
  });

  const result = await registry.execute('send', { items: [] });

  assert.equal(sendCalled, false);
  assert.deepEqual(result, {
    status: 'invalid_args',
    reason: 'send_requires_at_least_one_valid_item',
  });
});

test('send strips reply metadata from follow-up bubbles', async () => {
  let sentPayload: unknown;
  const registry = new TelegramToolRegistry({
    chatTelegramId: -100,
    botUserTelegramId: 999,
    api: {
      deleteMessage: async () => true,
      editMessageText: async () => true,
      setMessageReaction: async () => true,
    },
    delivery: {
      send: async (_chatId: number, payload: unknown) => {
        sentPayload = payload;
        return { status: 'ok', deliveries: [{ telegramId: 1 }] };
      },
    } as never,
    imageService: disabledImageService,
    contextTools: {} as never,
    searchService: {} as never,
    messageModel: {
      findByMessageTelegramId: async () => null,
    } as never,
  });

  await registry.execute('send', {
    items: [
      { plainText: 'one', replyToMessageId: 123 },
      { plainText: 'two', replyToMessageId: 123 },
      { plainText: 'three', replyToMessageId: 123 },
    ],
  });

  assert.deepEqual(sentPayload, {
    items: [
      {
        plainText: 'one',
        richHtml: undefined,
        richMarkdown: undefined,
        replyToMessageId: 123,
        attachments: undefined,
        poll: undefined,
        delayHintMs: undefined,
      },
      {
        plainText: 'two',
        richHtml: undefined,
        richMarkdown: undefined,
        replyToMessageId: undefined,
        attachments: undefined,
        poll: undefined,
        delayHintMs: undefined,
      },
      {
        plainText: 'three',
        richHtml: undefined,
        richMarkdown: undefined,
        replyToMessageId: undefined,
        attachments: undefined,
        poll: undefined,
        delayHintMs: undefined,
      },
    ],
  });
});

test('send strips reply metadata after the first replied bubble across calls', async () => {
  const sentPayloads: unknown[] = [];
  const registry = new TelegramToolRegistry({
    chatTelegramId: -100,
    botUserTelegramId: 999,
    api: {
      deleteMessage: async () => true,
      editMessageText: async () => true,
      setMessageReaction: async () => true,
    },
    delivery: {
      send: async (_chatId: number, payload: unknown) => {
        sentPayloads.push(payload);
        return {
          status: 'ok',
          deliveries: [{ telegramId: sentPayloads.length }],
        };
      },
    } as never,
    imageService: disabledImageService,
    contextTools: {} as never,
    searchService: {} as never,
    messageModel: {
      findByMessageTelegramId: async () => null,
    } as never,
  });

  await registry.execute('send', {
    items: [{ plainText: 'progress', replyToMessageId: 123 }],
  });
  await registry.execute('send', {
    items: [{ plainText: 'answer', replyToMessageId: 123 }],
  });

  assert.deepEqual(sentPayloads, [
    {
      items: [
        {
          plainText: 'progress',
          richHtml: undefined,
          richMarkdown: undefined,
          replyToMessageId: 123,
          attachments: undefined,
          poll: undefined,
          delayHintMs: undefined,
        },
      ],
    },
    {
      items: [
        {
          plainText: 'answer',
          richHtml: undefined,
          richMarkdown: undefined,
          replyToMessageId: undefined,
          attachments: undefined,
          poll: undefined,
          delayHintMs: undefined,
        },
      ],
    },
  ]);
});

test('generate_image generates and sends a Telegram photo attachment', async () => {
  let generatedPrompt: string | undefined;
  let sentPayload: unknown;
  const registry = new TelegramToolRegistry({
    chatTelegramId: -100,
    botUserTelegramId: 999,
    api: {
      deleteMessage: async () => true,
      editMessageText: async () => true,
      setMessageReaction: async () => true,
    },
    delivery: {
      send: async (_chatId: number, payload: unknown) => {
        sentPayload = payload;
        return {
          status: 'ok',
          deliveries: [{ telegramId: 456, format: 'photo' }],
        };
      },
    } as never,
    imageService: {
      generateImage: async (input: { prompt: string }) => {
        generatedPrompt = input.prompt;
        return { dataUrl: 'data:image/png;base64,aW1hZ2U=' };
      },
    },
    codexOAuthStatus: enabledCodexOAuthStatus,
    contextTools: {} as never,
    searchService: {} as never,
    messageModel: {
      findByMessageTelegramId: async () => null,
    } as never,
  });

  const result = await registry.execute('generate_image', {
    prompt: 'two tests in a trench coat trying to pass CI',
    caption: 'ci saw the coat',
    replyToMessageId: 123,
    aspectRatio: '1:1',
  });

  assert.equal(generatedPrompt, 'two tests in a trench coat trying to pass CI');
  assert.deepEqual(sentPayload, {
    items: [
      {
        plainText: 'ci saw the coat',
        replyToMessageId: 123,
        attachments: [
          {
            type: 'photo',
            fileIdOrUrl: 'data:image/png;base64,aW1hZ2U=',
            captionPlainText: 'ci saw the coat',
          },
        ],
      },
    ],
  });
  assert.deepEqual(result, {
    status: 'ok',
    deliveries: [{ telegramId: 456, format: 'photo' }],
  });
});

test('react_to_message replaces the bot reaction locally after Telegram succeeds', async () => {
  const replaceCalls: unknown[] = [];
  const registry = new TelegramToolRegistry({
    chatTelegramId: -100,
    botUserTelegramId: 999,
    api: {
      deleteMessage: async () => true,
      editMessageText: async () => true,
      setMessageReaction: async () => true,
    },
    delivery: {} as never,
    imageService: disabledImageService,
    contextTools: {} as never,
    searchService: {} as never,
    messageModel: {
      findByMessageTelegramId: async () => null,
      replaceUserReactions: async (...args: unknown[]) => {
        replaceCalls.push(args);
      },
    } as never,
  });

  await registry.execute('react_to_message', {
    messageId: 123,
    reaction: '🔥',
  });

  assert.deepEqual(replaceCalls, [[123, -100, 999, [{ emoji: '🔥' }]]]);
});

test('get_messages_before proxies context lookup before a trigger message', async () => {
  let seenArgs: unknown[] | undefined;
  const registry = new TelegramToolRegistry({
    chatTelegramId: -100,
    botUserTelegramId: 999,
    api: {
      deleteMessage: async () => true,
      editMessageText: async () => true,
      setMessageReaction: async () => true,
    },
    delivery: {} as never,
    imageService: disabledImageService,
    contextTools: {
      getMessagesBefore: async (...args: unknown[]) => {
        seenArgs = args;
        return { status: 'ok', messages: [] };
      },
    } as never,
    searchService: {} as never,
    messageModel: {
      findByMessageTelegramId: async () => null,
    } as never,
  });

  const result = await registry.execute('get_messages_before', {
    messageId: 123,
    limit: 10,
  });

  assert.deepEqual(seenArgs, [-100, { messageId: 123, limit: 10 }]);
  assert.deepEqual(result, { status: 'ok', messages: [] });
});

test('get_chat_stats proxies chat accounting lookup', async () => {
  let seenArgs: unknown[] | undefined;
  const registry = new TelegramToolRegistry({
    chatTelegramId: -100,
    botUserTelegramId: 999,
    api: {
      deleteMessage: async () => true,
      editMessageText: async () => true,
      setMessageReaction: async () => true,
    },
    delivery: {} as never,
    imageService: disabledImageService,
    contextTools: {
      getChatStats: async (...args: unknown[]) => {
        seenArgs = args;
        return {
          status: 'ok',
          stats: {
            period: 'today',
            timeZone: 'Europe/Kiev',
            totalMessages: 4,
            byDay: [],
            topUsers: [],
            peakHours: [],
            source: 'stored_messages',
          },
        };
      },
    } as never,
    searchService: {} as never,
    messageModel: {
      findByMessageTelegramId: async () => null,
    } as never,
  });

  const result = await registry.execute('get_chat_stats', {
    period: 'today',
    timeZone: 'Europe/Kiev',
    topUsersLimit: 5,
  });

  assert.deepEqual(seenArgs, [
    -100,
    {
      period: 'today',
      since: undefined,
      until: undefined,
      timeZone: 'Europe/Kiev',
      topUsersLimit: 5,
      topHoursLimit: undefined,
      dayLimit: undefined,
      excludeUserTelegramId: 999,
    },
  ]);
  assert.deepEqual(result, {
    status: 'ok',
    stats: {
      period: 'today',
      timeZone: 'Europe/Kiev',
      totalMessages: 4,
      byDay: [],
      topUsers: [],
      peakHours: [],
      source: 'stored_messages',
    },
  });
});

test('get_raw_message proxies stored raw payload lookup', async () => {
  let seenArgs: unknown[] | undefined;
  const registry = new TelegramToolRegistry({
    chatTelegramId: -100,
    botUserTelegramId: 999,
    api: {
      deleteMessage: async () => true,
      editMessageText: async () => true,
      setMessageReaction: async () => true,
    },
    delivery: {} as never,
    imageService: disabledImageService,
    contextTools: {
      getRawMessage: async (...args: unknown[]) => {
        seenArgs = args;
        return {
          status: 'ok',
          rawMessage: {
            id: 456,
            messageType: 'poll',
            payloadJson: '{ "message": { "poll": true } }',
            truncated: false,
          },
        };
      },
    } as never,
    searchService: {} as never,
    messageModel: {
      findByMessageTelegramId: async () => null,
    } as never,
  });

  const result = await registry.execute('get_raw_message', {
    messageId: 456,
  });

  assert.deepEqual(seenArgs, [-100, { messageId: 456 }]);
  assert.deepEqual(result, {
    status: 'ok',
    rawMessage: {
      id: 456,
      messageType: 'poll',
      payloadJson: '{ "message": { "poll": true } }',
      truncated: false,
    },
  });
});

test('ignore_message persists an internal no-reply marker', async () => {
  let saved: Record<string, unknown> | undefined;
  const registry = new TelegramToolRegistry({
    chatTelegramId: -100,
    botUserTelegramId: 999,
    api: {
      deleteMessage: async () => true,
      editMessageText: async () => true,
      setMessageReaction: async () => true,
    },
    delivery: {} as never,
    imageService: disabledImageService,
    contextTools: {} as never,
    searchService: {} as never,
    messageModel: {
      findByMessageTelegramId: async () => null,
      saveMessage: async (doc: Record<string, unknown>) => {
        saved = doc;
        return doc;
      },
    } as never,
  });

  const result = await registry.execute('ignore_message', {
    messageId: 123,
    reason:
      'positive laughter after bot joke; reaction/reply would be too much',
  });

  assert.deepEqual(result, {
    status: 'ok',
    ignored: true,
    messageId: 123,
  });
  assert.equal(saved?.telegramId, -123);
  assert.equal(saved?.chatTelegramId, -100);
  assert.equal(saved?.userTelegramId, 999);
  assert.equal(saved?.text, '');
  assert.equal(saved?.replyToMessageTelegramId, 123);
  assert.equal(saved?.messageType, 'other');
  assert.equal(
    saved?.context,
    'Bot deliberately did not send a visible reply. Reason: positive laughter after bot joke; reaction/reply would be too much',
  );
});

test('edit_own_message updates the local message text after Telegram succeeds', async () => {
  let edited: unknown[] | undefined;
  const registry = new TelegramToolRegistry({
    chatTelegramId: -100,
    botUserTelegramId: 999,
    api: {
      deleteMessage: async () => true,
      editMessageText: async () => true,
      setMessageReaction: async () => true,
    },
    delivery: {} as never,
    imageService: disabledImageService,
    contextTools: {} as never,
    searchService: {} as never,
    messageModel: {
      findByMessageTelegramId: async () => ({
        telegramId: 123,
        chatTelegramId: -100,
        userTelegramId: 999,
      }),
      editMessage: async (...args: unknown[]) => {
        edited = args;
      },
    } as never,
  });

  await registry.execute('edit_own_message', {
    messageId: 123,
    content: '**new**',
  });

  assert.deepEqual(edited, [123, -100, '**new**']);
});

test('delete_own_message marks the local bot message deleted after Telegram succeeds', async () => {
  let markedDeleted: unknown[] | undefined;
  const registry = new TelegramToolRegistry({
    chatTelegramId: -100,
    botUserTelegramId: 999,
    api: {
      deleteMessage: async () => true,
      editMessageText: async () => true,
      setMessageReaction: async () => true,
    },
    delivery: {} as never,
    imageService: disabledImageService,
    contextTools: {} as never,
    searchService: {} as never,
    messageModel: {
      findByMessageTelegramId: async () => ({
        telegramId: 123,
        chatTelegramId: -100,
        userTelegramId: 999,
      }),
      markDeleted: async (...args: unknown[]) => {
        markedDeleted = args;
      },
    } as never,
  });

  await registry.execute('delete_own_message', {
    messageId: 123,
  });

  assert.deepEqual(markedDeleted, [123, -100]);
});
