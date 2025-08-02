import { Collection, CreateIndexesOptions, IndexSpecification } from 'mongodb';
import { TelegramUser } from './TelegramUser.js';
import logger from '../../common/logger.js';

export interface MessageEdit {
  text?: string;
  editedAt: Date;
  version: number;
}

export interface MessageReaction {
  userTelegramId: number; // Reference to TelegramUser.telegramId
  emoji?: string;
  customEmojiId?: string;
  addedAt: Date;
}

export interface PopulatedMessageReaction {
  userTelegramId: number;
  user?: TelegramUser;
  emoji?: string;
  customEmojiId?: string;
  addedAt: Date;
}

export interface Message {
  _id?: string;
  telegramId: number;
  chatTelegramId: number;
  userTelegramId: number; // Reference to TelegramUser.telegramId
  text?: string;
  replyToMessageTelegramId?: number; // Reference to Message.telegramId
  sentAt: Date;
  editDate?: Date;
  edits: MessageEdit[];
  reactions: MessageReaction[];
  messageType:
    | 'text'
    | 'photo'
    | 'video'
    | 'document'
    | 'sticker'
    | 'voice'
    | 'audio'
    | 'other';
  forwardOrigin?: unknown;
  forwardFromUserTelegramId?: number; // Reference to TelegramUser.telegramId
  payload: unknown;
  createdAt: Date;
  updatedAt: Date;
}

export interface PopulatedMessage extends Omit<Message, 'reactions'> {
  user?: TelegramUser;
  replyToMessage?: {
    user?: TelegramUser;
  } & Message;
  reactions: PopulatedMessageReaction[];
  forwardFromUser?: TelegramUser;
}

export class MessageModel {
  constructor(private collection: Collection<Message>) {}

