import { config } from './common/config.js';
import logger from './common/logger.js';
import { database } from './database/index.js';
import { TelegramBotService } from './services/TelegramBotService.js';
import { WebhookServer } from './server/WebhookServer.js';

class Application {
  private telegramBotService: TelegramBotService | null = null;
  private webhookServer: WebhookServer | null = null;

  async initialize(): Promise<void> {
    try {
      logger.info('Starting Groknul Bot application...');

      // Initialize database
      logger.info('Initializing database connection...');
      await database.initialize();

      // Initialize Telegram bot service
      logger.info('Initializing Telegram bot service...');
      this.telegramBotService = new TelegramBotService();

      // Initialize webhook server if needed
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

      // Start the bot
      logger.info('Starting Telegram bot...');
      await this.telegramBotService.start();

      // Start webhook server if in webhook mode
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

      // Setup graceful shutdown
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

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      logger.error(error, 'Uncaught exception');
      shutdown('uncaughtException');
    });

    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
      logger.error({ reason, promise }, 'Unhandled promise rejection');
      shutdown('unhandledRejection');
    });
  }

  async shutdown(): Promise<void> {
    logger.info('Shutting down application...');

    try {
      // Stop webhook server
      if (this.webhookServer) {
        await this.webhookServer.stop();
      }

      // Disconnect from database
      await database.disconnect();

      logger.info('Application shutdown completed');
    } catch (error) {
      logger.error(error, 'Error during shutdown');
    }
  }
}

// Create and start the application
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

// Start the application
main().catch((error) => {
  logger.error(error, 'Unhandled error in main');
  process.exit(1);
});
