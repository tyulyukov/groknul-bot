import { config } from '../common/config.js';
import logger from '../common/logger.js';
import type {
  PopulatedMessage,
  MessageModel,
} from '../database/models/Message.js';
import type { AiService } from './ai.service.js';
import { RawTelegramApiClient } from './raw-telegram-api-client.service.js';
import {
  buildGeneratedPhotoPayload,
  TelegramRichDeliveryService,
  type TelegramApiLike,
} from './telegram-rich-delivery.service.js';
import {
  RuntimeCodexOAuthStatusProvider,
  type CodexOAuthStatusProvider,
} from './codex-oauth-status.service.js';

interface AmbientMemeInput {
  api: TelegramApiLike;
  aiService: Pick<AiService, 'generateAmbientMemeIdea' | 'generateImage'>;
  codexOAuthStatus?: CodexOAuthStatusProvider;
  botUserTelegramId: number;
  botUsername: string;
  chatTelegramId: number;
  context: PopulatedMessage[];
  messageModel: Pick<MessageModel, 'saveMessage'>;
  random?: () => number;
  triggerMessageId: number;
}

export const maybeSendAmbientMeme = async (
  input: AmbientMemeInput,
): Promise<boolean> => {
  const codexOAuthStatus =
    input.codexOAuthStatus ?? new RuntimeCodexOAuthStatusProvider();
  if (!codexOAuthStatus.isAvailable()) {
    logger.info(
      { chatId: input.chatTelegramId },
      'Ambient image gate: Codex OAuth unavailable',
    );
    return false;
  }

  const imageProbability = config.telegram.ambient.imageProbability;
  if (imageProbability <= 0) return false;

  const roll = (input.random ?? Math.random)();
  if (roll >= imageProbability) {
    logger.info(
      {
        roll,
        imageProbability,
        chatId: input.chatTelegramId,
      },
      'Ambient image gate: probability not passed',
    );
    return false;
  }

  const idea = await input.aiService.generateAmbientMemeIdea(
    input.context,
    input.botUsername,
  );
  if (!idea) return false;

  const image = await input.aiService.generateImage({
    prompt: idea.prompt,
    aspectRatio: '1:1',
  });
  if (!image) return false;

  const delivery = new TelegramRichDeliveryService(
    input.api,
    new RawTelegramApiClient(config.telegram.apiKey),
    input.messageModel,
    input.botUserTelegramId,
  );
  const result = await delivery.send(
    input.chatTelegramId,
    buildGeneratedPhotoPayload({
      caption: idea.caption,
      imageDataUrl: image.dataUrl,
    }),
  );

  logger.info(
    {
      chatId: input.chatTelegramId,
      triggerMessageId: input.triggerMessageId,
      deliveries: result.deliveries,
      captionPreview: idea.caption.slice(0, 160),
    },
    'Ambient meme image sent',
  );

  return true;
};
