import assert from 'node:assert/strict';
import test from 'node:test';
import { TelegramToolRegistry } from '../src/services/telegram-tool-registry.service.js';

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

  assert.deepEqual(replaceCalls, [
    [123, -100, 999, [{ emoji: '🔥' }]],
  ]);
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
