import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { config } from '../common/config.js';

type EnvSource = Record<string, string | undefined>;

export interface CodexOAuthStatusProvider {
  isAvailable(): boolean;
}

interface RuntimeCodexOAuthStatusProviderOptions {
  env?: EnvSource;
  homeDir?: string;
  authFilePath?: string;
  readAuthFile?: (path: string) => string;
}

export class RuntimeCodexOAuthStatusProvider
  implements CodexOAuthStatusProvider
{
  private readonly env: EnvSource;
  private readonly homeDir: string;
  private readonly authFilePath?: string;
  private readonly readAuthFile: (path: string) => string;

  constructor(options: RuntimeCodexOAuthStatusProviderOptions = {}) {
    this.env = options.env ?? process.env;
    this.homeDir = options.homeDir ?? homedir();
    this.authFilePath =
      options.authFilePath ??
      (options.env ? undefined : config.codex.authFilePath);
    this.readAuthFile =
      options.readAuthFile ?? ((path) => readFileSync(path, 'utf8'));
  }

  isAvailable(): boolean {
    if (hasNonEmptyString(this.env.CODEX_ACCESS_TOKEN)) return true;

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

  private authFilePaths(): string[] {
    const explicitAuthFile =
      this.env.CODEX_AUTH_FILE?.trim() ||
      this.env.CODEX_AUTH_FILE_PATH?.trim() ||
      this.env.CODEX_OAUTH_AUTH_FILE?.trim();

    const codexHome =
      this.env.CODEX_HOME?.trim() || join(this.homeDir, '.codex');
    return [
      explicitAuthFile,
      this.authFilePath,
      join(codexHome, 'auth.json'),
    ].filter((path, index, paths): path is string => {
      return !!path && paths.indexOf(path) === index;
    });
  }
}

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
