import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { database } from '../database/index.js';

type EnvSource = Record<string, string | undefined>;

export interface CodexOAuthStatusProvider {
  isAvailable(): boolean;
}

interface RuntimeCodexOAuthStatusProviderOptions {
  env?: EnvSource;
  homeDir?: string;
  readAuthFile?: (path: string) => string;
  credentialSnapshot?: () => Record<string, unknown> | null;
}

export class RuntimeCodexOAuthStatusProvider
  implements CodexOAuthStatusProvider
{
  private readonly env: EnvSource;
  private readonly homeDir: string;
  private readonly readAuthFile: (path: string) => string;
  private readonly credentialSnapshot: () => Record<string, unknown> | null;

  constructor(options: RuntimeCodexOAuthStatusProviderOptions = {}) {
    this.env = options.env ?? process.env;
    this.homeDir = options.homeDir ?? homedir();
    this.readAuthFile =
      options.readAuthFile ?? ((path) => readFileSync(path, 'utf8'));
    this.credentialSnapshot =
      options.credentialSnapshot ?? defaultCredentialSnapshot;
  }

  isAvailable(): boolean {
    if (hasNonEmptyString(this.env.CODEX_ACCESS_TOKEN)) return true;

    if (hasCachedChatGptTokens(this.credentialSnapshot())) return true;

    for (const authFilePath of this.authFilePaths()) {
      try {
        if (
          hasCachedChatGptTokens(
            JSON.parse(this.readAuthFile(authFilePath)) as unknown,
          )
        ) {
          return true;
        }
      } catch {
        continue;
      }
    }

    return false;
  }

  // Fallback paths for an external Codex CLI install (not the bot's own
  // credentials, which now live in MongoDB).
  private authFilePaths(): string[] {
    const explicitAuthFile =
      this.env.CODEX_AUTH_FILE?.trim() || this.env.CODEX_AUTH_FILE_PATH?.trim();

    const codexHome =
      this.env.CODEX_HOME?.trim() || join(this.homeDir, '.codex');
    return [explicitAuthFile, join(codexHome, 'auth.json')].filter(
      (path, index, paths): path is string => {
        return !!path && paths.indexOf(path) === index;
      },
    );
  }
}

const defaultCredentialSnapshot = (): Record<string, unknown> | null => {
  return database.tryGetCodexAuthModel()?.getCached() ?? null;
};

const hasCachedChatGptTokens = (value: unknown): boolean => {
  if (!isRecord(value)) return false;

  const tokens = value.tokens;
  if (!isRecord(tokens)) return false;

  return (
    hasNonEmptyString(tokens.access_token) ||
    hasNonEmptyString(tokens.refresh_token) ||
    hasNonEmptyString(tokens.id_token)
  );
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;
