import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractMemoryTexts,
  extractReplyContextMessages,
} from '../src/services/agent-response.service.js';

test('extractMemoryTexts returns trimmed memory text only', () => {
  const memories = extractMemoryTexts({
    status: 'ok',
    memories: [
      { text: '  likes short replies  ' },
      { text: '' },
      { text: 123 },
      null,
    ],
  });

  assert.deepEqual(memories, ['likes short replies']);
});

test('extractMemoryTexts ignores non-ok memory results', () => {
  assert.deepEqual(
    extractMemoryTexts({
      status: 'too_large',
      suggested: { limit: 10 },
    }),
    [],
  );
});

test('extractReplyContextMessages keeps the current reply chain', () => {
  const messages = extractReplyContextMessages({
    status: 'ok',
    messages: [
      {
        id: 123,
        from: 'maksym',
        text: '@groknul_bot новости на стол',
        sentAt: new Date('2026-06-19T09:33:00.000Z'),
        replyToMessageId: 122,
      },
      {
        id: 122,
        from: 'maksym',
        text: 'а это ты ебнул tay keith?',
        sentAt: new Date('2026-06-19T09:32:00.000Z'),
        replyToMessageId: 121,
      },
      {
        id: 121,
        from: 'sanyochek',
        text: 'мне надо на треп хату там в корее',
        sentAt: new Date('2026-06-19T09:31:00.000Z'),
      },
    ],
  });

  assert.deepEqual(messages, [
    {
      id: 123,
      from: 'maksym',
      text: '@groknul_bot новости на стол',
      sentAt: '2026-06-19T09:33:00.000Z',
      replyToMessageId: 122,
    },
    {
      id: 122,
      from: 'maksym',
      text: 'а это ты ебнул tay keith?',
      sentAt: '2026-06-19T09:32:00.000Z',
      replyToMessageId: 121,
    },
    {
      id: 121,
      from: 'sanyochek',
      text: 'мне надо на треп хату там в корее',
      sentAt: '2026-06-19T09:31:00.000Z',
    },
  ]);
});

test('extractReplyContextMessages omits non-reply threads', () => {
  assert.deepEqual(
    extractReplyContextMessages({
      status: 'ok',
      messages: [
        {
          id: 123,
          from: 'maksym',
          text: '@groknul_bot новости на стол',
        },
      ],
    }),
    [],
  );
});
