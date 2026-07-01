import assert from 'node:assert/strict';
import test from 'node:test';
import { PhotoTaskRegistry } from '../src/services/photo-task-registry.service.js';

test('PhotoTaskRegistry exposes only running photo tasks as active', () => {
  let nowMs = 1_778_800_000_000;
  const registry = new PhotoTaskRegistry(() => new Date(nowMs), 60_000);

  const task = registry.start({
    chatTelegramId: -100,
    triggerMessageId: 123,
    query: 'brabus b63',
  });

  assert.equal(registry.getActive(-100)?.id, task.id);
  assert.equal(registry.getActive(-100)?.status, 'queued');

  registry.update(task, { status: 'searching' });
  assert.equal(registry.getActive(-100)?.status, 'searching');

  registry.complete(task, { selectedCount: 2 });
  assert.equal(registry.getActive(-100), undefined);

  const stale = registry.start({
    chatTelegramId: -100,
    triggerMessageId: 124,
    query: 'old photo',
  });
  nowMs += 61_000;

  assert.equal(registry.getActive(-100), undefined);
  assert.equal(registry.get(stale), undefined);
});

test('PhotoTaskRegistry does not let stale tasks clear newer active tasks', () => {
  let nowMs = 1_778_800_000_000;
  const registry = new PhotoTaskRegistry(() => new Date(nowMs), 60_000);

  const stale = registry.start({
    chatTelegramId: -100,
    triggerMessageId: 123,
    query: 'old photo',
  });
  nowMs += 61_000;
  assert.equal(registry.getActive(-100), undefined);

  const current = registry.start({
    chatTelegramId: -100,
    triggerMessageId: 124,
    query: 'new photo',
  });

  registry.complete(stale, { selectedCount: 1 });
  assert.equal(registry.getActive(-100)?.id, current.id);

  registry.fail(stale, 'old failed late');
  assert.equal(registry.getActive(-100)?.id, current.id);
});
