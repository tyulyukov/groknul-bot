import dotenv from 'dotenv';

dotenv.config();

export interface Config {
  telegram: {
    apiKey: string;
    mode: 'webhook' | 'polling';
    webhookUrl?: string;
    webhookSecret?: string;
    webhookTimeoutMs: number;
    serverHost: string;
    serverPort: number;
    adminIds: number[];
    ambient: {
      enabled: boolean;
      probability: number;
      minCooldownSec: number;
      minGapMessages: number;
      maxContextAgeMinutes: number;
    };
  };
  openRouter: {
    apiKey: string;
    models: {
      reply: string;
      agent: string;
      summary: string;
      vision: string;
    };
  };
  searxng: {
    baseUrl: string;
    timeoutMs: number;
    maxResults: number;
    cacheTtlMs: number;
    perChatRateLimit: {
      windowMs: number;
      maxRequests: number;
    };
  };
  agent: {
    maxToolCalls: number;
    context: {
      maxMessages: number;
      maxChars: number;
      maxResults: number;
    };
  };
  mongodb: {
    uri: string;
  };
}

type EnvSource = Record<string, string | undefined>;

const getRequiredEnvVar = (env: EnvSource, name: string): string => {
  const value = env[name];

  if (!value) {
    throw new Error(`Environment variable ${name} is required but not set`);
  }

  return value;
};

const parseInteger = (
  env: EnvSource,
  name: string,
  defaultValue: number,
): number => {
  const raw = env[name];
  if (!raw) return defaultValue;

  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : defaultValue;
};

const parseFloatValue = (
  env: EnvSource,
  name: string,
  defaultValue: number,
): number => {
  const raw = env[name];
  if (!raw) return defaultValue;

  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : defaultValue;
};

const parseTelegramMode = (value?: string): 'webhook' | 'polling' =>
  value === 'webhook' ? 'webhook' : 'polling';

export const createConfig = (env: EnvSource): Config => ({
  telegram: {
    apiKey: getRequiredEnvVar(env, 'TELEGRAM_BOT_API_KEY'),
    mode: parseTelegramMode(env.TELEGRAM_BOT_MODE),
    webhookUrl: env.TELEGRAM_BOT_WEBHOOK_URL,
    webhookSecret: env.TELEGRAM_BOT_WEBHOOK_SECRET,
    webhookTimeoutMs: parseInteger(env, 'TELEGRAM_BOT_WEBHOOK_TIMEOUT_MS', 9_000),
    serverHost: env.TELEGRAM_BOT_SERVER_HOST || '0.0.0.0',
    serverPort: parseInteger(env, 'TELEGRAM_BOT_SERVER_PORT', 3000),
    adminIds: (env.TELEGRAM_BOT_ADMIN_IDS || '')
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
      .map((v) => Number(v))
      .filter((v) => Number.isFinite(v)),
    ambient: {
      enabled: String(env.TELEGRAM_BOT_AMBIENT_ENABLED).toLowerCase() === 'true',
      probability: parseFloatValue(env, 'TELEGRAM_BOT_AMBIENT_PROBABILITY', 0.03),
      minCooldownSec: parseInteger(
        env,
        'TELEGRAM_BOT_AMBIENT_MIN_COOLDOWN_SEC',
        180,
      ),
      minGapMessages: parseInteger(
        env,
        'TELEGRAM_BOT_AMBIENT_MIN_GAP_MESSAGES',
        40,
      ),
      maxContextAgeMinutes: parseInteger(
        env,
        'TELEGRAM_BOT_AMBIENT_MAX_CONTEXT_AGE_MINUTES',
        90,
      ),
    },
  },
  openRouter: {
    apiKey: getRequiredEnvVar(env, 'OPENROUTER_API_KEY'),
    models: {
      reply: env.OPENROUTER_REPLY_MODEL || 'openai/gpt-5.5',
      agent: env.OPENROUTER_AGENT_MODEL || 'openai/gpt-5.5',
      summary: env.OPENROUTER_SUMMARY_MODEL || 'openai/gpt-5.4-mini',
      vision: env.OPENROUTER_VISION_MODEL || 'openai/gpt-5.4-mini',
    },
  },
  searxng: {
    baseUrl: env.SEARXNG_BASE_URL || 'http://127.0.0.1:8080',
    timeoutMs: parseInteger(env, 'SEARXNG_TIMEOUT_MS', 8000),
    maxResults: parseInteger(env, 'SEARXNG_MAX_RESULTS', 5),
    cacheTtlMs: parseInteger(env, 'SEARXNG_CACHE_TTL_MS', 10 * 60 * 1000),
    perChatRateLimit: {
      windowMs: parseInteger(env, 'SEARXNG_RATE_LIMIT_WINDOW_MS', 60_000),
      maxRequests: parseInteger(env, 'SEARXNG_RATE_LIMIT_MAX_REQUESTS', 6),
    },
  },
  agent: {
    maxToolCalls: parseInteger(env, 'AGENT_MAX_TOOL_CALLS', 10),
    context: {
      maxMessages: parseInteger(env, 'AGENT_CONTEXT_MAX_MESSAGES', 80),
      maxChars: parseInteger(env, 'AGENT_CONTEXT_MAX_CHARS', 24_000),
      maxResults: parseInteger(env, 'AGENT_CONTEXT_MAX_RESULTS', 30),
    },
  },
  mongodb: {
    uri: getRequiredEnvVar(env, 'MONGODB_URI'),
  },
});

export const config: Config = createConfig(process.env);
