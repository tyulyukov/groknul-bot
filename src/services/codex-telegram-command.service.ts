import { Bot, Context } from 'grammy';
import { config } from '../common/config.js';
import logger from '../common/logger.js';
import {
  CodexAuthCancelledError,
  CodexDeviceCode,
  CodexOAuthService,
} from './codex-oauth.service.js';

export class CodexTelegramCommandService {
  private codexLoginInFlight = false;
  private codexLoginGeneration = 0;

  constructor(
    private readonly oauthService: CodexOAuthService,
    private readonly ownerTelegramId = config.codex.ownerTelegramId,
  ) {}

  register<C extends Context>(bot: Bot<C>): void {
    bot.command('codex', async (ctx) => {
      if (!this.isOwner(ctx)) return;

      await this.replyWithStatus(ctx);
    });

    bot.command('codex_status', async (ctx) => {
      if (!this.isOwner(ctx)) return;

      await this.replyWithStatus(ctx);
    });

    bot.command('codex_connect', async (ctx) => {
      if (!this.isOwner(ctx)) return;

      if (this.codexLoginInFlight) {
        await ctx.reply('Codex login is already waiting for browser approval.');
        return;
      }

      const chatId = ctx.chat?.id;
      if (typeof chatId !== 'number') return;

      try {
        this.codexLoginGeneration += 1;
        this.codexLoginInFlight = true;
        const generation = this.codexLoginGeneration;
        const deviceCode = await this.oauthService.requestDeviceCode();
        await ctx.reply(
          [
            '<b>Codex login</b>',
            `Open: ${this.htmlLink(deviceCode.verificationUrl)}`,
            `Code: <code>${this.escapeHtml(deviceCode.userCode)}</code>`,
            `This expires in about ${this.loginWindowMinutes()} minutes.`,
          ].join('\n'),
        );

        this.completeLoginInBackground(
          bot,
          chatId,
          deviceCode,
          generation,
        ).catch((error) => {
          logger.error(error, 'Codex login background task failed');
        });
      } catch (error) {
        this.codexLoginInFlight = false;
        logger.error(error, 'Failed to start Codex OAuth login');
        await ctx.reply('Failed to start Codex login.');
      }
    });

    bot.command('codex_disconnect', async (ctx) => {
      if (!this.isOwner(ctx)) return;

      try {
        this.codexLoginGeneration += 1;
        this.codexLoginInFlight = false;
        const removed = await this.oauthService.disconnect();
        await ctx.reply(
          removed ? 'Codex OAuth disconnected.' : 'Codex OAuth was not connected.',
        );
      } catch (error) {
        logger.error(error, 'Failed to disconnect Codex OAuth');
        await ctx.reply('Failed to disconnect Codex OAuth.');
      }
    });
  }

  getStartMessage(ctx: Context): string | undefined {
    if (!this.isOwner(ctx)) return undefined;

    return [
      '',
      '<b>Codex OAuth</b>',
      '• /codex - status',
      '• /codex_connect - connect ChatGPT/Codex subscription',
      '• /codex_disconnect - disconnect Codex OAuth',
    ].join('\n');
  }

  private isOwner(ctx: Context): boolean {
    return (
      ctx.chat?.type === 'private' && ctx.from?.id === this.ownerTelegramId
    );
  }

  private async replyWithStatus(ctx: Context): Promise<void> {
    const status = await this.oauthService.getStatus();
    if (!status.connected) {
      await ctx.reply(
        [
          '<b>Codex OAuth</b>',
          'Status: not connected',
          `Auth file: <code>${this.escapeHtml(status.authFilePath)}</code>`,
          'Use /codex_connect to connect your ChatGPT/Codex subscription.',
        ].join('\n'),
      );
      return;
    }

    await ctx.reply(
      [
        '<b>Codex OAuth</b>',
        'Status: connected',
        status.email ? `Account: ${this.escapeHtml(status.email)}` : '',
        status.planType ? `Plan: ${this.escapeHtml(status.planType)}` : '',
        status.accountId
          ? `Workspace: <code>${this.escapeHtml(status.accountId)}</code>`
          : '',
        status.lastRefresh
          ? `Last refresh: <code>${this.escapeHtml(status.lastRefresh)}</code>`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  private async completeLoginInBackground<C extends Context>(
    bot: Bot<C>,
    chatId: number,
    deviceCode: CodexDeviceCode,
    generation: number,
  ): Promise<void> {
    try {
      const status = await this.oauthService.completeDeviceCodeLogin(
        deviceCode,
        {
          shouldPersist: () => this.isCurrentLogin(generation),
        },
      );
      const account = status.email ? ` as ${this.escapeHtml(status.email)}` : '';
      await bot.api.sendMessage(chatId, `Codex OAuth connected${account}.`);
    } catch (error) {
      if (error instanceof CodexAuthCancelledError) {
        logger.info('Codex OAuth login was cancelled before credentials persisted');
        return;
      }

      logger.error(error, 'Codex OAuth login did not complete');
      await bot.api.sendMessage(
        chatId,
        'Codex login did not complete. Run /codex_connect to try again.',
      );
    } finally {
      if (generation === this.codexLoginGeneration) {
        this.codexLoginInFlight = false;
      }
    }
  }

  private isCurrentLogin(generation: number): boolean {
    return this.codexLoginInFlight && this.codexLoginGeneration === generation;
  }

  private loginWindowMinutes(): number {
    return Math.max(1, Math.round(config.codex.devicePollMaxMs / 60_000));
  }

  private htmlLink(url: string): string {
    const escaped = this.escapeHtml(url);
    return `<a href="${escaped}">${escaped}</a>`;
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
