import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexTelegramCommandService } from '../src/services/codex-telegram-command.service.js';
import {
  CodexAuthCancelledError,
  CodexOAuthService,
} from '../src/services/codex-oauth.service.js';

type CommandHandler = (ctx: {
  chat?: { id: number; type: string };
  from?: { id: number };
  reply: (message: string) => Promise<void>;
}) => Promise<void>;

const createBotStub = (): {
  bot: {
    api: { sendMessage: (chatId: number, message: string) => Promise<void> };
    command: (name: string, handler: CommandHandler) => void;
  };
  commands: Map<string, CommandHandler>;
  sentMessages: string[];
} => {
  const commands = new Map<string, CommandHandler>();
  const sentMessages: string[] = [];

  return {
    commands,
    sentMessages,
    bot: {
      api: {
        sendMessage: async (_chatId, message) => {
          sentMessages.push(message);
        },
      },
      command: (name, handler) => {
        commands.set(name, handler);
      },
    },
  };
};

const createReplyContext = (
  chat: { id: number; type: string },
  fromId: number,
): {
  ctx: Parameters<CommandHandler>[0];
  replies: string[];
} => {
  const replies: string[] = [];
  return {
    replies,
    ctx: {
      chat,
      from: { id: fromId },
      reply: async (message) => {
        replies.push(message);
      },
    },
  };
};

test('CodexTelegramCommandService only exposes status to the owner in private chat', async () => {
  let statusCalls = 0;
  const oauthService = {
    getStatus: async () => {
      statusCalls += 1;
      return {
        connected: false,
        storage: 'MongoDB (codexauth)',
      };
    },
  } as unknown as CodexOAuthService;
  const service = new CodexTelegramCommandService(oauthService);
  const { bot, commands } = createBotStub();
  service.register(bot as never);

  const nonOwner = createReplyContext({ id: 1, type: 'private' }, 42);
  await commands.get('codex')?.(nonOwner.ctx);
  assert.equal(statusCalls, 0);
  assert.deepEqual(nonOwner.replies, []);

  const ownerInGroup = createReplyContext({ id: -100123, type: 'supergroup' }, 870_452_692);
  await commands.get('codex')?.(ownerInGroup.ctx);
  assert.equal(statusCalls, 0);
  assert.deepEqual(ownerInGroup.replies, []);

  const ownerDm = createReplyContext({ id: 870_452_692, type: 'private' }, 870_452_692);
  await commands.get('codex')?.(ownerDm.ctx);
  assert.equal(statusCalls, 1);
  assert.equal(ownerDm.replies.length, 1);
  assert.match(ownerDm.replies[0] ?? '', /Status: not connected/);
});

test('CodexTelegramCommandService hides start-message OAuth commands from non-owners', () => {
  const service = new CodexTelegramCommandService({} as CodexOAuthService);

  assert.equal(
    service.getStartMessage({
      chat: { id: 1, type: 'private' },
      from: { id: 42 },
    } as never),
    undefined,
  );
  assert.equal(
    service.getStartMessage({
      chat: { id: -100123, type: 'supergroup' },
      from: { id: 870_452_692 },
    } as never),
    undefined,
  );
  assert.match(
    service.getStartMessage({
      chat: { id: 870_452_692, type: 'private' },
      from: { id: 870_452_692 },
    } as never) ?? '',
    /\/codex_connect/,
  );
});

test('CodexTelegramCommandService disconnect invalidates an in-flight login completion', async () => {
  let completeStarted!: () => void;
  let completeRelease!: () => void;
  let completeFinished!: () => void;
  const completeStartedPromise = new Promise<void>((resolve) => {
    completeStarted = resolve;
  });
  const completeReleasePromise = new Promise<void>((resolve) => {
    completeRelease = resolve;
  });
  const completeFinishedPromise = new Promise<void>((resolve) => {
    completeFinished = resolve;
  });
  let disconnectCalls = 0;

  const oauthService = {
    requestDeviceCode: async () => ({
      verificationUrl: 'https://auth.example.test/codex/device',
      userCode: 'CODE-123',
      deviceAuthId: 'device-auth-test',
      intervalSec: 1,
    }),
    disconnect: async () => {
      disconnectCalls += 1;
      return true;
    },
    completeDeviceCodeLogin: async (
      _deviceCode: unknown,
      options?: { shouldPersist?: () => boolean },
    ) => {
      completeStarted();
      await completeReleasePromise;
      try {
        if (!options?.shouldPersist?.()) {
          throw new CodexAuthCancelledError('Codex OAuth login was cancelled');
        }

        return {
          connected: true,
          storage: 'MongoDB (codexauth)',
          email: 'owner@example.test',
        };
      } finally {
        completeFinished();
      }
    },
  } as unknown as CodexOAuthService;
  const service = new CodexTelegramCommandService(oauthService);
  const { bot, commands, sentMessages } = createBotStub();
  service.register(bot as never);

  const connectCtx = createReplyContext(
    { id: 870_452_692, type: 'private' },
    870_452_692,
  );
  await commands.get('codex_connect')?.(connectCtx.ctx);
  await completeStartedPromise;

  const disconnectCtx = createReplyContext(
    { id: 870_452_692, type: 'private' },
    870_452_692,
  );
  await commands.get('codex_disconnect')?.(disconnectCtx.ctx);
  completeRelease();
  await completeFinishedPromise;

  assert.equal(disconnectCalls, 1);
  assert.deepEqual(sentMessages, []);
  assert.match(disconnectCtx.replies[0] ?? '', /disconnected/i);
});
