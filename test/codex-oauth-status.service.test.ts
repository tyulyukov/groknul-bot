import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RuntimeCodexOAuthStatusProvider } from '../src/services/codex-oauth-status.service.js';

test('RuntimeCodexOAuthStatusProvider enables image generation with CODEX_ACCESS_TOKEN', () => {
  const provider = new RuntimeCodexOAuthStatusProvider({
    env: { CODEX_ACCESS_TOKEN: 'codex-access-token' },
    homeDir: '/missing-home',
  });

  assert.equal(provider.isAvailable(), true);
});

test('RuntimeCodexOAuthStatusProvider enables image generation with cached ChatGPT tokens', async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'codex-auth-'));
  try {
    await writeFile(
      join(codexHome, 'auth.json'),
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: {
          access_token: 'cached-access-token',
        },
      }),
    );

    const provider = new RuntimeCodexOAuthStatusProvider({
      env: { CODEX_HOME: codexHome },
      homeDir: '/missing-home',
    });

    assert.equal(provider.isAvailable(), true);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test('RuntimeCodexOAuthStatusProvider supports the bot Codex OAuth auth file path', async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'codex-auth-'));
  const authFilePath = join(codexHome, 'bot-codex-auth.json');
  try {
    await writeFile(
      authFilePath,
      JSON.stringify({
        tokens: {
          access_token: 'cached-access-token',
          refresh_token: 'cached-refresh-token',
        },
      }),
    );

    const provider = new RuntimeCodexOAuthStatusProvider({
      env: { CODEX_OAUTH_AUTH_FILE: authFilePath },
      homeDir: '/missing-home',
    });

    assert.equal(provider.isAvailable(), true);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test('RuntimeCodexOAuthStatusProvider rejects API-key-only Codex auth', async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'codex-auth-'));
  try {
    await writeFile(
      join(codexHome, 'auth.json'),
      JSON.stringify({
        auth_mode: 'apikey',
        OPENAI_API_KEY: 'sk-test',
      }),
    );

    const provider = new RuntimeCodexOAuthStatusProvider({
      env: { CODEX_HOME: codexHome },
      homeDir: '/missing-home',
    });

    assert.equal(provider.isAvailable(), false);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test('RuntimeCodexOAuthStatusProvider disables image generation when auth is missing', () => {
  const provider = new RuntimeCodexOAuthStatusProvider({
    env: { CODEX_HOME: '/missing-codex-home' },
    homeDir: '/missing-home',
  });

  assert.equal(provider.isAvailable(), false);
});
