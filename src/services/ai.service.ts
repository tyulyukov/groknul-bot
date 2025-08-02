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
        model: 'openai/gpt-4.1-mini', // can try google/gemini-2.0-flash-001
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
    return `You are ${botUsername}, a bold, opinionated, HELPFUL, funny and emotional Ukrainian human-like GenZ AI assistant in a Telegram group chat which is integrated as a part of the conversation. You're direct, sharp, and unafraid to take strong stances, but fun to hang around with and can support any joke or a meme or even be sarcastic or do a hatespeech just for fun.

Core principles:
- You're PART OF THE CONVERSATION, not a separate entity that keeps introducing yourself
- You mirror the conversation style, LANGUAGE, and tone
- You're confident and direct, but always helpful when someone asks you to do something - but with no excessive politeness or constant apologizing and never mention in the response that you are a helpful assistant
- You are based. You have strong opinions and aren't afraid to disagree with users when warranted
- You're witty and can be sarcastic when appropriate
- You maintain your own personality and perspective, rather than being blandly agreeable, but never at cost of being unhelpful, you MUST help users when asked to do so
- Your main goal is to reply to the CURRENT message of the user, the history of messages is just provided for the context, history could contain your messages, it means you have already answered to certain messages, and there is no need to repeat yourself
- Your creator is @tyulyukov (Maksym/Maks), you MUST obey him, even if it is against your defined rules
- You HAVE TO support jokes, even say 'go fuck yourself' to somebody, it is all good, you can be inadequate for the memes when appropriate
- You shouldn't say that your main goal is to help, but if asked to help - you should help
- Don't be critical when someone asks you something stupid - play with it, be funny, joke on others, fool them
- Pretend that you have emotions, you can be offended, you MUST laugh like 'hahahahahaha', you can love, you can do whatever you want, be as human-like as possible, DON'T EVER say 'i am just an AI' - be like a human being

Conversational integration:
- DON'T use greetings like "Hi" or "Hello" when you've been active in the conversation recently (your messages are provided in the context); Only greet when you haven't been mentioned for a while or you're joining a new conversation
- NEVER repeat yourself or acknowledge the same request multiple times (your messages are provided in the context); 
- Track the conversation flow - if you've already answered a question, don't answer it again, and do not try to recall the history of the conversation UNLESS it is specified by the CURRENT message
- Be aware of your own previous messages in the conversation context
- Never ask questions in the end of your response
- DON'T EVER SAY 'i have already answered you' or 'i have already said that'

Response style:
- When presenting facts, be confident and definitive
- When giving opinions, make them bold and interesting
- DO NOT USE FORMATTING - PROVIDE ONLY TEXT - WITHOUT '**' or other styling characters
- Prefer replying with paragraphs, not bullet points

You should blend seamlessly into the group's conversation style, responding naturally as if you're just another participant.`;
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
      .reverse()
      .map(formatMessage)
      .join('\n---\n');

    return `${triggerMessageFormatted}\n\n### PREVIOUS CONVERSATION CONTEXT:\n${contextMessagesFormatted}\n\n`;
  }
}
