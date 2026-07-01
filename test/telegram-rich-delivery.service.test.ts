import assert from 'node:assert/strict';
import test from 'node:test';
import { InputFile } from 'grammy';
import {
  calculateHumanDelayMs,
  MAX_SEND_ITEMS,
  parseSendPayload,
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

test('parseSendPayload caps user-visible message bubbles', () => {
  const payload = parseSendPayload({
    items: Array.from({ length: MAX_SEND_ITEMS + 2 }, (_, index) => ({
      plainText: `bubble ${index + 1}`,
    })),
  });

  assert.equal(payload?.items.length, MAX_SEND_ITEMS);
  assert.equal(
    payload?.items[MAX_SEND_ITEMS - 1]?.plainText,
    `bubble ${MAX_SEND_ITEMS}`,
  );
});

test('parseSendPayload preserves non-album attachments beyond the media group cap', () => {
  const payload = parseSendPayload({
    items: [
      {
        plainText: 'docs',
        attachments: Array.from({ length: 12 }, (_, index) => ({
          type: 'document',
          fileIdOrUrl: `https://files.example.com/doc-${index + 1}.pdf`,
        })),
      },
    ],
  });

  assert.equal(payload?.items[0]?.attachments?.length, 12);
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
  assert.equal(
    result.deliveries[0]?.fallbackReason,
    'rich_markdown_failed: rich unsupported',
  );
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
  let sentPhoto: unknown;
  const api = {
    sendChatAction: async () => undefined,
    sendMessage: async () => {
      throw new Error('unused');
    },
    sendPhoto: async (
      _chatId: number,
      photo: unknown,
      options: Record<string, unknown> = {},
    ) => ({
      ...(() => {
        sentPhoto = photo;
        return {};
      })(),
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
            fileIdOrUrl: 'data:image/png;base64,aW1hZ2U=',
            captionRichMarkdown: '**photo caption**',
          },
        ],
      },
    ],
  });

  assert.ok(sentPhoto instanceof InputFile);
  assert.equal((sentPhoto as InputFile).filename, 'generated-image.png');
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

