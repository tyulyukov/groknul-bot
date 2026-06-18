import OpenAI from 'openai';
import { config } from '../common/config.js';
import logger from '../common/logger.js';
import {
  PopulatedMessage,
  PopulatedMessageReaction,
} from '../database/models/Message.js';
import { TelegramUser } from '../database/models/TelegramUser.js';
import { AiClient } from './ai-client.service.js';

export class AiService {
  constructor(private readonly aiClient = new AiClient()) {}

  async summarizeText(blocks: string[], instruction: string): Promise<string> {
    const content = blocks.join('\n\n');

    logger.info(
      {
        blocksCount: blocks.length,
        instructionPreview: instruction.slice(0, 120),
        contentLength: content.length,
      },
      'Starting text summarization',
    );

    const completion = await this.aiClient.completeRaw({
      model: config.openRouter.models.summary,
      // @ts-expect-error OpenRouter pass-through for disabling reasoning
      reasoning: { effort: 'low' },
      messages: [
        {
          role: 'system',
          content:
            'You are a professional summarizer. Summarize inputs into concise, neutral, information-dense notes. Keep key facts, actors, decisions, questions, answers, tasks, and resolutions. Remove chit-chat and filler. Prefer paragraphs over bullets unless events are disjoint. Preserve chronology labels provided.',
        },
        { role: 'user', content: `${instruction}\n\n${content}` },
      ],
      temperature: 0.2,
      max_completion_tokens: 800,
      top_p: 0.9,
    });
    const summary = completion.choices[0]?.message?.content?.trim() || '';

    logger.info(
      {
        summaryLength: summary.length,
        tokensUsed: completion.usage?.total_tokens,
      },
      'Text summarization completed',
    );

    return summary;
  }

  async analyzeImage(imageBase64DataUrl: string): Promise<string> {
    try {
      logger.info(
        { contentTypePrefix: imageBase64DataUrl.slice(0, 30) },
        'Starting image summarization',
      );

      const completion = await this.aiClient.completeRaw({
        model: config.openRouter.models.vision,
        // @ts-expect-error OpenRouter pass-through for disabling reasoning
        reasoning: { effort: 'low' },
        messages: [
          {
            role: 'system',
            content:
              'Provide a full, detailed description of the image. Describe the overall scene, key objects, their attributes, spatial relationships, actions, interactions, environment, layout, lighting, mood, style, logos, UI elements, and relevant chat context. Transcribe clearly visible text verbatim. Be precise and avoid speculation.',
          },
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: imageBase64DataUrl } },
            ],
          },
        ],
        temperature: 0.2,
        max_completion_tokens: 1500,
        top_p: 0.9,
      });

      const summary = completion.choices[0]?.message?.content?.trim();
      logger.info(
        {
          summaryLength: summary?.length || 0,
          tokensUsed: completion.usage?.total_tokens,
        },
        'Image summarization completed',
      );

      return summary || '';
    } catch (error) {
      logger.error(error, 'Image analysis failed');
      return '';
    }
  }

  async generateAmbientInterjection(
    messages: PopulatedMessage[],
    botUsername: string,
  ): Promise<string | null> {
    try {
      logger.info(
        {
          messagesCount: messages.length,
          firstAt: messages[messages.length - 1]?.sentAt,
          lastAt: messages[0]?.sentAt,
          model: config.openRouter.models.reply,
        },
        'Ambient: starting interjection generation',
      );

      const contextMessages = this.buildContext(
        messages.slice(0, 60),
        botUsername,
      );
      const systemPrompt =
        'You are an undercover participant in a casual Telegram group chat. Interject ONLY if you add clear value: a sharp clarification, missing fact, witty one-liner that matches the vibe, or a concise synthesis that moves the convo. If nothing solid to add, reply with EXACTLY "NOOP". Keep it short, natural, no meta, no over-explaining, mirror language and tone. Never ask a question to end.';

      const completion = await this.aiClient.completeRaw({
        model: config.openRouter.models.reply,
        messages: [
          { role: 'system', content: systemPrompt },
          ...contextMessages,
          { role: 'system', content: 'If unsure, output exactly NOOP.' },
        ],
        max_completion_tokens: 220,
        temperature: 1.0,
        presence_penalty: 0.4,
        frequency_penalty: 0.6,
      });

      const text = completion.choices[0]?.message?.content?.trim() || '';
      if (!text || /^NOOP$/i.test(text) || text.length < 3) {
        logger.info('Ambient: model abstained');
        return null;
      }

      logger.info(
        { responseLength: text.length },
        'Ambient: interjection generated',
      );
      return text;
    } catch (error) {
      logger.error(error, 'Failed to generate ambient interjection');
      return null;
    }
  }

  private buildContext(
    messages: PopulatedMessage[],
    botUsername: string,
  ): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
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

    const createMessageMetadata = (msg: PopulatedMessage): string => {
      const parts: string[] = [];
      parts.push(`[${formatTimestamp(msg.sentAt)}]`);

      if (msg.messageType && msg.messageType !== 'text') {
        parts.push(`Type: ${msg.messageType}`);
      }

      if (msg.fileName) parts.push(`File: ${msg.fileName}`);

      if (msg.edits?.length > 0) {
        const lastEdit = msg.edits[msg.edits.length - 1];
        parts.push(
          `Edited ${msg.edits.length} times (last at ${formatTimestamp(lastEdit.editedAt)})`,
        );
      }

      if (msg.replyToMessage) {
        const replyUserName = formatUserDisplayName(msg.replyToMessage.user);
        const replyFullText = msg.replyToMessage.text || '[non-text content]';
        parts.push(`Replying to ${replyUserName}: "${replyFullText}"`);
        if (msg.replyQuoteText?.trim()) {
          parts.push(`Quote: "${msg.replyQuoteText.trim()}"`);
        }
      }

      if (msg.reactions?.length > 0) {
        const reactionsStr = msg.reactions
          .map((reaction: PopulatedMessageReaction) => {
            const reactorName = formatUserDisplayName(reaction.user);
            return `${reaction.emoji || reaction.customEmojiId || ''} by ${reactorName}`;
          })
          .join(', ');
        parts.push(`Reactions: ${reactionsStr}`);
      }

      return parts.join(' | ');
    };

    const isFromBot = (msg: PopulatedMessage): boolean =>
      msg.user?.username === botUsername || !!msg.user?.isBot;

    const convertToOpenAIMessage = (
      msg: PopulatedMessage,
    ): OpenAI.Chat.Completions.ChatCompletionMessageParam => {
      const userName = formatUserDisplayName(msg.user);
      const metadata = createMessageMetadata(msg);
      const role = isFromBot(msg) ? 'assistant' : 'user';
      let content = '';

      if (role === 'user') content += `${userName}:\n`;
      if (metadata) content += `${metadata}\n`;
      content += msg.text || '[non-text content]';

      if (msg.context?.trim()) {
        content += `\nContext: ${msg.context.trim()}`;
      }

      return { role, content };
    };

    const chronologicalBase = [...messages].reverse().map(convertToOpenAIMessage);

    return chronologicalBase.map((message, idx) => {
      const labelNumber = chronologicalBase.length - idx;
      const content = typeof message.content === 'string' ? message.content : '';
      return { ...message, content: `${labelNumber}:\n${content}` };
    });
  }
}
