import { Collection } from 'mongodb';
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
  user?: TelegramUser; // Populated user data
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
  user?: TelegramUser; // Populated user data
  replyToMessage?: {
    user?: TelegramUser; // Populated user data of the replied-to message sender
  } & Message; // Populated replied-to message
  reactions: PopulatedMessageReaction[]; // Populated reactions
  forwardFromUser?: TelegramUser; // Populated forward user data
}

export class MessageModel {
  constructor(private collection: Collection<Message>) {}

  async findByMessageTelegramId(
    telegramId: number,
    chatTelegramId: number,
  ): Promise<PopulatedMessage | null> {
    const pipeline = [
      // Match the specific message
      {
        $match: { telegramId, chatTelegramId },
      },

      // Lookup user who sent the message
      {
        $lookup: {
          from: 'telegramusers',
          localField: 'userTelegramId',
          foreignField: 'telegramId',
          as: 'user',
        },
      },

      // Lookup replied-to message
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
            // Lookup user of the replied-to message
            {
              $lookup: {
                from: 'telegramusers',
                localField: 'userTelegramId',
                foreignField: 'telegramId',
                as: 'user',
              },
            },
            // Add the user field
            {
              $addFields: {
                user: { $arrayElemAt: ['$user', 0] },
              },
            },
          ],
          as: 'replyToMessage',
        },
      },

      // Lookup forward user
      {
        $lookup: {
          from: 'telegramusers',
          localField: 'forwardFromUserTelegramId',
          foreignField: 'telegramId',
          as: 'forwardFromUser',
        },
      },

      // Lookup users for reactions
      {
        $lookup: {
          from: 'telegramusers',
          localField: 'reactions.userTelegramId',
          foreignField: 'telegramId',
          as: 'reactionUsers',
        },
      },

      // Transform the results
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

      // Remove the temporary reactionUsers field
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

    // Add current text to edits history
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

    // Remove only specified reactions of this user
    let updatedReactions = message.reactions.filter((reaction) => {
      // Keep other users' reactions
      if (reaction.userTelegramId !== userTelegramId) return true;
      // Keep this user's reactions UNLESS they should be removed
      return !removedReactions.some(
        (r) =>
          r.emoji === reaction.emoji &&
          r.customEmojiId === reaction.customEmojiId, // compare key fields
      );
    });

    // Add new reactions for this user
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
      // Match messages from the specific chat
      {
        $match: { chatTelegramId: chatId },
      },

      // Sort by sentAt descending (newest first)
      {
        $sort: { sentAt: -1 },
      },

      // Limit results
      {
        $limit: limit,
      },

      // Lookup user who sent the message
      {
        $lookup: {
          from: 'telegramusers',
          localField: 'userTelegramId',
          foreignField: 'telegramId',
          as: 'user',
        },
      },

      // Lookup replied-to message
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
            // Lookup user of the replied-to message
            {
              $lookup: {
                from: 'telegramusers',
                localField: 'userTelegramId',
                foreignField: 'telegramId',
                as: 'user',
              },
            },
            // Add the user field
            {
              $addFields: {
                user: { $arrayElemAt: ['$user', 0] },
              },
            },
          ],
          as: 'replyToMessage',
        },
      },

      // Lookup forward user
      {
        $lookup: {
          from: 'telegramusers',
          localField: 'forwardFromUserTelegramId',
          foreignField: 'telegramId',
          as: 'forwardFromUser',
        },
      },

      // Lookup users for reactions
      {
        $lookup: {
          from: 'telegramusers',
          localField: 'reactions.userTelegramId',
          foreignField: 'telegramId',
          as: 'reactionUsers',
        },
      },

      // Transform the results
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

      // Remove the temporary reactionUsers field
      {
        $unset: 'reactionUsers',
      },
    ];

    return await this.collection
      .aggregate<PopulatedMessage>(pipeline)
      .toArray();
  }

  /**
   * Create database indexes for optimal query performance
   */
  async createIndexes(): Promise<void> {
    const indexCreations = [
      // Main query index for getRecentMessages
      async () =>
        this.collection.createIndex({ chatTelegramId: 1, sentAt: -1 }),

      // User lookup indexes
      async () => this.collection.createIndex({ userTelegramId: 1 }),
      async () => this.collection.createIndex({ forwardFromUserTelegramId: 1 }),

      // Reply lookup index - compound for efficient lookups
      async () =>
        this.collection.createIndex(
          { telegramId: 1, chatTelegramId: 1 },
          { unique: true },
        ),

      // Reaction user lookup index
      async () =>
        this.collection.createIndex({ 'reactions.userTelegramId': 1 }),

      // Individual field indexes for general performance
      async () =>
        this.collection.createIndex({ telegramId: 1 }, { unique: true }),
    ];

    for (const createIndex of indexCreations) {
      try {
        await createIndex();
        logger.info(`Created Message index successfully`);
      } catch (error) {
        // Index might already exist, log but don't throw
        logger.info(
          error,
          `Message index creation skipped (may already exist)`,
        );
      }
    }
  }
}
