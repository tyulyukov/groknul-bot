import assert from 'node:assert/strict';
import test from 'node:test';
import { WebhookServer } from '../src/servers/webhook.server.js';
import type { TelegramBotService } from '../src/services/telegram-bot.service.js';

test('WebhookServer stop does not delete the Telegram webhook during rolling deploy shutdown', async () => {
  let deleteWebhookCalled = false;
  const bot = {
    isRunning: () => false,
    api: {
      deleteWebhook: async () => {
        deleteWebhookCalled = true;
      },
    },
  };
  const telegramBotService = {
    getBot: () => bot,
  } as unknown as TelegramBotService;
  const server = new WebhookServer(telegramBotService);

  await server.stop();

  assert.equal(deleteWebhookCalled, false);
});
