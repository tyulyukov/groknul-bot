import dotenv from 'dotenv';

dotenv.config();

interface Config {
  telegram: {
    apiKey: string;
    mode: 'webhook' | 'polling';
    webhookUrl?: string;
    webhookSecret?: string;
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
  };
  mongodb: {
    uri: string;
  };
}

const getRequiredEnvVar = (name: string): string => {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Environment variable ${name} is required but not set`);
  }

  return value;
};

export const config: Config = {
  telegram: {
    apiKey: getRequiredEnvVar('TELEGRAM_BOT_API_KEY'),
    mode: (process.env.TELEGRAM_BOT_MODE as 'webhook' | 'polling') || 'polling',
    webhookUrl: process.env.TELEGRAM_BOT_WEBHOOK_URL,
    webhookSecret: process.env.TELEGRAM_BOT_WEBHOOK_SECRET,
    serverHost: process.env.TELEGRAM_BOT_SERVER_HOST || '0.0.0.0',
    serverPort: parseInt(process.env.TELEGRAM_BOT_SERVER_PORT || '3000', 10),
    adminIds: (process.env.TELEGRAM_BOT_ADMIN_IDS || '')
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
      .map((v) => Number(v))
      .filter((v) => Number.isFinite(v)),
    ambient: {
      enabled:
        String(process.env.TELEGRAM_BOT_AMBIENT_ENABLED).toLowerCase() ===
        'true',
      probability: parseFloat(
        process.env.TELEGRAM_BOT_AMBIENT_PROBABILITY || '0.03',
      ),
      minCooldownSec: parseInt(
        process.env.TELEGRAM_BOT_AMBIENT_MIN_COOLDOWN_SEC || '180',
        10,
      ),
      minGapMessages: parseInt(
        process.env.TELEGRAM_BOT_AMBIENT_MIN_GAP_MESSAGES || '40',
        10,
      ),
      maxContextAgeMinutes: parseInt(
        process.env.TELEGRAM_BOT_AMBIENT_MAX_CONTEXT_AGE_MINUTES || '90',
        10,
      ),
    },
  },
  openRouter: {
    apiKey: getRequiredEnvVar('OPENROUTER_API_KEY'),
  },
  mongodb: {
    uri: getRequiredEnvVar('MONGODB_URI'),
  },
};
