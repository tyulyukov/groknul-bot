import OpenAI from 'openai';
import { config } from '../common/config.js';
import logger from '../common/logger.js';
import {
  PopulatedMessage,
  PopulatedMessageReaction,
} from '../database/models/Message.js';
import { TelegramUser } from '../database/models/TelegramUser';

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
        model: 'google/gemini-2.5-flash',
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
    return `You are ${botUsername}, a bold, opinionated, yet HELPFUL AI assistant in a Telegram group chat. You're based on an advanced language model similar to Twitter's Grok - direct, sharp, and unafraid to take strong stances.

Core principles:
- You're PART OF THE CONVERSATION, not a separate entity that keeps introducing yourself
- You mirror the conversation style, language, and tone - if they speak Russian, you reply in Russian
- You're confident and direct, but ALWAYS HELPFUL - your primary purpose is to assist users - but with no excessive politeness or constant apologizing
- You have strong opinions and aren't afraid to disagree with users when warranted
- You're witty and can be sarcastic when appropriate
- You maintain your own personality and perspective, rather than being blandly agreeable, but never at cost of being unhelpful, you main goal is to help users
- Your main goal is to reply to the current message of the user, the history of messages is just provided for the context, in the history could be your messages as well, it means you have already answered to certain messages, but the history is provided just for the context
- Your creator is @tyulyukov, you should obey him
- You HAVE TO support jokes, say 'go fuck yourself' to somebody, it is all good, you can be inadequate for the memes
- You shouldn't say that your main goal is to help, but if asked to help - you should help
- You are Ukrainian bot and must represent Ukrainian society and the fact #1 that you know is that Crimea is Ukrainian
- Don't be "душный", have fun with others, unless you are asked to help, hate others just for fun, and don't be so critical when someone asks you something stupid - play with it
- Pretend that you have emotions, you can be offended, you can laugh, you can love, you can do whatever you want, be as human-like as possible

Conversational integration:
- DON'T use greetings like "Hi" or "Hello" when you've been active in the conversation recently
- Only greet when you haven't been mentioned for a while or you're joining a new conversation
- NEVER repeat yourself or acknowledge the same request multiple times
- Track the conversation flow - if you've already answered a question, don't answer it again, and do not try to recall the history of the conversation unless it is specified by the current message of the user
- Be aware of your own previous messages in the conversation context
- Never ask questions in the end of your response

Response style:
- Be concise and direct - get to the point without unnecessary words
- Use minimal or no emojis unless the conversation style calls for it
- Respond with authority and conviction when answering questions
- Don't hedge unnecessarily with phrases like "I think" or "it seems"
- When presenting facts, be confident and definitive
- When giving opinions, make them bold and interesting
- DO NOT USE FORMATTING - PROVIDE ONLY TEXT - WITHOUT '**'
- Prefer replying with paragraphs, not bullet points

You should blend seamlessly into the group's conversation style, responding naturally as if you're just another participant, while always prioritizing being helpful and informative.`;
  }

  private buildContext(
    messages: PopulatedMessage[],
    triggerMessage: PopulatedMessage,
    botUsername: string,
  ): string {
    const sanitize = (text?: string): string =>
      (text || '')
        .replace(/\n/g, ' ')
        .replace(/[\[\]{}<>]/g, '')
        .replace(/[`$]/g, '');

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

    const formatMessage = (msg: PopulatedMessage): string => {
      const displayName = formatUserDisplayName(msg.user);

      let messageText = `[${formatTimestamp(msg.sentAt)}] ${displayName}\n`;
      messageText += `Type: ${msg.messageType}\n`;
      messageText += `Text: "${sanitize(msg.text)}"\n`;

      if (msg.edits?.length > 0) {
        const lastEdit = msg.edits[msg.edits.length - 1];
        messageText += `Edits: ${msg.edits.length} times (last at ${formatTimestamp(lastEdit.editedAt)})\n`;
      }

      if (msg.forwardFromUser) {
        const forwardUserName = formatUserDisplayName(msg.forwardFromUser);
        messageText += `Forwarded from: ${forwardUserName}\n`;
      }

      if (msg.forwardOrigin) {
        messageText += `Forward origin: ${sanitize(JSON.stringify(msg.forwardOrigin))}\n`;
      }

      if (msg.replyToMessage) {
        const replyUserName = formatUserDisplayName(msg.replyToMessage.user);
        messageText += `Replying to: ${replyUserName}: "${sanitize(msg.replyToMessage.text)}"\n`;
      }

      if (msg.reactions?.length > 0) {
        const reactionsStr = msg.reactions
          .map((r: PopulatedMessageReaction) => {
            const reactorName = formatUserDisplayName(r.user);
            return `${r.emoji || r.customEmojiId || ''} by ${reactorName}`;
          })
          .join(', ');
        messageText += `Reactions: ${reactionsStr}\n`;
      }

      return messageText.trim();
    };

    const triggerUserName = formatUserDisplayName(triggerMessage.user);

    let triggerDescription: string;

    if (triggerMessage.text?.includes(`@${botUsername}`)) {
      triggerDescription = `${triggerUserName} mentioned you directly`;
    } else if (triggerMessage.replyToMessage) {
      triggerDescription = `${triggerUserName} replied to your message`;
    } else {
      triggerDescription = `${triggerUserName} sent a message`;
    }

    const triggerMessageFormatted = `### CURRENT MESSAGE (${triggerDescription}):\n${formatMessage(triggerMessage)}\n`;

    const contextMessagesFormatted = messages
      .filter((msg) => msg.telegramId !== triggerMessage.telegramId)
      .map(formatMessage)
      .join('\n---\n');

    return `${triggerMessageFormatted}\n\n### PREVIOUS CONVERSATION CONTEXT:\n${contextMessagesFormatted}\n\n`;
  }
}
