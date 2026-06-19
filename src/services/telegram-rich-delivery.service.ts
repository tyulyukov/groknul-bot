import { markdownToTelegramHtml } from '../utils/markdown-to-telegram-html.js';
import type { RawTelegramApiClientLike } from './raw-telegram-api-client.service.js';

export type DeliveryFormat =
  | 'rich_markdown'
  | 'html'
  | 'plain'
  | 'photo'
  | 'document'
  | 'poll';

export interface SendAttachment {
  type: 'photo' | 'document';
  fileIdOrUrl: string;
  captionRichMarkdown?: string;
  captionPlainText?: string;
}

export interface SendPollPayload {
  question: string;
  options: string[];
  isAnonymous?: boolean;
  allowsMultipleAnswers?: boolean;
}

export interface SendItem {
  richMarkdown?: string;
  richHtml?: string;
  plainText: string;
  replyToMessageId?: number;
  attachments?: SendAttachment[];
  poll?: SendPollPayload;
  delayHintMs?: number;
}

export interface SendPayload {
  items: SendItem[];
}

export const MAX_SEND_ITEMS = 3;

export interface DeliveryResult {
  telegramId: number;
  format: DeliveryFormat;
  fallbackReason?: string;
}

export interface TelegramApiLike {
  sendChatAction?: (chatId: number, action: 'typing') => Promise<unknown>;
  sendMessage: (
    chatId: number,
    text: string,
    options?: Record<string, unknown>,
  ) => Promise<{ message_id: number; date: number; text?: string }>;
  sendPhoto?: (
    chatId: number,
    photo: string,
    options?: Record<string, unknown>,
  ) => Promise<{ message_id: number; date: number; caption?: string }>;
  sendDocument?: (
    chatId: number,
    document: string,
    options?: Record<string, unknown>,
  ) => Promise<{ message_id: number; date: number; caption?: string }>;
  sendPoll?: (
    chatId: number,
    question: string,
    options: string[],
    other?: Record<string, unknown>,
  ) => Promise<{ message_id: number; date: number }>;
}

interface MessageModelLike {
  saveMessage(doc: Record<string, unknown>): Promise<unknown>;
}

export const parseSendPayload = (value: unknown): SendPayload | null => {
  if (!value || typeof value !== 'object') return null;
  const items = (value as { items?: unknown }).items;
  if (!Array.isArray(items) || items.length === 0) return null;

  const parsedItems = items
    .slice(0, MAX_SEND_ITEMS)
    .map(parseSendItem)
    .filter((item): item is SendItem => item !== null);

  return parsedItems.length > 0 ? { items: parsedItems } : null;
};

const parseSendItem = (value: unknown): SendItem | null => {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const richMarkdown = stringValue(raw.richMarkdown);
  const richHtml = stringValue(raw.richHtml);
  const plainText = stringValue(raw.plainText) ?? richMarkdown ?? richHtml;
  if (!plainText) return null;

  return {
    richMarkdown,
    richHtml,
    plainText,
    replyToMessageId: numberValue(raw.replyToMessageId),
    attachments: parseAttachments(raw.attachments),
    poll: parsePoll(raw.poll),
    delayHintMs: numberValue(raw.delayHintMs),
  };
};

const parseAttachments = (value: unknown): SendAttachment[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const attachments = value
    .map((item): SendAttachment | null => {
      if (!item || typeof item !== 'object') return null;
      const raw = item as Record<string, unknown>;
      const type = raw.type === 'photo' || raw.type === 'document' ? raw.type : null;
      const fileIdOrUrl = stringValue(raw.fileIdOrUrl);
      if (!type || !fileIdOrUrl) return null;
      return {
        type,
        fileIdOrUrl,
        captionRichMarkdown: stringValue(raw.captionRichMarkdown),
        captionPlainText: stringValue(raw.captionPlainText),
      };
    })
    .filter((item): item is SendAttachment => item !== null);

  return attachments.length > 0 ? attachments : undefined;
};

const parsePoll = (value: unknown): SendPollPayload | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const question = stringValue(raw.question);
  const options = Array.isArray(raw.options)
    ? raw.options.filter((option): option is string => typeof option === 'string')
    : [];
  if (!question || options.length < 2) return undefined;

  return {
    question,
    options,
    isAnonymous:
      typeof raw.isAnonymous === 'boolean' ? raw.isAnonymous : undefined,
    allowsMultipleAnswers:
      typeof raw.allowsMultipleAnswers === 'boolean'
        ? raw.allowsMultipleAnswers
        : undefined,
  };
};

const stringValue = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value : undefined;

const numberValue = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

export const calculateHumanDelayMs = (input: {
  textLength: number;
  delayHintMs?: number;
  random?: () => number;
}): number => {
  const random = input.random ?? Math.random;
  const lengthAware =
    450 + Math.min(2_600, Math.floor(Math.max(0, input.textLength - 20) * 7));
  const jitter = Math.floor(random() * 500);
  const hinted = input.delayHintMs ?? 0;
  return Math.max(450, Math.min(4_500, lengthAware + jitter + hinted));
};

export class TelegramRichDeliveryService {
  constructor(
    private readonly api: TelegramApiLike,
    private readonly rawClient: RawTelegramApiClientLike,
    private readonly messageModel: MessageModelLike,
    private readonly botUserTelegramId: number,
    private readonly timing: {
      random?: () => number;
      sleep?: (ms: number) => Promise<void>;
    } = {},
  ) {}

  async send(
    chatTelegramId: number,
    payload: SendPayload,
  ): Promise<{ status: 'ok'; deliveries: DeliveryResult[] }> {
    const deliveries: DeliveryResult[] = [];
    const items = payload.items.slice(0, MAX_SEND_ITEMS);

    if (items.length > 0) {
      await this.api.sendChatAction?.(chatTelegramId, 'typing');
    }

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]!;
      if (index > 0) {
        await this.sleepForItem(item);
      }

