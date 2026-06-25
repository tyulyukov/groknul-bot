import assert from 'node:assert/strict';
import test from 'node:test';
import type { Poll as TelegramPoll } from 'grammy/types';
import { buildTelegramPollContext } from '../src/services/message-ingestion.service.js';

test('buildTelegramPollContext includes current poll vote counts', () => {
  const context = buildTelegramPollContext({
    id: 'poll-1',
    question: 'Дата для дс',
    options: [
      { text: '21 июня', voter_count: 1 },
      { text: '22 июня', voter_count: 3 },
    ],
    total_voter_count: 4,
    is_closed: false,
    is_anonymous: false,
    type: 'regular',
    allows_multiple_answers: false,
  } as TelegramPoll);

  assert.match(context, /Total votes: 4/);
  assert.match(context, /1\. 21 июня - 1 vote/);
  assert.match(context, /2\. 22 июня - 3 votes/);
});
