import assert from 'node:assert/strict';
import test from 'node:test';
import { InputFile } from 'grammy';
import { maybeSendAmbientMeme } from '../src/services/ambient-meme.service.js';

const enabledCodexOAuthStatus = {
  isAvailable: () => true,
};

test('maybeSendAmbientMeme skips model work when Codex OAuth is unavailable', async () => {
  let ideaCalls = 0;
  let imageCalls = 0;

  const sent = await maybeSendAmbientMeme({
    api: {
      sendMessage: async () => {
        throw new Error('unused');
      },
    },
    aiService: {
      generateAmbientMemeIdea: async () => {
        ideaCalls += 1;
        return null;
      },
      generateImage: async () => {
        imageCalls += 1;
        throw new Error('unused');
      },
    },
    codexOAuthStatus: {
      isAvailable: () => false,
    },
    botUserTelegramId: 999,
    botUsername: 'groknul_bot',
    chatTelegramId: -100,
    context: [],
    messageModel: {
      saveMessage: async () => ({}) as never,
    },
    random: () => 0,
    triggerMessageId: 123,
  });

  assert.equal(sent, false);
  assert.equal(ideaCalls, 0);
  assert.equal(imageCalls, 0);
});

test('maybeSendAmbientMeme skips model work when image probability gate misses', async () => {
  let ideaCalls = 0;

  const sent = await maybeSendAmbientMeme({
    api: {
      sendMessage: async () => {
        throw new Error('unused');
      },
    },
    aiService: {
      generateAmbientMemeIdea: async () => {
        ideaCalls += 1;
        return null;
      },
      generateImage: async () => {
        throw new Error('unused');
      },
    },
    codexOAuthStatus: enabledCodexOAuthStatus,
    botUserTelegramId: 999,
    botUsername: 'groknul_bot',
    chatTelegramId: -100,
    context: [],
    messageModel: {
      saveMessage: async () => ({}) as never,
    },
    random: () => 1,
    triggerMessageId: 123,
  });

  assert.equal(sent, false);
  assert.equal(ideaCalls, 0);
});

test('maybeSendAmbientMeme generates and persists an ambient meme photo', async () => {
  let sentPhoto: unknown;
  let saved: Record<string, unknown> | undefined;

  const sent = await maybeSendAmbientMeme({
    api: {
      sendChatAction: async () => undefined,
      sendMessage: async () => {
        throw new Error('unused');
      },
      sendPhoto: async (
        _chatId: number,
        photo: unknown,
        options: Record<string, unknown> = {},
      ) => {
        sentPhoto = photo;
        return {
          message_id: 777,
          date: 1_778_800_010,
          caption:
            typeof options.caption === 'string' ? options.caption : undefined,
        };
      },
    },
    aiService: {
      generateAmbientMemeIdea: async () => ({
        prompt: 'two deployment graphs arguing in meme format',
        caption: 'графік вибрав хаос',
      }),
      generateImage: async () => ({
        dataUrl: 'data:image/png;base64,aW1hZ2U=',
      }),
    },
    codexOAuthStatus: enabledCodexOAuthStatus,
    botUserTelegramId: 999,
    botUsername: 'groknul_bot',
    chatTelegramId: -100,
    context: [],
    messageModel: {
      saveMessage: async (doc: Record<string, unknown>) => {
        saved = doc;
        return doc as never;
      },
    },
    random: () => 0,
    triggerMessageId: 123,
  });

  assert.equal(sent, true);
  assert.ok(sentPhoto instanceof InputFile);
  assert.equal((sentPhoto as InputFile).filename, 'generated-image.png');
  assert.equal(saved?.telegramId, 777);
  assert.equal(saved?.chatTelegramId, -100);
  assert.equal(saved?.userTelegramId, 999);
  assert.equal(saved?.text, 'графік вибрав хаос');
  assert.equal(saved?.messageType, 'photo');
});