      deliveries.push(...(await this.sendItem(chatTelegramId, item)));
    }

    return { status: 'ok', deliveries };
  }

  private async sendItem(
    chatTelegramId: number,
    item: SendItem,
  ): Promise<DeliveryResult[]> {
    if (item.poll) {
      return [await this.sendPoll(chatTelegramId, item)];
    }

    if (item.attachments?.length) {
      const results: DeliveryResult[] = [];
      for (const attachment of item.attachments) {
        results.push(await this.sendAttachment(chatTelegramId, item, attachment));
      }
      return results;
    }

    return [await this.sendText(chatTelegramId, item)];
  }

  private async sendText(
    chatTelegramId: number,
    item: SendItem,
  ): Promise<DeliveryResult> {
    const replyOptions = this.replyOptions(item);
    let fallbackReason: string | undefined;

    if (item.richMarkdown) {
      try {
        const sent = (await this.rawClient.sendRichMessage(
          chatTelegramId,
          item.richMarkdown,
          replyOptions,
        )) as { message_id: number; date: number; text?: string };
        await this.persist(chatTelegramId, item, sent, {
          format: 'rich_markdown',
          finalText: item.richMarkdown,
          contentText: item.richMarkdown,
          messageType: 'text',
        });
        return { telegramId: sent.message_id, format: 'rich_markdown' };
      } catch (error) {
        fallbackReason = `rich_markdown_failed: ${this.errorMessage(error)}`;
      }
    }

    const html = item.richHtml ?? markdownToTelegramHtml(item.richMarkdown ?? item.plainText);
    try {
      const sent = await this.api.sendMessage(chatTelegramId, html, replyOptions);
      await this.persist(chatTelegramId, item, sent, {
        format: 'html',
        finalText: html,
        contentText: item.richMarkdown ?? item.plainText,
        messageType: 'text',
        fallbackReason,
      });
      return {
        telegramId: sent.message_id,
        format: 'html',
        fallbackReason,
      };
    } catch (error) {
      const plainFallbackReason = [
        fallbackReason,
        `html_failed: ${this.errorMessage(error)}`,
      ]
        .filter(Boolean)
        .join('; ');
      const sent = await this.api.sendMessage(
        chatTelegramId,
        item.plainText,
        replyOptions,
      );
      await this.persist(chatTelegramId, item, sent, {
        format: 'plain',
        finalText: item.plainText,
        contentText: item.plainText,
        messageType: 'text',
        fallbackReason: plainFallbackReason,
      });
      return {
        telegramId: sent.message_id,
        format: 'plain',
        fallbackReason: plainFallbackReason,
      };
    }
  }

  private async sendAttachment(
    chatTelegramId: number,
    item: SendItem,
    attachment: SendAttachment,
  ): Promise<DeliveryResult> {
    const caption =
      attachment.captionRichMarkdown ??
      attachment.captionPlainText ??
      item.richMarkdown ??
      item.plainText;
    const htmlCaption = markdownToTelegramHtml(caption).slice(0, 1024);
    const options = {
      ...this.replyOptions(item),
      caption: htmlCaption,
    };

    const sent =
      attachment.type === 'photo'
        ? await this.api.sendPhoto!(chatTelegramId, attachment.fileIdOrUrl, options)
        : await this.api.sendDocument!(
            chatTelegramId,
            attachment.fileIdOrUrl,
            options,
          );
    const format = attachment.type;
    await this.persist(chatTelegramId, item, sent, {
      format,
      finalText: htmlCaption,
      contentText: caption,
      messageType: format,
    });

    return { telegramId: sent.message_id, format };
  }

  private async sendPoll(
    chatTelegramId: number,
    item: SendItem,
  ): Promise<DeliveryResult> {
    const poll = item.poll!;
    const sent = await this.api.sendPoll!(
      chatTelegramId,
      poll.question,
      poll.options,
      {
        ...this.replyOptions(item),
        is_anonymous: poll.isAnonymous,
        allows_multiple_answers: poll.allowsMultipleAnswers,
      },
    );

    await this.persist(chatTelegramId, item, sent, {
      format: 'poll',
      finalText: poll.question,
      contentText: poll.question,
      messageType: 'poll',
    });

    return { telegramId: sent.message_id, format: 'poll' };
  }

  private async persist(
    chatTelegramId: number,
    item: SendItem,
    sent: { message_id: number; date: number },
    delivery: {
      format: DeliveryFormat;
      finalText: string;
      contentText: string;
      messageType: string;
      fallbackReason?: string;
    },
  ): Promise<void> {
    await this.messageModel.saveMessage({
      telegramId: sent.message_id,
      chatTelegramId,
      userTelegramId: this.botUserTelegramId,
      text: delivery.contentText,
      replyToMessageTelegramId: item.replyToMessageId,
      sentAt: new Date(sent.date * 1000),
      messageType: delivery.messageType,
      payload: JSON.parse(JSON.stringify(sent)),
      deliveryFormat: delivery.format,
      deliveryText: delivery.finalText,
      deliveryFallbackReason: delivery.fallbackReason,
    });
  }

  private replyOptions(item: SendItem): Record<string, unknown> {
    return typeof item.replyToMessageId === 'number'
      ? { reply_to_message_id: item.replyToMessageId }
      : {};
  }

  private async sleepForItem(item: SendItem): Promise<void> {
    const delay = calculateHumanDelayMs({
      textLength: (item.richMarkdown ?? item.plainText).length,
      delayHintMs: item.delayHintMs,
      random: this.timing.random,
    });

    await (this.timing.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(
      delay,
    );
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
