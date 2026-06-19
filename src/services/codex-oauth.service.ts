import { config } from '../common/config.js';
import { database } from '../database/index.js';

const TOKEN_REFRESH_INTERVAL_MS = 8 * 24 * 60 * 60 * 1000;
const ACCESS_TOKEN_REFRESH_WINDOW_MS = 5 * 60 * 1000;

export interface CodexDeviceCode {
  verificationUrl: string;
  userCode: string;
  deviceAuthId: string;
  intervalSec: number;
}

export interface CodexAuthStatus {
  connected: boolean;
  email?: string;
  accountId?: string;
  planType?: string;
  lastRefresh?: string;
  storage: string;
}

export interface CodexBearerAuth {
  accessToken: string;
  accountId?: string;
  isFedrampAccount: boolean;
}

interface CodexOAuthOptions {
  issuer: string;
  clientId: string;
  devicePollMaxMs: number;
}

export interface CodexAuthFile {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: CodexStoredTokens | null;
  last_refresh?: string | null;
}

/**
 * Durable store for the Codex OAuth credential blob. Backed by MongoDB in
 * production so credentials survive container redeploys; tests inject an
 * in-memory implementation.
 */
export interface CodexCredentialStore {
  read(): Promise<CodexAuthFile | null>;
  write(auth: CodexAuthFile): Promise<void>;
  clear(): Promise<boolean>;
  describe(): string;
}

class DatabaseCodexCredentialStore implements CodexCredentialStore {
  async read(): Promise<CodexAuthFile | null> {
    const model = database.tryGetCodexAuthModel();
    if (!model) return null;
    return (await model.get()) as CodexAuthFile | null;
  }

  async write(auth: CodexAuthFile): Promise<void> {
    await database
      .getCodexAuthModel()
      .save(auth as unknown as Record<string, unknown>);
  }

  async clear(): Promise<boolean> {
    return database.getCodexAuthModel().delete();
  }

  describe(): string {
    return 'MongoDB (codexauth)';
  }
}

interface CodexStoredTokens {
  id_token: string | CodexIdTokenInfo;
  access_token: string;
  refresh_token: string;
  account_id?: string | null;
}

interface CodexIdTokenInfo {
  raw_jwt?: string;
  email?: string;
  chatgpt_plan_type?: string;
  chatgpt_user_id?: string;
  chatgpt_account_id?: string;
  chatgpt_account_is_fedramp?: boolean;
}

interface DeviceUserCodeResponse {
  device_auth_id?: unknown;
  user_code?: unknown;
  usercode?: unknown;
  interval?: unknown;
}

interface DeviceTokenResponse {
  authorization_code?: unknown;
  code_verifier?: unknown;
}

interface OAuthTokenResponse {
  id_token?: unknown;
  access_token?: unknown;
  refresh_token?: unknown;
}

interface CodexTokenBundle {
  id_token: string;
  access_token: string;
  refresh_token: string;
}

export class CodexAuthUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexAuthUnavailableError';
  }
}

export class CodexAuthCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexAuthCancelledError';
  }
}

export class CodexProviderUnavailableError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'CodexProviderUnavailableError';
  }
}

export class CodexOAuthService {
  private readonly issuer: string;
  private readonly clientId: string;
  private readonly devicePollMaxMs: number;
  private readonly store: CodexCredentialStore;
  private authMutationGeneration = 0;
  private credentialMutationQueue: Promise<void> = Promise.resolve();

  constructor(
    options: Partial<CodexOAuthOptions> = {},
    private readonly fetchFn: typeof fetch = fetch,
    store: CodexCredentialStore = new DatabaseCodexCredentialStore(),
  ) {
    this.issuer = (options.issuer ?? config.codex.issuer).replace(/\/+$/, '');
    this.clientId = options.clientId ?? config.codex.clientId;
    this.devicePollMaxMs =
      options.devicePollMaxMs ?? config.codex.devicePollMaxMs;
    this.store = store;
  }

