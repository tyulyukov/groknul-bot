import assert from 'node:assert/strict';
import test from 'node:test';
import { AiService } from '../src/services/ai.service.js';

test('generateAmbientInterjection uses reply model with low reasoning', async () => {
  let seenParams: Record<string, unknown> | undefined;
  const aiClient = {
    completeRaw: async (params: Record<string, unknown>) => {
      seenParams = params;
      return {
        choices: [
          {
            message: {
              content: 'solid point',
            },
          },
        ],
        usage: { total_tokens: 1 },
      };
    },
  };
  const service = new AiService(aiClient as never);

  const result = await service.generateAmbientInterjection([], 'groknul_bot');

  assert.equal(result, 'solid point');
  assert.equal(seenParams?.model, 'openai/gpt-5.5');
  assert.deepEqual(seenParams?.reasoning, { effort: 'low' });
});
