import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CodexAuthCancelledError,
  CodexProviderUnavailableError,
  CodexOAuthService,
} from '../src/services/codex-oauth.service.js';

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const makeJwt = (claims: Record<string, unknown>): string => {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');

  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(claims)}.sig`;
};

const makeService = async (
  fetchFn: typeof fetch,
): Promise<{ service: CodexOAuthService; authFilePath: string; tmpDir: string }> => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-oauth-test-'));
  const authFilePath = path.join(tmpDir, 'auth.json');
  const service = new CodexOAuthService(
    {
      authFilePath,
      issuer: 'https://auth.example.test',
      clientId: 'client-test',
      devicePollMaxMs: 1000,
    },
    fetchFn,
  );

  return { service, authFilePath, tmpDir };
};

test('CodexOAuthService completes device-code login and stores auth status', async () => {
  const idToken = makeJwt({
    email: 'owner@example.test',
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'workspace-test',
      chatgpt_plan_type: 'pro',
    },
  });
  const calls: string[] = [];
  const fetchFn: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);

    if (url.endsWith('/api/accounts/deviceauth/usercode')) {
      return jsonResponse({
        device_auth_id: 'device-auth-test',
        user_code: 'CODE-123',
        interval: '1',
      });
    }

    if (url.endsWith('/api/accounts/deviceauth/token')) {
      return jsonResponse({
        authorization_code: 'authorization-code-test',
        code_verifier: 'code-verifier-test',
      });
    }

    if (url.endsWith('/oauth/token')) {
      return jsonResponse({
        id_token: idToken,
        access_token: 'access-token-test',
        refresh_token: 'refresh-token-test',
      });
    }

    return jsonResponse({ error: 'unexpected' }, 404);
  };
  const { service, authFilePath, tmpDir } = await makeService(fetchFn);

  try {
    const deviceCode = await service.requestDeviceCode();
    const status = await service.completeDeviceCodeLogin(deviceCode);
    const saved = JSON.parse(await fs.readFile(authFilePath, 'utf8')) as {
      tokens?: { access_token?: string; refresh_token?: string };
    };

    assert.equal(deviceCode.verificationUrl, 'https://auth.example.test/codex/device');
    assert.equal(deviceCode.userCode, 'CODE-123');
    assert.equal(status.connected, true);
    assert.equal(status.email, 'owner@example.test');
    assert.equal(status.accountId, 'workspace-test');
    assert.equal(status.planType, 'pro');
    assert.equal(saved.tokens?.access_token, 'access-token-test');
    assert.equal(saved.tokens?.refresh_token, 'refresh-token-test');
    assert.deepEqual(calls, [
      'https://auth.example.test/api/accounts/deviceauth/usercode',
      'https://auth.example.test/api/accounts/deviceauth/token',
      'https://auth.example.test/oauth/token',
    ]);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('CodexOAuthService refreshes expired access tokens before use', async () => {
  const expiredAccessToken = makeJwt({ exp: 1 });
  const freshAccessToken = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
  const idToken = makeJwt({
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'workspace-test',
      chatgpt_account_is_fedramp: true,
    },
  });
  let refreshCalls = 0;
  const fetchFn: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/oauth/token')) {
      refreshCalls += 1;
      return jsonResponse({
        id_token: idToken,
        access_token: freshAccessToken,
        refresh_token: 'refresh-token-fresh',
      });
    }

    return jsonResponse({ error: 'unexpected' }, 404);
  };
  const { service, authFilePath, tmpDir } = await makeService(fetchFn);

  try {
    await fs.writeFile(
      authFilePath,
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: {
          id_token: idToken,
          access_token: expiredAccessToken,
          refresh_token: 'refresh-token-old',
          account_id: 'workspace-test',
        },
        last_refresh: new Date(0).toISOString(),
      }),
    );

    const bearer = await service.getBearerAuth();
    const saved = JSON.parse(await fs.readFile(authFilePath, 'utf8')) as {
      tokens?: { access_token?: string; refresh_token?: string };
    };

    assert.equal(refreshCalls, 1);
    assert.equal(bearer.accessToken, freshAccessToken);
    assert.equal(bearer.accountId, 'workspace-test');
    assert.equal(bearer.isFedrampAccount, true);
    assert.equal(saved.tokens?.access_token, freshAccessToken);
    assert.equal(saved.tokens?.refresh_token, 'refresh-token-fresh');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('CodexOAuthService cancels device-code login before credentials persist', async () => {
  const calls: string[] = [];
  const fetchFn: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);

    if (url.endsWith('/api/accounts/deviceauth/token')) {
      return jsonResponse({
        authorization_code: 'authorization-code-test',
        code_verifier: 'code-verifier-test',
      });
    }

    if (url.endsWith('/oauth/token')) {
      return jsonResponse({
        id_token: makeJwt({ email: 'owner@example.test' }),
        access_token: 'access-token-test',
        refresh_token: 'refresh-token-test',
      });
    }

    return jsonResponse({ error: 'unexpected' }, 404);
  };
  const { service, authFilePath, tmpDir } = await makeService(fetchFn);

  try {
    await assert.rejects(
      service.completeDeviceCodeLogin(
        {
          verificationUrl: 'https://auth.example.test/codex/device',
          userCode: 'CODE-123',
          deviceAuthId: 'device-auth-test',
          intervalSec: 1,
        },
        { shouldPersist: () => false },
      ),
      CodexAuthCancelledError,
    );

    await assert.rejects(fs.stat(authFilePath), { code: 'ENOENT' });
    assert.deepEqual(calls, []);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('CodexOAuthService invalidates in-flight credential writes on disconnect', async () => {
  let service: CodexOAuthService | undefined;
  const fetchFn: typeof fetch = async (input) => {
    const url = String(input);

    if (url.endsWith('/api/accounts/deviceauth/token')) {
      return jsonResponse({
        authorization_code: 'authorization-code-test',
        code_verifier: 'code-verifier-test',
      });
    }

    if (url.endsWith('/oauth/token')) {
      await service?.disconnect();
      return jsonResponse({
        id_token: makeJwt({ email: 'owner@example.test' }),
        access_token: 'access-token-test',
        refresh_token: 'refresh-token-test',
      });
    }

    return jsonResponse({ error: 'unexpected' }, 404);
  };
  const setup = await makeService(fetchFn);
  service = setup.service;

  try {
    await assert.rejects(
      service.completeDeviceCodeLogin({
        verificationUrl: 'https://auth.example.test/codex/device',
        userCode: 'CODE-123',
        deviceAuthId: 'device-auth-test',
        intervalSec: 1,
      }),
      CodexAuthCancelledError,
    );

    await assert.rejects(fs.stat(setup.authFilePath), { code: 'ENOENT' });
  } finally {
    await fs.rm(setup.tmpDir, { recursive: true, force: true });
  }
});

test('CodexOAuthService preserves refresh failure status for fallback policy', async () => {
  const expiredAccessToken = makeJwt({ exp: 1 });
  const idToken = makeJwt({});
  const fetchFn: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/oauth/token')) {
      return jsonResponse({ error: 'temporarily unavailable' }, 500);
    }

    return jsonResponse({ error: 'unexpected' }, 404);
  };
  const { service, authFilePath, tmpDir } = await makeService(fetchFn);

  try {
    await fs.writeFile(
      authFilePath,
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: {
          id_token: idToken,
          access_token: expiredAccessToken,
          refresh_token: 'refresh-token-old',
        },
        last_refresh: new Date(0).toISOString(),
      }),
    );

    await assert.rejects(
      service.getBearerAuth(),
      (error: unknown) =>
        error instanceof CodexProviderUnavailableError && error.status === 500,
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('CodexOAuthService treats malformed auth files as disconnected', async () => {
  const fetchFn: typeof fetch = async () => jsonResponse({ error: 'unexpected' }, 404);
  const { service, authFilePath, tmpDir } = await makeService(fetchFn);

  try {
    await fs.writeFile(authFilePath, '{not-json');

    const status = await service.getStatus();

    assert.equal(status.connected, false);
    await assert.rejects(service.getBearerAuth(), /Codex OAuth is not connected/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('CodexOAuthService handles malformed stored id token shape defensively', async () => {
  const accessToken = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
  const fetchFn: typeof fetch = async () => jsonResponse({ error: 'unexpected' }, 404);
  const { service, authFilePath, tmpDir } = await makeService(fetchFn);

  try {
    await fs.writeFile(
      authFilePath,
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: {
          id_token: null,
          access_token: accessToken,
          refresh_token: 'refresh-token-old',
          account_id: 'workspace-test',
        },
        last_refresh: new Date().toISOString(),
      }),
    );

    const status = await service.getStatus();
    const bearer = await service.getBearerAuth();

    assert.equal(status.connected, true);
    assert.equal(status.email, undefined);
    assert.equal(bearer.accessToken, accessToken);
    assert.equal(bearer.accountId, 'workspace-test');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('CodexOAuthService rejects malformed refresh JSON with provider-unavailable error', async () => {
  const expiredAccessToken = makeJwt({ exp: 1 });
  const idToken = makeJwt({});
  const fetchFn: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/oauth/token')) {
      return new Response('not-json', { status: 200 });
    }

    return jsonResponse({ error: 'unexpected' }, 404);
  };
  const { service, authFilePath, tmpDir } = await makeService(fetchFn);

  try {
    await fs.writeFile(
      authFilePath,
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: {
          id_token: idToken,
          access_token: expiredAccessToken,
          refresh_token: 'refresh-token-old',
        },
        last_refresh: new Date(0).toISOString(),
      }),
    );

    await assert.rejects(
      service.getBearerAuth(),
      (error: unknown) =>
        error instanceof CodexProviderUnavailableError && error.status === 200,
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('CodexOAuthService rejects refresh responses without a fresh access token', async () => {
  const expiredAccessToken = makeJwt({ exp: 1 });
  const idToken = makeJwt({});
  const fetchFn: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/oauth/token')) {
      return jsonResponse({
        id_token: idToken,
        refresh_token: 'refresh-token-fresh',
      });
    }

    return jsonResponse({ error: 'unexpected' }, 404);
  };
  const { service, authFilePath, tmpDir } = await makeService(fetchFn);

  try {
    await fs.writeFile(
      authFilePath,
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: {
          id_token: idToken,
          access_token: expiredAccessToken,
          refresh_token: 'refresh-token-old',
        },
        last_refresh: new Date(0).toISOString(),
      }),
    );

    await assert.rejects(
      service.getBearerAuth(),
      (error: unknown) =>
        error instanceof CodexProviderUnavailableError && error.status === 200,
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
