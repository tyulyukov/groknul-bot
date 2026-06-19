import assert from 'node:assert/strict';
import test from 'node:test';
import { AiService, parseAmbientMemeIdea } from '../src/services/ai.service.js';

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

test('generateImage uses configured image model', async () => {
  let seenInput: Record<string, unknown> | undefined;
  const aiClient = {
    generateImage: async (input: Record<string, unknown>) => {
      seenInput = input;
      return {
        dataUrl: 'data:image/png;base64,aW1hZ2U=',
      };
    },
  };
  const service = new AiService(aiClient as never);

  const result = await service.generateImage({
    prompt: 'telegram meme',
    aspectRatio: '16:9',
  });

  assert.deepEqual(result, {
    dataUrl: 'data:image/png;base64,aW1hZ2U=',
  });
  assert.deepEqual(seenInput, {
    model: 'openai/gpt-5.4-image-2',
    prompt: 'telegram meme',
    aspectRatio: '16:9',
    imageSize: '1K',
  });
});

test('parseAmbientMemeIdea accepts strict JSON and rejects abstentions', () => {
  assert.deepEqual(
    parseAmbientMemeIdea(
      '{"prompt":"two devs staring at a failing deploy graph, meme style","caption":"deploy graph said nah"}',
    ),
    {
      prompt: 'two devs staring at a failing deploy graph, meme style',
      caption: 'deploy graph said nah',
    },
  );
  assert.equal(parseAmbientMemeIdea('NOOP'), null);
  assert.equal(parseAmbientMemeIdea('{"prompt":"","caption":"nah"}'), null);
});
