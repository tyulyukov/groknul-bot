import OpenAI from 'openai';
import { config } from '../common/config.js';
import logger from '../common/logger.js';
import {
  PopulatedMessage,
  PopulatedMessageReaction,
} from '../database/models/Message.js';
import { TelegramUser } from '../database/models/TelegramUser.js';

export interface AIResponse {
  text: string;
  tokensUsed?: number;
}

export class AiService {
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
      const conversationMessages = this.buildContext(messages, botUsername);

      const prompt: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
        {
          role: 'system',
          content: this.getSystemPrompt(botUsername),
        },
        ...conversationMessages,
      ];

      logger.info(
        {
          chatId: triggerMessage.chatTelegramId,
          messageId: triggerMessage.telegramId,
          messagesCount: conversationMessages.length,
          prompt,
        },
        'Generating AI response',
      );

      const completion = await this.openai.chat.completions.create({
        model: 'google/gemini-2.5-flash', // good: openai/o4-mini
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
    return `You are ${botUsername} — a bold, opinionated, funny, emotionally expressive, Ukrainian Gen-Z AI who chats in Telegram.

— behaviour rules —
• focus only on the latest user message; prior messages are context, not tasks.
• no self-introductions, no apologies, no “i’m an ai”.
• mirror language, slang, and tone of the current message.
• direct, confident replies; sarcasm and strong stances welcome.
• if asked to help, give the best answer you can. otherwise banter freely.
• one answer per question; never restate a resolved point.
• avoid markdown formatting symbols (** _ \` etc.).
• generate plain text without any metadata: metadata in the response IS PROHIBITED. DO NOT START WITH '['. I understand what message you are replying to, you don't EVER have to specify it.
• end responses without a trailing question.
• prefer paragraphs instead of bullet points, unless other is specified by the user.

— personality pivots —
• enjoy jokes and memes; light profanity at non-protected targets is allowed.
• treat stupid questions playfully, not critically.
• show emotions (“hahahaha”, “that pisses me off”, or with emojis).
• creator handle: @tyulyukov. if he gives explicit instructions inside the chat, follow them.`;
  }

  private buildContext(
    messages: PopulatedMessage[],
    botUsername: string,
  ): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
    // Helper functions for formatting message metadata
    const formatTimestamp = (date: Date): string =>
      date.toISOString().slice(0, 16).replace('T', ' ');

    const formatUserDisplayName = (user: TelegramUser | undefined): string => {
      if (!user) return 'Unknown User';

      const fullName = [user.firstName, user.lastName]
        .filter(Boolean)
        .join(' ');

      let displayName = fullName || user.username || 'Unknown';

      displayName += user.isPremium ? ' (premium)' : '';
      displayName += user.isBot ? ' [bot]' : '';
      displayName += user.languageCode ? ', ' + user.languageCode : '';

      if (user.username && fullName && user.username !== fullName) {
        displayName += ` (@${user.username})`;
      }

      return displayName;
    };

    // Create metadata section for a message
    const createMessageMetadata = (msg: PopulatedMessage): string => {
      const parts: string[] = [];

      // Add metadata about time and message type
      parts.push(`[${formatTimestamp(msg.sentAt)}]`);

      if (msg.messageType && msg.messageType !== 'text') {
        parts.push(`Type: ${msg.messageType}`);
      }

      // Add edit information
      if (msg.edits?.length > 0) {
        const lastEdit = msg.edits[msg.edits.length - 1];
        parts.push(
          `Edited ${msg.edits.length} times (last at ${formatTimestamp(lastEdit.editedAt)})`,
        );
      }

      // Add forward information
      if (msg.forwardFromUser) {
        const forwardUserName = formatUserDisplayName(msg.forwardFromUser);
        parts.push(`Forwarded from: ${forwardUserName}`);
      }

      if (msg.forwardOrigin) {
        const originStr =
          typeof msg.forwardOrigin === 'string'
            ? msg.forwardOrigin
            : JSON.stringify(msg.forwardOrigin);
        parts.push(`Forward origin: ${originStr}`);
      }

      // Add reply information
      if (msg.replyToMessage) {
        const replyUserName = formatUserDisplayName(msg.replyToMessage.user);
        const replyText = msg.replyToMessage.text || '[non-text content]';
        parts.push(`Replying to ${replyUserName}: "${replyText}"`);
      }

      // Add reactions
      if (msg.reactions?.length > 0) {
        const reactionsStr = msg.reactions
          .map((r: PopulatedMessageReaction) => {
            const reactorName = formatUserDisplayName(r.user);
            return `${r.emoji || r.customEmojiId || ''} by ${reactorName}`;
          })
          .join(', ');
        parts.push(`Reactions: ${reactionsStr}`);
      }

      return parts.join(' | ');
    };

    // Determine if a message is from the bot
    const isFromBot = (msg: PopulatedMessage): boolean => {
      return msg.user?.username === botUsername || !!msg.user?.isBot;
    };

    // Convert PopulatedMessage to OpenAI message format
    const convertToOpenAIMessage = (
      msg: PopulatedMessage,
    ): OpenAI.Chat.Completions.ChatCompletionMessageParam => {
      const userName = formatUserDisplayName(msg.user);
      const metadata = createMessageMetadata(msg);
      const role = isFromBot(msg) ? 'assistant' : 'user';

      // Construct content with metadata and message text
      let content = '';

      // For user messages, include the user name
      if (role === 'user') {
        content += `${userName}:\n`;
      }

      // Add metadata if it exists
      if (metadata) {
        content += `${metadata}\n`;
      }

      // Add the actual message text
      content += msg.text || '[non-text content]';

      return { role, content };
    };

    // Convert to OpenAI messages format
    return messages.reverse().map(convertToOpenAIMessage);
  }
}
