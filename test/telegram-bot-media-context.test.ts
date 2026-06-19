import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message as TelegramMessage } from 'grammy/types';
import {
  hasAmbientTextOrMediaContext,
  mergeMessageContexts,
} from '../src/services/telegram-bot.service.js';

test('mergeMessageContexts trims and joins existing and incoming context', () => {
  assert.equal(
    mergeMessageContexts(' Poll details ', ' Voice transcript '),
    'Poll details\n\nVoice transcript',
  );
  assert.equal(mergeMessageContexts(undefined, '  '), undefined);
  assert.equal(
    mergeMessageContexts(' image context ', undefined),
    'image context',
  );
});

test('hasAmbientTextOrMediaContext allows text messages and requires context for media', () => {
  const textMessage = {
    message_id: 1,
    date: 1_778_800_000,
    chat: { id: -100, type: 'group', title: 'chat' },
    text: 'ambient text',
  } as TelegramMessage;
  const voiceMessage = {
    message_id: 2,
    date: 1_778_800_000,
    chat: { id: -100, type: 'group', title: 'chat' },
    voice: {
      file_id: 'voice-file',
      file_unique_id: 'voice-unique',
      duration: 4,
      mime_type: 'audio/ogg',
    },
  } as TelegramMessage;

  assert.equal(hasAmbientTextOrMediaContext(textMessage), true);
  assert.equal(hasAmbientTextOrMediaContext(voiceMessage), false);
  assert.equal(
    hasAmbientTextOrMediaContext(voiceMessage, 'Voice message transcript: hi'),
    true,
  );
});
