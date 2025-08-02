import { config } from './common/config.js';
import logger from './common/logger.js';
import { database } from './database';
import { TelegramBotService } from './services/telegram-bot.service';
import { WebhookServer } from './servers/webhook.server';

class Application {
  private telegramBotService: TelegramBotService | null = null;
  private webhookServer: WebhookServer | null = null;

  async initialize(): Promise<void> {
    try {
      logger.info('Starting Groknul Bot application...');

      logger.info('Initializing database connection...');
      await database.initialize();

      logger.info('Initializing Telegram bot service...');
      this.telegramBotService = new TelegramBotService();

      if (config.telegram.mode === 'webhook') {
        logger.info('Initializing webhook server...');
        this.webhookServer = new WebhookServer(this.telegramBotService);
      }

      logger.info('Application initialized successfully');
    } catch (error) {
      logger.error(error, 'Failed to initialize application');
      throw error;
    }
  }

  async start(): Promise<void> {
    try {
      if (!this.telegramBotService) {
        throw new Error('Application not initialized');
      }

      logger.info('Starting Telegram bot...');
      await this.telegramBotService.start();

      if (this.webhookServer) {
        logger.info('Starting webhook server...');
        await this.webhookServer.start();
      }

      logger.info(
        {
          mode: config.telegram.mode,
          botUsername: this.telegramBotService.getBotUsername(),
        },
        'Groknul Bot started successfully',
      );

      this.setupGracefulShutdown();
    } catch (error) {
      logger.error(error, 'Failed to start application');
      await this.shutdown();
      throw error;
    }
  }

  private setupGracefulShutdown(): void {
    const shutdown = async (signal: string) => {
      logger.info({ signal }, 'Received shutdown signal');
      await this.shutdown();
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    process.on('uncaughtException', (error) => {
      logger.error(error, 'Uncaught exception');
      return shutdown('uncaughtException');
    });

    process.on('unhandledRejection', (reason, promise) => {
      logger.error({ reason, promise }, 'Unhandled promise rejection');
      return shutdown('unhandledRejection');
    });
  }

  async shutdown(): Promise<void> {
    logger.info('Shutting down application...');

    try {
      if (this.webhookServer) {
        await this.webhookServer.stop();
      }

      await database.disconnect();

      logger.info('Application shutdown completed');
    } catch (error) {
      logger.error(error, 'Error during shutdown');
    }
  }
}

const app = new Application();

async function main() {
  try {
    await app.initialize();
    await app.start();
  } catch (error) {
    logger.error(error, 'Failed to start application');
    process.exit(1);
  }
}

main().catch((error) => {
  logger.error(error, 'Unhandled error in main');
  process.exit(1);
});
