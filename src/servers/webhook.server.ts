import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { config } from '../common/config.js';
import logger from '../common/logger.js';
import { TelegramBotService } from '../services/telegram-bot.service.js';
import { webhookCallback } from 'grammy';

export class WebhookServer {
  private app: Hono;
  private telegramBotService: TelegramBotService;

  constructor(telegramBotService: TelegramBotService) {
    this.app = new Hono();
    this.telegramBotService = telegramBotService;
    this.setupRoutes();
  }

  private setupRoutes(): void {
    this.app.get('/health', async (c) => {
      return c.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        service: 'groknul-bot',
      });
    });

    this.app.get('/', async (c) => {
      return c.json({
        message: 'Groknul Bot API',
        version: '1.0.0',
        status: 'running',
      });
    });

    this.app.post(
      '/webhook',
      webhookCallback(this.telegramBotService.getBot(), 'hono', {
        secretToken: config.telegram.webhookSecret!,
      }),
    );

    this.app.notFound((c) => {
      logger.warn(
        {
          path: c.req.path,
          method: c.req.method,
          userAgent: c.req.header('user-agent'),
        },
        'Not found request',
      );

      return c.json({ error: 'Not found' }, 404);
    });

    this.app.onError((err, c) => {
      logger.error(
        {
          error: err,
          path: c.req.path,
          method: c.req.method,
        },
        'Server error',
      );

      return c.json({ error: 'Internal server error' }, 500);
    });
  }

  async start(): Promise<void> {
    const port = config.telegram.serverPort;
    const host = config.telegram.serverHost;

    logger.info({ host, port }, 'Starting webhook server');

    serve({
      fetch: this.app.fetch,
      port,
      hostname: host,
    });

    logger.info(`Webhook server started on ${host}:${port}`);

    await this.setupWebhook();
  }

  private async setupWebhook(): Promise<void> {
    try {
      const bot = this.telegramBotService.getBot();
      const webhookUrl = config.telegram.webhookUrl!;

      logger.info({ webhookUrl }, 'Setting up webhook');

      await bot.api.setWebhook(webhookUrl, {
        secret_token: config.telegram.webhookSecret,
      });

      logger.info('Webhook set up successfully');
    } catch (error) {
      logger.error(error, 'Failed to set up webhook');
      throw error;
    }
  }

  async stop(): Promise<void> {
    logger.info('Stopping webhook server');

    if (config.telegram.mode === 'webhook') {
      try {
        await this.telegramBotService.getBot().api.deleteWebhook();
        logger.info('Webhook removed');
      } catch (error) {
        logger.error(error, 'Failed to remove webhook');
      }
    }
  }
}