  async findByMessageTelegramId(
    telegramId: number,
    chatTelegramId: number,
  ): Promise<PopulatedMessage | null> {
    const pipeline = [
      {
        $match: { telegramId, chatTelegramId },
      },
      {
        $lookup: {
          from: 'telegramusers',
          localField: 'userTelegramId',
          foreignField: 'telegramId',
          as: 'user',
        },
      },
      {
        $lookup: {
          from: 'messages',
          let: {
            replyId: '$replyToMessageTelegramId',
            chatId: '$chatTelegramId',
          },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$telegramId', '$$replyId'] },
                    { $eq: ['$chatTelegramId', '$$chatId'] },
                  ],
                },
              },
            },
            {
              $lookup: {
                from: 'telegramusers',
                localField: 'userTelegramId',
                foreignField: 'telegramId',
                as: 'user',
              },
            },
            {
              $addFields: {
                user: { $arrayElemAt: ['$user', 0] },
              },
            },
          ],
          as: 'replyToMessage',
        },
      },
      {
        $lookup: {
          from: 'telegramusers',
          localField: 'forwardFromUserTelegramId',
          foreignField: 'telegramId',
          as: 'forwardFromUser',
        },
      },
      {
        $lookup: {
          from: 'telegramusers',
          localField: 'reactions.userTelegramId',
          foreignField: 'telegramId',
          as: 'reactionUsers',
        },
      },
      {
        $addFields: {
          user: { $arrayElemAt: ['$user', 0] },
          replyToMessage: { $arrayElemAt: ['$replyToMessage', 0] },
          forwardFromUser: { $arrayElemAt: ['$forwardFromUser', 0] },
          reactions: {
            $map: {
              input: '$reactions',
              as: 'reaction',
              in: {
                userTelegramId: '$$reaction.userTelegramId',
                emoji: '$$reaction.emoji',
                customEmojiId: '$$reaction.customEmojiId',
                addedAt: '$$reaction.addedAt',
                user: {
                  $arrayElemAt: [
                    {
                      $filter: {
                        input: '$reactionUsers',
                        cond: {
                          $eq: [
                            '$$this.telegramId',
                            '$$reaction.userTelegramId',
                          ],
                        },
                      },
                    },
                    0,
                  ],
                },
              },
            },
          },
        },
      },
      {
        $unset: 'reactionUsers',
      },
    ];

    const result = await this.collection
      .aggregate<PopulatedMessage>(pipeline)
      .toArray();

    return result.length > 0 ? result[0] : null;
  }

  async saveMessage(messageData: Partial<Message>): Promise<Message> {
    const now = new Date();

    const newMessage: Message = {
      telegramId: messageData.telegramId!,
      chatTelegramId: messageData.chatTelegramId!,
      userTelegramId: messageData.userTelegramId!,
      text: messageData.text,
      replyToMessageTelegramId: messageData.replyToMessageTelegramId,
      sentAt: messageData.sentAt || now,
      editDate: messageData.editDate,
      edits: [],
      reactions: [],
      messageType: messageData.messageType || 'text',
      forwardOrigin: messageData.forwardOrigin,
      forwardFromUserTelegramId: messageData.forwardFromUserTelegramId,
      payload: messageData.payload,
      createdAt: now,
      updatedAt: now,
    };

    await this.collection.insertOne(newMessage);
    return newMessage;
  }

  async editMessage(
    messageId: number,
    chatId: number,
    newText: string,
  ): Promise<void> {
    const existingMessage = await this.findByMessageTelegramId(
      messageId,
      chatId,
    );
    if (!existingMessage) {
      throw new Error('Message not found');
    }

    const now = new Date();
    const newVersion = existingMessage.edits.length + 1;

    const editEntry: MessageEdit = {
      text: existingMessage.text,
      editedAt: now,
      version: newVersion,
    };

    await this.collection.updateOne(
      { messageId, chatId },
      {
        $set: {
          text: newText,
          editDate: now,
          updatedAt: now,
        },
        $push: { edits: editEntry },
      },
    );
  }

  async updateReactions(
    messageTelegramId: number,
    chatTelegramId: number,
    userTelegramId: number,
    addedReactions: Omit<MessageReaction, 'userTelegramId' | 'addedAt'>[],
    removedReactions: Omit<MessageReaction, 'userTelegramId' | 'addedAt'>[],
  ): Promise<void> {
    const message = await this.findByMessageTelegramId(
      messageTelegramId,
      chatTelegramId,
    );
    if (!message) {
      throw new Error('Message not found');
    }

    const now = new Date();

    let updatedReactions = message.reactions.filter((reaction) => {
      if (reaction.userTelegramId !== userTelegramId) return true;

      return !removedReactions.some(
        (r) =>
          r.emoji === reaction.emoji &&
          r.customEmojiId === reaction.customEmojiId,
      );
    });

    const newReactions: MessageReaction[] = addedReactions.map((reaction) => ({
      ...reaction,
      userTelegramId: userTelegramId,
      addedAt: now,
    }));

    updatedReactions = [...updatedReactions, ...newReactions];

    await this.collection.updateOne(
      { telegramId: messageTelegramId, chatTelegramId: chatTelegramId },
      {
        $set: {
          reactions: updatedReactions,
          updatedAt: now,
        },
      },
    );
  }

  async getRecentMessages(
    chatId: number,
    limit: number = 500,
  ): Promise<PopulatedMessage[]> {
    const pipeline = [
      {
        $match: { chatTelegramId: chatId },
      },
      {
        $sort: { sentAt: -1 },
      },
      {
        $limit: limit,
      },
      {
        $lookup: {
          from: 'telegramusers',
          localField: 'userTelegramId',
          foreignField: 'telegramId',
          as: 'user',
        },
      },
      {
        $lookup: {
          from: 'messages',
          let: {
            replyId: '$replyToMessageTelegramId',
            chatId: '$chatTelegramId',
          },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$telegramId', '$$replyId'] },
                    { $eq: ['$chatTelegramId', '$$chatId'] },
                  ],
                },
              },
            },
            {
              $lookup: {
                from: 'telegramusers',
                localField: 'userTelegramId',
                foreignField: 'telegramId',
                as: 'user',
              },
            },
            {
              $addFields: {
                user: { $arrayElemAt: ['$user', 0] },
              },
            },
          ],
          as: 'replyToMessage',
        },
      },
      {
        $lookup: {
          from: 'telegramusers',
          localField: 'forwardFromUserTelegramId',
          foreignField: 'telegramId',
          as: 'forwardFromUser',
        },
      },
      {
        $lookup: {
          from: 'telegramusers',
          localField: 'reactions.userTelegramId',
          foreignField: 'telegramId',
          as: 'reactionUsers',
        },
      },
      {
        $addFields: {
          user: { $arrayElemAt: ['$user', 0] },
          replyToMessage: { $arrayElemAt: ['$replyToMessage', 0] },
          forwardFromUser: { $arrayElemAt: ['$forwardFromUser', 0] },
          reactions: {
            $map: {
              input: '$reactions',
              as: 'reaction',
              in: {
                userTelegramId: '$$reaction.userTelegramId',
                emoji: '$$reaction.emoji',
                customEmojiId: '$$reaction.customEmojiId',
                addedAt: '$$reaction.addedAt',
                user: {
                  $arrayElemAt: [
                    {
                      $filter: {
                        input: '$reactionUsers',
                        cond: {
                          $eq: [
                            '$$this.telegramId',
                            '$$reaction.userTelegramId',
                          ],
                        },
                      },
                    },
                    0,
                  ],
                },
              },
            },
          },
        },
      },
      {
        $unset: 'reactionUsers',
      },
    ];

    return await this.collection
      .aggregate<PopulatedMessage>(pipeline)
      .toArray();
  }

  async createIndexes(): Promise<void> {
    const indexDefinitions: {
      keys: IndexSpecification;
      options?: CreateIndexesOptions;
      description: string;
    }[] = [
      {
        keys: { chatTelegramId: 1, sentAt: -1 },
        description: 'Main query index for getRecentMessages',
      },
      {
        keys: { userTelegramId: 1 },
        description: 'User lookup index',
      },
      {
        keys: { forwardFromUserTelegramId: 1 },
        description: 'Forward user lookup index',
      },
      {
        keys: { telegramId: 1, chatTelegramId: 1 },
        options: { unique: true },
        description: 'Reply lookup compound index',
      },
      {
        keys: { 'reactions.userTelegramId': 1 },
        description: 'Reaction user lookup index',
      },
      {
        keys: { telegramId: 1 },
        options: { unique: true },
        description: 'Unique message ID index',
      },
    ];

    for (const def of indexDefinitions) {
      try {
        await this.collection.createIndex(def.keys, def.options);
        logger.info(`Created Message index successfully: ${def.description}`);
      } catch (error) {
        logger.error(
          error,
          `Message index creation failed (may already exist): ${def.description}`,
        );
      }
    }
  }
}
