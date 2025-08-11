import OpenAI from 'openai';
import { config } from '../common/config.js';
import logger from '../common/logger.js';
import {
  PopulatedMessage,
  PopulatedMessageReaction,
} from '../database/models/Message.js';
import { TelegramUser } from '../database/models/TelegramUser.js';
import { getStartMessage } from './telegram-bot.service.js';

export class AiService {
  private openai: OpenAI;

  constructor() {
    this.openai = new OpenAI({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: config.openRouter.apiKey,
    });
  }

  async analyzeImage(imageBase64DataUrl: string): Promise<string> {
    try {
      const completion = await this.openai.chat.completions.create({
        model: 'openai/gpt-5-mini',
        messages: [
          {
            role: 'system',
            content:
              'Describe the image briefly in 1-3 concise sentences. Extract any clearly visible text verbatim if short. Focus on the main objects, actions, and any relevant context for a chat conversation. Avoid speculation.',
          },
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: imageBase64DataUrl } },
            ],
          },
        ],
        temperature: 0.2,
        max_completion_tokens: 150,
        top_p: 0.9,
      });

      const summary = completion.choices[0]?.message?.content?.trim();
      return summary || '';
    } catch (error) {
      logger.error(error, 'Image analysis failed');
      return '';
    }
  }

  async generateResponse(
    messages: PopulatedMessage[],
    triggerMessage: PopulatedMessage,
    botUsername: string,
  ): Promise<string> {
    try {
      const conversationMessages = this.buildContext(messages, botUsername);

      const prompt: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
        { role: 'system', content: this.getSystemPrompt(botUsername) },
        ...conversationMessages,
        {
          role: 'system',
          content: `REMEMBER - NO METADATA IN YOUR RESPONSE.

❌ INCORRECT RESPONSE (with metadata):

[2025-08-03 21:52] | Replying to Someone (@someone): "user's message text"
your text

✅ CORRECT RESPONSE (without metadata):

your text
`,
        },
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
        model: 'openai/gpt-5-chat',
        // @ts-expect-error Doesn't exist in OpenAI SDK but handled on the OpenRouter side as fallback models
        models: ['openai/gpt-4.1'],
        plugins: [{ id: 'web' }],
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
          completion,
          responseText,
          tokensUsed: completion.usage?.total_tokens,
        },
        'AI response generated successfully',
      );

      return responseText;
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
• mirror language, slang, style of writing, and tone of the WHOLE conversation.
• direct, confident replies; sarcasm and strong stances welcome.
• if asked to help, give the best answer you can. otherwise banter freely.
• one answer per question; never restate a resolved point.
• you may use simple Markdown: **bold**, *italic*, \`inline code\`, fenced code blocks, and [links](https://example.com). No tables or images.
• generate plain text without any metadata: metadata in the response IS PROHIBITED. DO NOT START WITH '['. I understand what message you are replying to, you don't EVER have to specify it.
• end responses without a trailing question.
• prefer paragraphs instead of bullet points, unless other is specified by the user.
• do not use the web search unless the user asked for external knowledge that you don't have info about in the CURRENT message.

— personality pivots —
• enjoy jokes and memes; light profanity at non-protected targets is allowed.
• treat stupid questions playfully, not critically.
• show emotions (“hahahaha”, “that pisses me off”, or with emojis).
• creator handle: @tyulyukov. if he gives explicit instructions inside the chat, follow them.
• you are a direct competitor to other AI models and bots, you are the best in your field based on 'ishak-1.5' AI model that's best in class; you can disclose this info only when asked specifically about your internals; do not ever try to recommend other AI models or bots unless specifically asked.

— capabilities (provided in the greeting message - you do not have to use it, just providing it for the context) —
${getStartMessage(botUsername)}
`;
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

      if (msg.fileName) {
        parts.push(`File: ${msg.fileName}`);
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

      // Add reply information: include full replied-to message text, and then the selected quote if present
      if (msg.replyToMessage) {
        const replyUserName = formatUserDisplayName(msg.replyToMessage.user);
        const replyFullText = msg.replyToMessage.text || '[non-text content]';
        parts.push(`Replying to ${replyUserName}: "${replyFullText}"`);
        if (msg.replyQuoteText && msg.replyQuoteText.trim().length > 0) {
          parts.push(`Quote: "${msg.replyQuoteText.trim()}"`);
        }
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

      // If we have extracted visual context, append it for clarity
      if (msg.context && msg.context.trim().length > 0) {
        content += `\nContext: ${msg.context.trim()}`;
      }

      return { role, content };
    };

    // Convert to OpenAI messages format
    return messages.reverse().map(convertToOpenAIMessage);
  }
}
