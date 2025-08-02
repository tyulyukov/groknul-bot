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
  };
  openRouter: {
    apiKey: string;
  };
  mongodb: {
    uri: string;
  };
}

function validateEnvVar(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Environment variable ${name} is required but not set`);
  }
  return value;
}

export const config: Config = {
  telegram: {
    apiKey: validateEnvVar('TELEGRAM_BOT_API_KEY', process.env.TELEGRAM_BOT_API_KEY),
    mode: (process.env.TELEGRAM_BOT_MODE as 'webhook' | 'polling') || 'polling',
    webhookUrl: process.env.TELEGRAM_BOT_WEBHOOK_URL,
    webhookSecret: process.env.TELEGRAM_BOT_WEBHOOK_SECRET,
    serverHost: process.env.TELEGRAM_BOT_SERVER_HOST || '0.0.0.0',
    serverPort: parseInt(process.env.TELEGRAM_BOT_SERVER_PORT || '3000', 10),
  },
  openRouter: {
    apiKey: validateEnvVar('OPENROUTER_API_KEY', process.env.OPENROUTER_API_KEY),
  },
  mongodb: {
    uri: validateEnvVar('MONGODB_URI', process.env.MONGODB_URI),
  },
}; 