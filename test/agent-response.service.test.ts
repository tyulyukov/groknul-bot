import assert from 'node:assert/strict';
import test from 'node:test';
import { extractMemoryTexts } from '../src/services/agent-response.service.js';

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
