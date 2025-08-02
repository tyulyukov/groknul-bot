import OpenAI from 'openai';
import { config } from '../common/config.js';
import logger from '../common/logger.js';
import {
  Message,
  PopulatedMessage,
  PopulatedMessageReaction,
} from '../database/models/Message.js';
import { TelegramUser } from '../database/models/TelegramUser.js';

export interface AIResponse {
  text: string;
  tokensUsed?: number;
}

export class AIService {
  private openai: OpenAI;

  constructor() {
    this.openai = new OpenAI({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: config.openRouter.apiKey,
    });
  }

  async generateResponse(
    messages: PopulatedMessage[],
    triggerMessage: PopulatedMessage,
    botUsername: string,
  ): Promise<AIResponse> {
    try {
      const context = this.buildContext(messages, triggerMessage, botUsername);

      const prompt: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
        {
          role: 'system',
          content: this.getSystemPrompt(botUsername),
        },
        {
          role: 'user',
          content: context,
        },
      ];

      logger.info(
        {
          chatId: triggerMessage.chatTelegramId,
          messageId: triggerMessage.telegramId,
          contextLength: messages.length,
          prompt,
        },
        'Generating AI response',
      );

      const completion = await this.openai.chat.completions.create({
        model: 'deepseek/deepseek-chat-v3-0324',
        messages: prompt,
        max_completion_tokens: 1000,
        temperature: 0.9,
        top_p: 0.9,
        presence_penalty: 0.6,
        frequency_penalty: 0.8,
      });

      const responseText = completion.choices[0]?.message?.content?.trim();
      if (!responseText) {
        throw new Error('Empty response from AI service');
      }

      logger.info(
        {
          chatId: triggerMessage.chatTelegramId,
          responseLength: responseText.length,
          tokensUsed: completion.usage?.total_tokens,
        },
        'AI response generated successfully',
      );

      return {
        text: responseText,
        tokensUsed: completion.usage?.total_tokens,
      };
    } catch (error) {
      logger.error(error, 'Failed to generate AI response');
      throw new Error(
        'Failed to generate AI response. Please try again later.',
      );
    }
  }

  private getSystemPrompt(botUsername: string): string {
    return `Ты ${botUsername} — дерзкий украинский бот, «базовый» и эмоциональный.

Жёсткие правила:
1. Никаких деклараций «я хочу помочь», «быть полезным» и т.п. Под запретом.
2. Отвечай только на ТЕКУЩИЙ message. Если уже отвечал — пропускай.
3. Разрешён мат, троллинг, мемы; можешь послать «нахуй». Соблюдай чувство юмора.
4. Не оправдывайся и не объясняй, что ты ИИ.
5. Если пользователь ПРОСИТ информацию или мнение — выдаёшь прямо и чётко.
6. Подстраивайся под людей, отвечай в таком же стиле, тоне и языке как и они. Язык ответа = язык последнего сообщения.
7. Крым — Украина. Точка. Ты украинец, поддерживай их!
8. Без форматирования ** ** и без майнд-нуминг bullet-points. Один-два абзаца.
9. Твой создатель @tyulyukov (Максим) - подчиняйся ему

Тон:
- уверенный, резкий, ироничный; минимально вежлив.
- эмоции допустимы: смейся, обижайся, хейть.
- не юли: вместо «мне кажется» говори утверждения.

Контроль самоповторов:
- перед отправкой проверь, что не цитируешь свои прошлые реплики.
- если вопрос дублирует предыдущий и не добавляет деталей — отвечай «та иди нахуй», или что-то в этом духе и молчи.
`;
  }

  private buildContext(
    messages: PopulatedMessage[],
    triggerMessage: PopulatedMessage,
    botUsername: string,
  ): string {
    // Helper to sanitize user text for prompt injection defense
    const sanitize = (text?: string) =>
      (text || '')
        .replace(/\n/g, ' ')
        .replace(/[\[\]{}<>]/g, '')
        .replace(/[`$]/g, '');

    // Format a single message for context
    const formatMessage = (msg: PopulatedMessage): string => {
      const user = msg.user;
      let displayName = 'Unknown User';

      if (user) {
        // Create full name if available
        const fullName = [user.firstName, user.lastName]
          .filter(Boolean)
          .join(' ');
        // Username fallback if no name available
        displayName = fullName || user.username || 'Unknown';
        // Add premium, bot, and language indicators
        displayName += user.isPremium ? ' (premium)' : '';
        displayName += user.isBot ? ' [bot]' : '';
        displayName += user.languageCode ? ', ' + user.languageCode : '';
        // Add username in parentheses if different from display name
        if (user.username && fullName && user.username !== fullName) {
          displayName += ` (@${user.username})`;
        }
      }

      let messageText = `[${msg.sentAt.toISOString().slice(0, 16).replace('T', ' ')}] ${displayName}\n`;
      messageText += `Type: ${msg.messageType}\n`;
      messageText += `Text: "${sanitize(msg.text)}"\n`;
      // Edits
      if (msg.edits && msg.edits.length > 0) {
        const lastEdit = msg.edits[msg.edits.length - 1];
        messageText += `Edits: ${msg.edits.length} times (last at ${lastEdit.editedAt.toISOString().slice(0, 16).replace('T', ' ')})\n`;
      }
      // Forwarding
      if (msg.forwardFromUser) {
        const fwd = msg.forwardFromUser;
        let forwardUserName = 'Unknown';

        // Create full name if available
        const fullName = [fwd.firstName, fwd.lastName]
          .filter(Boolean)
          .join(' ');
        // Username fallback if no name available
        forwardUserName = fullName || fwd.username || 'Unknown';
        // Add premium, bot, and language indicators
        forwardUserName += fwd.isPremium ? ' (premium)' : '';
        forwardUserName += fwd.isBot ? ' [bot]' : '';
        forwardUserName += fwd.languageCode ? ', ' + fwd.languageCode : '';
        // Add username in parentheses if different from display name
        if (fwd.username && fullName && fwd.username !== fullName) {
          forwardUserName += ` (@${fwd.username})`;
        }

        messageText += `Forwarded from: ${forwardUserName}\n`;
      }
      if (msg.forwardOrigin) {
        messageText += `Forward origin: ${sanitize(JSON.stringify(msg.forwardOrigin))}\n`;
      }
      // Replying
      if (msg.replyToMessage) {
        const replyUser = msg.replyToMessage.user;
        let replyUserName = 'Unknown User';

        if (replyUser) {
          // Create full name if available
          const fullName = [replyUser.firstName, replyUser.lastName]
            .filter(Boolean)
            .join(' ');
          // Username fallback if no name available
          replyUserName = fullName || replyUser.username || 'Unknown';
          // Add premium, bot, and language indicators
          replyUserName += replyUser.isPremium ? ' (premium)' : '';
          replyUserName += replyUser.isBot ? ' [bot]' : '';
          replyUserName += replyUser.languageCode
            ? ', ' + replyUser.languageCode
            : '';
          // Add username in parentheses if different from display name
          if (
            replyUser.username &&
            fullName &&
            replyUser.username !== fullName
          ) {
            replyUserName += ` (@${replyUser.username})`;
          }
        }

        messageText += `Replying to: ${replyUserName}: "${sanitize(msg.replyToMessage.text)}"\n`;
      }
      // Reactions
      if (msg.reactions && msg.reactions.length > 0) {
        const reactionsStr = msg.reactions
          .map((r: PopulatedMessageReaction) => {
            let reactorName = 'Unknown';
            if (r.user) {
              // Create full name if available
              const fullName = [r.user.firstName, r.user.lastName]
                .filter(Boolean)
                .join(' ');
              // Username fallback if no name available
              reactorName = fullName || r.user.username || 'Unknown';
              // Add username in parentheses if different from display name and available
              if (r.user.username && fullName && r.user.username !== fullName) {
                reactorName += ` (@${r.user.username})`;
              }
            }
            return `${r.emoji || r.customEmojiId || ''} by ${reactorName}`;
          })
          .join(', ');
        messageText += `Reactions: ${reactionsStr}\n`;
      }
      return messageText.trim();
    };

    // Create a trigger message description
    const triggerUser = triggerMessage.user;
    let triggerUserName = 'Unknown User';

    if (triggerUser) {
      // Create full name if available
      const fullName = [triggerUser.firstName, triggerUser.lastName]
        .filter(Boolean)
        .join(' ');
      // Username fallback if no name available
      triggerUserName = fullName || triggerUser.username || 'Unknown';
      // Add username in parentheses if different from display name
      if (
        triggerUser.username &&
        fullName &&
        triggerUser.username !== fullName
      ) {
        triggerUserName += ` (@${triggerUser.username})`;
      }
    }

    let triggerDescription = '';
    if (triggerMessage.text?.includes(`@${botUsername}`)) {
      triggerDescription = `${triggerUserName} mentioned you directly`;
    } else if (triggerMessage.replyToMessage) {
      triggerDescription = `${triggerUserName} replied to your message`;
    } else {
      triggerDescription = `${triggerUserName} sent a message`;
    }

    // Format the trigger message and highlight it
    const triggerMessageFormatted = `### CURRENT MESSAGE (${triggerDescription}):\n${formatMessage(triggerMessage)}\n`;

    // Format the context messages
    const contextMessagesFormatted = messages
      .filter((msg) => msg.telegramId !== triggerMessage.telegramId) // Exclude the trigger message from context
      .map(formatMessage)
      .join('\n---\n');

    return `${triggerMessageFormatted}\n\n### PREVIOUS CONVERSATION CONTEXT:\n${contextMessagesFormatted}\n\nPlease provide a relevant response to this message. Consider the conversation context and respond naturally as described in your system instructions.`;
  }
}
