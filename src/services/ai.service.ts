import OpenAI from 'openai';
import { config } from '../common/config.js';
import logger from '../common/logger.js';
import {
  PopulatedMessage,
  PopulatedMessageReaction,
} from '../database/models/Message.js';
import { TelegramUser } from '../database/models/TelegramUser.js';
import {
  AiClient,
  type GeneratedImage,
  type ImageAspectRatio,
} from './ai-client.service.js';

export interface GenerateImageServiceInput {
  prompt: string;
  aspectRatio?: ImageAspectRatio;
}

export interface AmbientMemeIdea {
  prompt: string;
  caption: string;
}

export const parseAmbientMemeIdea = (raw: string): AmbientMemeIdea | null => {
  const text = raw.trim();
  if (!text || /^NOOP$/i.test(text)) return null;

  const fencedJson = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const json = (fencedJson?.[1] ?? text).trim();

  try {
    const parsed = JSON.parse(json) as Partial<AmbientMemeIdea>;
    const prompt =
      typeof parsed.prompt === 'string' ? parsed.prompt.trim() : '';
    const caption =
      typeof parsed.caption === 'string' ? parsed.caption.trim() : '';

    if (!prompt || !caption) return null;

    return {
      prompt: prompt.slice(0, 1_000),
      caption: caption.slice(0, 180),
    };
  } catch {
    return null;
  }
};

export class AiService {
  constructor(private readonly aiClient = new AiClient()) {}

  async generateImage(
    input: GenerateImageServiceInput,
  ): Promise<GeneratedImage | null> {
    try {
      return await this.aiClient.generateImage({
        model: config.openRouter.models.image,
        prompt: input.prompt,
        aspectRatio: input.aspectRatio,
        imageSize: '1K',
      });
    } catch (error) {
      logger.error(error, 'Image generation failed');
      return null;
    }
  }

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

  async analyzeImages(
    imageBase64DataUrls: string[],
    prompt: string,
  ): Promise<string> {
    try {
      logger.info(
        {
          imagesCount: imageBase64DataUrls.length,
          contentTypePrefix: imageBase64DataUrls[0]?.slice(0, 30),
        },
        'Starting image summarization',
      );

      const userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
        { type: 'text', text: prompt },
        ...imageBase64DataUrls.map((url) => ({
          type: 'image_url' as const,
          image_url: { url },
        })),
      ];

      const completion = await this.aiClient.completeRaw({
        model: config.openRouter.models.vision,
        // @ts-expect-error OpenRouter pass-through for disabling reasoning
        reasoning: { effort: 'low' },
        messages: [
          {
            role: 'system',
            content:
              'You analyze Telegram media for chat context. Be precise, concise, visually grounded, and useful for a later conversational reply. Transcribe visible text verbatim when readable. Avoid speculation.',
          },
          {
            role: 'user',
            content: userContent,
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
        'You are an undercover participant in a casual Telegram group chat. Interject ONLY if you add clear value: a sharp clarification, missing fact, witty one-liner that matches the vibe, or a concise synthesis that moves the convo. If nothing solid to add, reply with EXACTLY "NOOP". Keep it short, lowercase-first, natural, no meta, no over-explaining, mirror language and tone. Be Poke-like: casual, ambient, a bit sharp, never assistant-y. Never ask a question to end.';

      const completion = await this.aiClient.completeRaw({
        model: config.openRouter.models.reply,
        // @ts-expect-error OpenRouter pass-through for low-reasoning reply model calls
        reasoning: { effort: 'low' },
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

  async generateAmbientMemeIdea(
    messages: PopulatedMessage[],
    botUsername: string,
  ): Promise<AmbientMemeIdea | null> {
    try {
      logger.info(
        {
          messagesCount: messages.length,
          model: config.openRouter.models.reply,
        },
        'Ambient: starting meme idea generation',
      );

      const contextMessages = this.buildContext(
        messages.slice(0, 40),
        botUsername,
      );
      const completion = await this.aiClient.completeRaw({
        model: config.openRouter.models.reply,
        // @ts-expect-error OpenRouter pass-through for low-reasoning reply model calls
        reasoning: { effort: 'low' },
        messages: [
          {
            role: 'system',
            content:
              'You decide whether a recent Telegram chat moment deserves an ambient visual meme. Return EXACTLY "NOOP" unless there is a very clear funny visual angle. If there is, return compact JSON with keys prompt and caption only. prompt should describe a safe meme image to generate, with no private likenesses, no hateful/dehumanizing content, and no copyrighted character/style requests. caption should be a short natural Telegram caption.',
          },
          ...contextMessages,
          {
            role: 'system',
            content:
              'Output strict JSON like {"prompt":"...","caption":"..."} or exactly NOOP. No markdown.',
          },
        ],
        max_completion_tokens: 260,
        temperature: 0.8,
      });

      const text = completion.choices[0]?.message?.content?.trim() || '';
      const idea = parseAmbientMemeIdea(text);
      logger.info(
        { generated: idea !== null },
        'Ambient: meme idea generation completed',
      );
      return idea;
    } catch (error) {
      logger.error(error, 'Failed to generate ambient meme idea');
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

    const chronologicalBase = [...messages]
      .reverse()
      .map(convertToOpenAIMessage);

    return chronologicalBase.map((message, idx) => {
      const labelNumber = chronologicalBase.length - idx;
      const content =
        typeof message.content === 'string' ? message.content : '';
      return { ...message, content: `${labelNumber}:\n${content}` };
    });
  }
}
