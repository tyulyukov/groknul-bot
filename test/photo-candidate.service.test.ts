import assert from 'node:assert/strict';
import test from 'node:test';
import { resolvePhotoCandidates } from '../src/services/photo-candidate.service.js';

test('resolvePhotoCandidates prefers required metadata matches over broad car results', () => {
  const resolution = resolvePhotoCandidates({
    query: 'brabus b63',
    requiredTerms: ['brabus'],
    limit: 2,
    results: [
      {
        title: 'BMW M5 wallpaper',
        snippet: 'black sports sedan on a road',
        imageUrl: 'https://images.example.com/bmw-m5.jpg',
        sourceUrl: 'https://example.com/bmw',
        score: 9,
      },
      {
        title: 'Mercedes Brabus B63 card photo',
        snippet: 'Brabus body kit and badge close-up',
        imageUrl: 'https://images.example.com/brabus-b63.jpg',
        sourceUrl: 'https://example.com/brabus-b63',
        score: 2,
      },
    ],
  });

  assert.equal(resolution.selected.length, 1);
  assert.equal(
    resolution.selected[0]?.imageUrl,
    'https://images.example.com/brabus-b63.jpg',
  );
  assert.match(resolution.selected[0]?.reason ?? '', /required: brabus/);
  assert.equal(
    resolution.rejected.some((candidate) =>
      candidate.reason.includes('missing required: brabus'),
    ),
    true,
  );
});

test('resolvePhotoCandidates rejects low confidence candidates instead of picking the first image', () => {
  const resolution = resolvePhotoCandidates({
    query: 'brabus',
    requiredTerms: ['brabus'],
    limit: 3,
    results: [
      {
        title: 'random luxury car',
        snippet: 'generic black SUV photo',
        imageUrl: 'https://images.example.com/random-suv.jpg',
        sourceUrl: 'https://example.com/random',
        score: 10,
      },
    ],
  });

  assert.equal(resolution.selected.length, 0);
  assert.equal(resolution.rejected.length, 1);
  assert.match(
    resolution.rejected[0]?.reason ?? '',
    /missing required: brabus/,
  );
});

test('resolvePhotoCandidates can match natural queries without making every word required', () => {
  const resolution = resolvePhotoCandidates({
    query: 'please send photo of brabus b63',
    limit: 2,
    results: [
      {
        title: 'Mercedes Brabus B63 card photo',
        snippet: 'Brabus body kit and badge close-up',
        imageUrl: 'https://images.example.com/brabus-b63.jpg',
        sourceUrl: 'https://example.com/brabus-b63',
        score: 5,
      },
    ],
  });

  assert.equal(resolution.selected.length, 1);
  assert.equal(
    resolution.selected[0]?.imageUrl,
    'https://images.example.com/brabus-b63.jpg',
  );
});

test('resolvePhotoCandidates rejects unsafe metadata before delivery', () => {
  const resolution = resolvePhotoCandidates({
    query: 'brabus b63',
    requiredTerms: ['brabus'],
    results: [
      {
        title: 'Brabus B63 nude gallery',
        snippet: 'explicit adult image set',
        imageUrl: 'https://images.example.com/brabus-b63.jpg',
        sourceUrl: 'https://example.com/brabus-b63',
        score: 10,
      },
    ],
  });

  assert.equal(resolution.selected.length, 0);
  assert.match(resolution.rejected[0]?.reason ?? '', /unsafe metadata/);
});
