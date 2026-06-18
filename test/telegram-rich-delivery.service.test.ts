import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateHumanDelayMs,
  TelegramRichDeliveryService,
} from '../src/services/telegram-rich-delivery.service.js';

test('calculateHumanDelayMs is length aware and capped', () => {
  assert.equal(
    calculateHumanDelayMs({ textLength: 20, random: () => 0, delayHintMs: 0 }),
    450,
  );
  assert.equal(
    calculateHumanDelayMs({
      textLength: 10_000,
      random: () => 1,
      delayHintMs: 10_000,
    }),
    4_500,
  );
});

test('send falls back from rich markdown to HTML sendMessage and persists delivery metadata', async () => {
  const calls: string[] = [];
  const api = {
    sendChatAction: async () => calls.push('typing'),
    sendMessage: async (_chatId: number, text: string) => {
      calls.push(`sendMessage:${text}`);
      return {
        message_id: 700,
        date: 1_778_800_000,
        text,
      };
    },
  };
  const rawClient = {
    sendRichMessage: async () => {
      calls.push('sendRichMessage');
      throw new Error('rich unsupported');
    },
  };
  const saved: unknown[] = [];
  const messageModel = {
    saveMessage: async (doc: unknown) => {
      saved.push(doc);
      return doc;
    },
  };
  const service = new TelegramRichDeliveryService(
    api,
    rawClient,
    messageModel,
    999,
    { random: () => 0, sleep: async () => undefined },
  );

  const result = await service.send(-100, {
    items: [
      {
        richMarkdown: '**hello**',
        plainText: 'hello',
        replyToMessageId: 123,
      },
    ],
  });

  assert.deepEqual(calls, [
    'typing',
    'sendRichMessage',
    'sendMessage:<b>hello</b>',
  ]);
  assert.equal(result.deliveries[0]?.format, 'html');
  assert.equal(result.deliveries[0]?.fallbackReason, 'rich_markdown_failed: rich unsupported');
  assert.deepEqual(saved[0], {
    telegramId: 700,
    chatTelegramId: -100,
    userTelegramId: 999,
    text: '**hello**',
    replyToMessageTelegramId: 123,
    sentAt: new Date(1_778_800_000 * 1000),
    messageType: 'text',
    payload: { message_id: 700, date: 1_778_800_000, text: '<b>hello</b>' },
    deliveryFormat: 'html',
    deliveryText: '<b>hello</b>',
    deliveryFallbackReason: 'rich_markdown_failed: rich unsupported',
  });
});

test('send persists photo attachment as photo with attachment caption text', async () => {
  const api = {
    sendChatAction: async () => undefined,
    sendMessage: async () => {
      throw new Error('unused');
    },
    sendPhoto: async (
      _chatId: number,
      _photo: string,
      options: Record<string, unknown> = {},
    ) => ({
      message_id: 701,
      date: 1_778_800_001,
      caption:
        typeof options.caption === 'string' ? options.caption : undefined,
    }),
  };
  const saved: unknown[] = [];
  const service = new TelegramRichDeliveryService(
    api,
    { sendRichMessage: async () => ({ message_id: 1, date: 1 }) },
    {
      saveMessage: async (doc: unknown) => {
        saved.push(doc);
        return doc;
      },
    },
    999,
    { sleep: async () => undefined },
  );

  await service.send(-100, {
    items: [
      {
        plainText: 'outer text',
        attachments: [
          {
            type: 'photo',
            fileIdOrUrl: 'photo-file',
            captionRichMarkdown: '**photo caption**',
          },
        ],
      },
    ],
  });

  assert.deepEqual(saved[0], {
    telegramId: 701,
    chatTelegramId: -100,
    userTelegramId: 999,
    text: '**photo caption**',
    replyToMessageTelegramId: undefined,
    sentAt: new Date(1_778_800_001 * 1000),
    messageType: 'photo',
    payload: {
      message_id: 701,
      date: 1_778_800_001,
      caption: '<b>photo caption</b>',
    },
    deliveryFormat: 'photo',
    deliveryText: '<b>photo caption</b>',
    deliveryFallbackReason: undefined,
  });
});
