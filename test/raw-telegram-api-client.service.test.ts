import assert from 'node:assert/strict';
import test from 'node:test';
import { RawTelegramApiClient } from '../src/services/raw-telegram-api-client.service.js';

test('sendRichMessage posts Bot API 10.1 InputRichMessage markdown and reply_parameters', async () => {
  let requestBody: unknown;
  const client = new RawTelegramApiClient('token', async (_url, init) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        ok: true,
        result: { message_id: 1, date: 1 },
      }),
      { status: 200 },
    );
  });

  await client.sendRichMessage(-100, '**hello**', {
    reply_to_message_id: 123,
  });

  assert.deepEqual(requestBody, {
    chat_id: -100,
    rich_message: {
      markdown: '**hello**',
    },
    reply_parameters: {
      message_id: 123,
    },
  });
});
