import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CodexAuthCancelledError,
  CodexProviderUnavailableError,
  CodexOAuthService,
  type CodexAuthFile,
  type CodexCredentialStore,
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

interface TestStore {
  store: CodexCredentialStore;
  current: () => CodexAuthFile | null;
}

const makeStore = (initial: CodexAuthFile | null = null): TestStore => {
  let data: CodexAuthFile | null = initial;
  return {
    store: {
      read: async () => data,
      write: async (auth) => {
        data = auth;
      },
      clear: async () => {
        const had = data !== null;
        data = null;
        return had;
      },
      describe: () => 'in-memory',
    },
    current: () => data,
  };
};

const makeService = (
  fetchFn: typeof fetch,
  initial: CodexAuthFile | null = null,
): { service: CodexOAuthService; store: TestStore } => {
  const store = makeStore(initial);
  const service = new CodexOAuthService(
    {
      issuer: 'https://auth.example.test',
      clientId: 'client-test',
      devicePollMaxMs: 1000,
    },
    fetchFn,
    store.store,
  );

  return { service, store };
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
  const { service, store } = makeService(fetchFn);

  const deviceCode = await service.requestDeviceCode();
  const status = await service.completeDeviceCodeLogin(deviceCode);
  const saved = store.current();

  assert.equal(deviceCode.verificationUrl, 'https://auth.example.test/codex/device');
  assert.equal(deviceCode.userCode, 'CODE-123');
  assert.equal(status.connected, true);
  assert.equal(status.email, 'owner@example.test');
  assert.equal(status.accountId, 'workspace-test');
  assert.equal(status.planType, 'pro');
  assert.equal(status.storage, 'in-memory');
  assert.equal(saved?.tokens?.access_token, 'access-token-test');
  assert.equal(saved?.tokens?.refresh_token, 'refresh-token-test');
  assert.deepEqual(calls, [
    'https://auth.example.test/api/accounts/deviceauth/usercode',
    'https://auth.example.test/api/accounts/deviceauth/token',
    'https://auth.example.test/oauth/token',
  ]);
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
  const { service, store } = makeService(fetchFn, {
    auth_mode: 'chatgpt',
    tokens: {
      id_token: idToken,
      access_token: expiredAccessToken,
      refresh_token: 'refresh-token-old',
      account_id: 'workspace-test',
    },
    last_refresh: new Date(0).toISOString(),
  });

  const bearer = await service.getBearerAuth();
  const saved = store.current();

  assert.equal(refreshCalls, 1);
  assert.equal(bearer.accessToken, freshAccessToken);
  assert.equal(bearer.accountId, 'workspace-test');
  assert.equal(bearer.isFedrampAccount, true);
  assert.equal(saved?.tokens?.access_token, freshAccessToken);
  assert.equal(saved?.tokens?.refresh_token, 'refresh-token-fresh');
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
  const { service, store } = makeService(fetchFn);

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

  assert.equal(store.current(), null);
  assert.deepEqual(calls, []);
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
  const setup = makeService(fetchFn);
  service = setup.service;

  await assert.rejects(
    service.completeDeviceCodeLogin({
      verificationUrl: 'https://auth.example.test/codex/device',
      userCode: 'CODE-123',
      deviceAuthId: 'device-auth-test',
      intervalSec: 1,
    }),
    CodexAuthCancelledError,
  );

  assert.equal(setup.store.current(), null);
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
  const { service } = makeService(fetchFn, {
    auth_mode: 'chatgpt',
    tokens: {
      id_token: idToken,
      access_token: expiredAccessToken,
      refresh_token: 'refresh-token-old',
    },
    last_refresh: new Date(0).toISOString(),
  });

  await assert.rejects(
    service.getBearerAuth(),
    (error: unknown) =>
      error instanceof CodexProviderUnavailableError && error.status === 500,
  );
});

test('CodexOAuthService treats partial credential documents as disconnected', async () => {
  const fetchFn: typeof fetch = async () => jsonResponse({ error: 'unexpected' }, 404);
  const { service } = makeService(fetchFn, { auth_mode: 'chatgpt' });

  const status = await service.getStatus();

  assert.equal(status.connected, false);
  await assert.rejects(service.getBearerAuth(), /Codex OAuth is not connected/);
});

test('CodexOAuthService handles malformed stored id token shape defensively', async () => {
  const accessToken = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
  const fetchFn: typeof fetch = async () => jsonResponse({ error: 'unexpected' }, 404);
  const { service } = makeService(fetchFn, {
    auth_mode: 'chatgpt',
    tokens: {
      id_token: null as unknown as string,
      access_token: accessToken,
      refresh_token: 'refresh-token-old',
      account_id: 'workspace-test',
    },
    last_refresh: new Date().toISOString(),
  });

  const status = await service.getStatus();
  const bearer = await service.getBearerAuth();

  assert.equal(status.connected, true);
  assert.equal(status.email, undefined);
  assert.equal(bearer.accessToken, accessToken);
  assert.equal(bearer.accountId, 'workspace-test');
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
  const { service } = makeService(fetchFn, {
    auth_mode: 'chatgpt',
    tokens: {
      id_token: idToken,
      access_token: expiredAccessToken,
      refresh_token: 'refresh-token-old',
    },
    last_refresh: new Date(0).toISOString(),
  });

  await assert.rejects(
    service.getBearerAuth(),
    (error: unknown) =>
      error instanceof CodexProviderUnavailableError && error.status === 200,
  );
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
  const { service } = makeService(fetchFn, {
    auth_mode: 'chatgpt',
    tokens: {
      id_token: idToken,
      access_token: expiredAccessToken,
      refresh_token: 'refresh-token-old',
    },
    last_refresh: new Date(0).toISOString(),
  });

  await assert.rejects(
    service.getBearerAuth(),
    (error: unknown) =>
      error instanceof CodexProviderUnavailableError && error.status === 200,
  );
});