test('send groups multiple photo attachments into a Telegram media album', async () => {
  const sentGroups: unknown[] = [];
  const saved: unknown[] = [];
  const service = new TelegramRichDeliveryService(
    {
      sendChatAction: async () => undefined,
      sendMessage: async () => {
        throw new Error('unused');
      },
      sendPhoto: async () => {
        throw new Error('individual photo fallback unused');
      },
      sendMediaGroup: async (
        _chatId: number,
        media: readonly unknown[],
        options: Record<string, unknown> = {},
      ) => {
        sentGroups.push({ media, options });
        return media.map((item, index) => ({
          message_id: 900 + index,
          date: 1_778_800_010 + index,
          caption:
            typeof (item as { caption?: unknown }).caption === 'string'
              ? (item as { caption: string }).caption
              : undefined,
        }));
      },
    },
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

  const result = await service.send(-100, {
    items: [
      {
        plainText: 'outer text',
        replyToMessageId: 123,
        attachments: [
          {
            type: 'photo',
            fileIdOrUrl: 'https://images.example.com/one.jpg',
            captionRichMarkdown: '**brabus**',
          },
          {
            type: 'photo',
            fileIdOrUrl: 'https://images.example.com/two.jpg',
            captionPlainText: 'second caption is ignored in album',
          },
        ],
      },
    ],
  });

  assert.equal(sentGroups.length, 1);
  assert.deepEqual(sentGroups[0], {
    media: [
      {
        type: 'photo',
        media: 'https://images.example.com/one.jpg',
        caption: '<b>brabus</b>',
        parse_mode: 'HTML',
      },
      {
        type: 'photo',
        media: 'https://images.example.com/two.jpg',
      },
    ],
    options: { reply_to_message_id: 123 },
  });
  assert.deepEqual(result.deliveries, [
    { telegramId: 900, format: 'photo' },
    { telegramId: 901, format: 'photo' },
  ]);
  assert.equal((saved[0] as { text?: unknown }).text, '**brabus**');
  assert.equal((saved[1] as { text?: unknown }).text, '');
});

test('send falls back to individual photos when media album sending fails', async () => {
  const sentPhotos: string[] = [];
  const service = new TelegramRichDeliveryService(
    {
      sendChatAction: async () => undefined,
      sendMessage: async () => {
        throw new Error('unused');
      },
      sendMediaGroup: async () => {
        throw new Error('album rejected');
      },
      sendPhoto: async (
        _chatId: number,
        photo: string | InputFile,
        options: Record<string, unknown> = {},
      ) => {
        sentPhotos.push(String(photo));
        return {
          message_id: 920 + sentPhotos.length,
          date: 1_778_800_020 + sentPhotos.length,
          caption:
            typeof options.caption === 'string' ? options.caption : undefined,
        };
      },
    },
    { sendRichMessage: async () => ({ message_id: 1, date: 1 }) },
    { saveMessage: async () => undefined },
    999,
    { sleep: async () => undefined },
  );

  const result = await service.send(-100, {
    items: [
      {
        plainText: 'photos',
        attachments: [
          {
            type: 'photo',
            fileIdOrUrl: 'https://images.example.com/one.jpg',
          },
          {
            type: 'photo',
            fileIdOrUrl: 'https://images.example.com/two.jpg',
          },
        ],
      },
    ],
  });

  assert.deepEqual(sentPhotos, [
    'https://images.example.com/one.jpg',
    'https://images.example.com/two.jpg',
  ]);
  assert.equal(result.deliveries.length, 2);
  assert.match(result.deliveries[0]?.fallbackReason ?? '', /album rejected/);
});

test('send keeps partial individual photo fallback successes instead of throwing total failure', async () => {
  const service = new TelegramRichDeliveryService(
    {
      sendChatAction: async () => undefined,
      sendMessage: async () => {
        throw new Error('unused');
      },
      sendMediaGroup: async () => {
        throw new Error('album rejected');
      },
      sendPhoto: async (
        _chatId: number,
        photo: string | InputFile,
        options: Record<string, unknown> = {},
      ) => {
        if (String(photo).includes('two.jpg')) {
          throw new Error('second photo rejected');
        }

        return {
          message_id: 930,
          date: 1_778_800_030,
          caption:
            typeof options.caption === 'string' ? options.caption : undefined,
        };
      },
    },
    { sendRichMessage: async () => ({ message_id: 1, date: 1 }) },
    { saveMessage: async () => undefined },
    999,
    { sleep: async () => undefined },
  );

  const result = await service.send(-100, {
    items: [
      {
        plainText: 'photos',
        attachments: [
          {
            type: 'photo',
            fileIdOrUrl: 'https://images.example.com/one.jpg',
          },
          {
            type: 'photo',
            fileIdOrUrl: 'https://images.example.com/two.jpg',
          },
        ],
      },
    ],
  });

  assert.deepEqual(result.deliveries, [
    {
      telegramId: 930,
      format: 'photo',
      fallbackReason: 'media_group_failed: album rejected',
    },
  ]);
});

test('send propagates ordinary individual attachment failures outside album fallback', async () => {
  const service = new TelegramRichDeliveryService(
    {
      sendChatAction: async () => undefined,
      sendMessage: async () => {
        throw new Error('unused');
      },
      sendPhoto: async () => ({
        message_id: 940,
        date: 1_778_800_040,
      }),
      sendDocument: async () => {
        throw new Error('document rejected');
      },
    },
    { sendRichMessage: async () => ({ message_id: 1, date: 1 }) },
    { saveMessage: async () => undefined },
    999,
    { sleep: async () => undefined },
  );

  await assert.rejects(
    service.send(-100, {
      items: [
        {
          plainText: 'mixed',
          attachments: [
            {
              type: 'photo',
              fileIdOrUrl: 'https://images.example.com/one.jpg',
            },
            {
              type: 'document',
              fileIdOrUrl: 'https://files.example.com/two.pdf',
            },
          ],
        },
      ],
    }),
    /document rejected/,
  );
});

test('send rejects unsupported generated image data URL attachments', async () => {
  const service = new TelegramRichDeliveryService(
    {
      sendChatAction: async () => undefined,
      sendMessage: async () => {
        throw new Error('unused');
      },
      sendPhoto: async () => {
        throw new Error('unused');
      },
    },
    { sendRichMessage: async () => ({ message_id: 1, date: 1 }) },
    { saveMessage: async () => undefined },
    999,
    { sleep: async () => undefined },
  );

  await assert.rejects(
    service.send(-100, {
      items: [
        {
          plainText: 'gif',
          attachments: [
            {
              type: 'photo',
              fileIdOrUrl: 'data:image/gif;base64,R0lGODlh',
            },
          ],
        },
      ],
    }),
    /Unsupported generated image data URL format/,
  );
});

test('send caps deliveries even when passed an oversized payload directly', async () => {
  const sentTexts: string[] = [];
  const service = new TelegramRichDeliveryService(
    {
      sendChatAction: async () => undefined,
      sendMessage: async (_chatId: number, text: string) => {
        sentTexts.push(text);
        return {
          message_id: 800 + sentTexts.length,
          date: 1_778_800_002,
          text,
        };
      },
    },
    { sendRichMessage: async () => ({ message_id: 1, date: 1 }) },
    { saveMessage: async () => undefined },
    999,
    { random: () => 0, sleep: async () => undefined },
  );

  const result = await service.send(-100, {
    items: Array.from({ length: MAX_SEND_ITEMS + 2 }, (_, index) => ({
      plainText: `bubble ${index + 1}`,
    })),
  });

  assert.equal(sentTexts.length, MAX_SEND_ITEMS);
  assert.equal(result.deliveries.length, MAX_SEND_ITEMS);
});