  async getStatus(): Promise<CodexAuthStatus> {
    const auth = await this.readCredentials();
    const tokens = auth?.tokens;
    if (!tokens?.access_token || !tokens.refresh_token) {
      return {
        connected: false,
        storage: this.store.describe(),
      };
    }

    const idToken = this.idTokenJwt(tokens);
    const claims = idToken ? this.decodeJwtClaims(idToken) : {};
    const authClaims = this.authClaims(claims);

    return {
      connected: true,
      email:
        this.stringField(claims.email) ??
        this.stringField(this.objectField(claims.profile)?.email),
      accountId:
        this.stringField(tokens.account_id) ??
        this.stringField(authClaims.chatgpt_account_id),
      planType: this.stringField(authClaims.chatgpt_plan_type),
      lastRefresh: auth?.last_refresh ?? undefined,
      storage: this.store.describe(),
    };
  }

  async disconnect(): Promise<boolean> {
    this.invalidateCredentialWrites();

    return this.queueCredentialMutation(async () => {
      return this.store.clear();
    });
  }

  async requestDeviceCode(): Promise<CodexDeviceCode> {
    const response = await this.fetchJson<DeviceUserCodeResponse>(
      `${this.issuer}/api/accounts/deviceauth/usercode`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: this.clientId }),
      },
    );

    const userCode =
      this.stringField(response.user_code) ?? this.stringField(response.usercode);
    const deviceAuthId = this.stringField(response.device_auth_id);
    if (!userCode || !deviceAuthId) {
      throw new Error('Codex device auth response did not include a code');
    }

    return {
      verificationUrl: `${this.issuer}/codex/device`,
      userCode,
      deviceAuthId,
      intervalSec: this.parseIntervalSec(response.interval),
    };
  }

  async completeDeviceCodeLogin(
    deviceCode: CodexDeviceCode,
    options: { shouldPersist?: () => boolean } = {},
  ): Promise<CodexAuthStatus> {
    const mutationGeneration = this.authMutationGeneration;
    const tokenResponse = await this.pollDeviceToken(
      deviceCode,
      options.shouldPersist,
    );
    this.assertLoginStillActive(options.shouldPersist);

    const authorizationCode = this.stringField(tokenResponse.authorization_code);
    const codeVerifier = this.stringField(tokenResponse.code_verifier);
    if (!authorizationCode || !codeVerifier) {
      throw new Error('Codex device auth did not return an authorization code');
    }

    const tokens = await this.exchangeAuthorizationCode(
      authorizationCode,
      codeVerifier,
    );
    this.assertLoginStillActive(options.shouldPersist);

    await this.persistTokens(tokens, mutationGeneration);
    return this.getStatus();
  }

  async getBearerAuth(): Promise<CodexBearerAuth> {
    const auth = await this.readCredentials();
    if (!auth?.tokens?.access_token || !auth.tokens.refresh_token) {
      throw new CodexAuthUnavailableError('Codex OAuth is not connected');
    }

    const refreshedAuth = this.shouldRefresh(auth)
      ? await this.refreshAuth(auth)
      : auth;
    const tokens = refreshedAuth.tokens;
    if (!tokens?.access_token) {
      throw new CodexAuthUnavailableError('Codex OAuth token is unavailable');
    }

    const idToken = this.idTokenJwt(tokens);
    const claims = idToken ? this.decodeJwtClaims(idToken) : {};
    const authClaims = this.authClaims(claims);

    return {
      accessToken: tokens.access_token,
      accountId:
        this.stringField(tokens.account_id) ??
        this.stringField(authClaims.chatgpt_account_id),
      isFedrampAccount:
        this.booleanField(authClaims.chatgpt_account_is_fedramp) ?? false,
    };
  }

  async refreshAuthAfterUnauthorized(): Promise<void> {
    const auth = await this.readCredentials();
    if (!auth?.tokens?.refresh_token) {
      throw new CodexAuthUnavailableError('Codex OAuth refresh token is unavailable');
    }

    await this.refreshAuth(auth);
  }

  private async pollDeviceToken(
    deviceCode: CodexDeviceCode,
    shouldContinue?: () => boolean,
  ): Promise<DeviceTokenResponse> {
    const startedAt = Date.now();
    const intervalMs = Math.max(1, deviceCode.intervalSec) * 1000;

    while (Date.now() - startedAt <= this.devicePollMaxMs) {
      this.assertLoginStillActive(shouldContinue);
      const response = await this.fetchFn(
        `${this.issuer}/api/accounts/deviceauth/token`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            device_auth_id: deviceCode.deviceAuthId,
            user_code: deviceCode.userCode,
          }),
        },
      );

      if (response.ok) {
        return (await response.json()) as DeviceTokenResponse;
      }

      if (response.status !== 403 && response.status !== 404) {
        throw new Error(
          `Codex device auth failed with status ${response.status}`,
        );
      }

      await this.sleep(intervalMs);
      this.assertLoginStillActive(shouldContinue);
    }

    throw new Error('Codex device auth timed out');
  }

  private async exchangeAuthorizationCode(
    code: string,
    codeVerifier: string,
  ): Promise<CodexTokenBundle> {
    const response = await this.fetchFn(`${this.issuer}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${this.issuer}/deviceauth/callback`,
        client_id: this.clientId,
        code_verifier: codeVerifier,
      }).toString(),
    });

    if (!response.ok) {
      throw this.providerUnavailableError(
        'Codex token exchange failed',
        response.status,
      );
    }

    return this.assertTokenResponse(
      await this.parseTokenResponse(response, 'Codex token exchange'),
    );
  }

  private async refreshAuth(auth: CodexAuthFile): Promise<CodexAuthFile> {
    const mutationGeneration = this.authMutationGeneration;
    const refreshToken = auth.tokens?.refresh_token;
    if (!refreshToken) {
      throw new CodexAuthUnavailableError('Codex OAuth refresh token is unavailable');
    }

    const response = await this.fetchFn(`${this.issuer}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: this.clientId,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    });

    if (!response.ok) {
      throw this.providerUnavailableError(
        'Codex token refresh failed',
        response.status,
      );
    }

    const refreshed = await this.parseTokenResponse(response, 'Codex token refresh');
    const refreshedAccessToken = this.stringField(refreshed.access_token);
    if (!refreshedAccessToken) {
      throw this.providerUnavailableError(
        'Codex token refresh response is missing access token',
        response.status,
      );
    }

    const currentTokens = auth.tokens;
    if (!currentTokens) {
      throw new CodexAuthUnavailableError('Codex OAuth token data is unavailable');
    }
    const nextAuth: CodexAuthFile = {
      ...auth,
      auth_mode: 'chatgpt',
      tokens: {
        id_token:
          this.stringField(refreshed.id_token) ?? currentTokens.id_token,
        access_token: refreshedAccessToken,
        refresh_token:
          this.stringField(refreshed.refresh_token) ?? currentTokens.refresh_token,
        account_id: currentTokens.account_id,
      },
      last_refresh: new Date().toISOString(),
    };

    await this.writeCredentialAuthFile(nextAuth, mutationGeneration);
    return nextAuth;
  }

  private async persistTokens(
    tokens: CodexTokenBundle,
    mutationGeneration: number,
  ): Promise<void> {
    const claims = this.decodeJwtClaims(tokens.id_token);
    const accountId = this.stringField(
      this.authClaims(claims).chatgpt_account_id,
    );

    await this.writeCredentialAuthFile({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        id_token: tokens.id_token,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        account_id: accountId,
      },
      last_refresh: new Date().toISOString(),
    }, mutationGeneration);
  }

  private async readCredentials(): Promise<CodexAuthFile | null> {
    const auth = await this.store.read();
    return auth && typeof auth === 'object' ? auth : null;
  }

  private async writeCredentialAuthFile(
    auth: CodexAuthFile,
    mutationGeneration: number,
  ): Promise<void> {
    await this.queueCredentialMutation(async () => {
      this.assertCredentialWritesCurrent(mutationGeneration);
      await this.store.write(auth);
    });
  }

  private queueCredentialMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const run = this.credentialMutationQueue
      .catch(() => undefined)
      .then(mutation);
    this.credentialMutationQueue = run.then(
      () => undefined,
      () => undefined,
    );

    return run;
  }

  private invalidateCredentialWrites(): void {
    this.authMutationGeneration += 1;
  }

  private assertCredentialWritesCurrent(mutationGeneration: number): void {
    if (mutationGeneration !== this.authMutationGeneration) {
      throw new CodexAuthCancelledError('Codex OAuth credentials changed');
    }
  }

  private shouldRefresh(auth: CodexAuthFile): boolean {
    const tokens = auth.tokens;
    if (!tokens?.access_token) return true;

    const accessTokenExpiresAt = this.jwtExpiresAt(tokens.access_token);
    if (accessTokenExpiresAt) {
      return (
        accessTokenExpiresAt.getTime() <=
        Date.now() + ACCESS_TOKEN_REFRESH_WINDOW_MS
      );
    }

    const lastRefresh = auth.last_refresh ? Date.parse(auth.last_refresh) : NaN;
    return (
      !Number.isFinite(lastRefresh) ||
      lastRefresh < Date.now() - TOKEN_REFRESH_INTERVAL_MS
    );
  }

  private async fetchJson<T>(url: string, init: RequestInit): Promise<T> {
    const response = await this.fetchFn(url, init);
    if (!response.ok) {
      throw new Error(`Codex OAuth request failed with status ${response.status}`);
    }

    return (await response.json()) as T;
  }

  private async parseTokenResponse(
    response: Response,
    context: string,
  ): Promise<OAuthTokenResponse> {
    try {
      const parsed = (await response.json()) as unknown;
      if (parsed && typeof parsed === 'object') {
        return parsed as OAuthTokenResponse;
      }
    } catch {
      throw this.providerUnavailableError(
        `${context} response was not valid JSON`,
        response.status,
      );
    }

    throw this.providerUnavailableError(
      `${context} response was malformed`,
      response.status,
    );
  }

  private assertTokenResponse(response: OAuthTokenResponse): CodexTokenBundle {
    const idToken = this.stringField(response.id_token);
    const accessToken = this.stringField(response.access_token);
    const refreshToken = this.stringField(response.refresh_token);
    if (!idToken || !accessToken || !refreshToken) {
      throw new Error('Codex OAuth token response is missing tokens');
    }

    return {
      id_token: idToken,
      access_token: accessToken,
      refresh_token: refreshToken,
    };
  }

  private assertLoginStillActive(shouldPersist: (() => boolean) | undefined): void {
    if (shouldPersist && !shouldPersist()) {
      throw new CodexAuthCancelledError('Codex OAuth login was cancelled');
    }
  }

  private providerUnavailableError(
    message: string,
    status: number,
  ): CodexProviderUnavailableError {
    return new CodexProviderUnavailableError(
      `${message} with status ${status}`,
      status,
    );
  }

  private idTokenJwt(tokens: CodexStoredTokens): string | undefined {
    if (typeof tokens.id_token === 'string') return tokens.id_token;
    const tokenInfo = this.objectField(tokens.id_token);
    return this.stringField(tokenInfo?.raw_jwt);
  }

  private jwtExpiresAt(jwt: string): Date | null {
    const exp = this.numberField(this.decodeJwtClaims(jwt).exp);
    if (typeof exp !== 'number') return null;

    const date = new Date(exp * 1000);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  private decodeJwtClaims(jwt: string): Record<string, unknown> {
    const [, payload] = jwt.split('.');
    if (!payload) return {};

    try {
      const decoded = Buffer.from(payload, 'base64url').toString('utf8');
      const parsed = JSON.parse(decoded) as unknown;
      return parsed && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  private authClaims(claims: Record<string, unknown>): Record<string, unknown> {
    return (
      this.objectField(claims['https://api.openai.com/auth']) ??
      {}
    );
  }

  private parseIntervalSec(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.max(1, value);
    }

    if (typeof value === 'string') {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) return Math.max(1, parsed);
    }

    return 5;
  }

  private objectField(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : undefined;
  }

  private stringField(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0
      ? value
      : undefined;
  }

  private numberField(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }

  private booleanField(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
