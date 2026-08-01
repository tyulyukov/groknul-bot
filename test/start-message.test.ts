import assert from 'node:assert/strict';
import test from 'node:test';
import { getStartMessage } from '../src/common/start-message.js';

test('getStartMessage introduces the bot as Ishak 1.5', () => {
  const message = getStartMessage('groknul_bot');

  assert.match(message, /<b>Ishak 1\.5<\/b>/);
  assert.match(message, /I'm Ishak 1\.5,/);
});
