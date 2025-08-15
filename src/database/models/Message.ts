import { Collection, CreateIndexesOptions, IndexSpecification, ObjectId } from 'mongodb';
import { TelegramUser } from './TelegramUser.js';
import { MessageType } from '../../common/message-types.js';
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
  context?: string;
  fileName?: string;
  replyToMessageTelegramId?: number; // Reference to Message.telegramId
  replyQuoteText?: string;
  sentAt: Date;
  editDate?: Date;
  edits: MessageEdit[];
  reactions: MessageReaction[];
  messageType: MessageType;
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

  // --- DRY aggregation helpers ---
  private buildReplyLookupStage() {
    return {
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
    } as const;
  }

  private buildPopulationStages() {
    return [
      // Author user
      {
        $lookup: {
          from: 'telegramusers',
          localField: 'userTelegramId',
          foreignField: 'telegramId',
          as: 'user',
        },
      },
      // Reply (including its user)
      this.buildReplyLookupStage(),
      // Forwarded from user
      {
        $lookup: {
          from: 'telegramusers',
          localField: 'forwardFromUserTelegramId',
          foreignField: 'telegramId',
          as: 'forwardFromUser',
        },
      },
      // Reaction users
      {
        $lookup: {
          from: 'telegramusers',
          localField: 'reactions.userTelegramId',
          foreignField: 'telegramId',
          as: 'reactionUsers',
        },
      },
      // Normalize shapes and map reactions with users
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
      { $unset: 'reactionUsers' },
    ] as const;
  }

  private buildPipeline(
    match: Record<string, unknown>,
    options?: { sort?: Record<string, 1 | -1>; skip?: number; limit?: number },
  ) {
    const stages: any[] = [{ $match: match }];
    if (options?.sort) stages.push({ $sort: options.sort });
    if (typeof options?.skip === 'number') stages.push({ $skip: options.skip });
    if (typeof options?.limit === 'number') stages.push({ $limit: options.limit });
    stages.push(...this.buildPopulationStages());
    return stages;
  }

  async findByMessageTelegramId(
    telegramId: number,
    chatTelegramId: number,
  ): Promise<PopulatedMessage | null> {
    const pipeline = this.buildPipeline({ telegramId, chatTelegramId });

    const result = await this.collection
      .aggregate<PopulatedMessage>(pipeline)
      .toArray();

    return result.length > 0 ? result[0] : null;
  }

  async findByDbId(id: string): Promise<PopulatedMessage | null> {
    let objectId: ObjectId;
    try {
      objectId = new ObjectId(id);
    } catch {
      return null;
    }

    const pipeline = this.buildPipeline({ _id: objectId });
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
      context: messageData.context,
      fileName: messageData.fileName,
      replyToMessageTelegramId: messageData.replyToMessageTelegramId,
      replyQuoteText: messageData.replyQuoteText,
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

  async updateMessageContext(
    messageTelegramId: number,
    chatTelegramId: number,
    context: string,
  ): Promise<void> {
    const now = new Date();
    await this.collection.updateOne(
      { telegramId: messageTelegramId, chatTelegramId },
      { $set: { context, updatedAt: now } },
    );
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
    limit: number,
  ): Promise<PopulatedMessage[]> {
    const pipeline = this.buildPipeline(
      { chatTelegramId: chatId },
      { sort: { sentAt: -1 }, limit },
    );

    return await this.collection
      .aggregate<PopulatedMessage>(pipeline)
      .toArray();
  }

  async getMessagesAscending(
    chatId: number,
    skip: number,
    limit: number,
  ): Promise<PopulatedMessage[]> {
    const pipeline = this.buildPipeline(
      { chatTelegramId: chatId },
      { sort: { sentAt: 1 }, skip, limit },
    );

    return await this.collection
      .aggregate<PopulatedMessage>(pipeline)
      .toArray();
  }

  async countMessages(chatId: number): Promise<number> {
    return this.collection.countDocuments({ chatTelegramId: chatId });
  }

  async countAllMessages(): Promise<number> {
    return this.collection.countDocuments({});
  }

  async getMessageCountsByChat(): Promise<{ chatTelegramId: number; count: number }[]> {
    const docs = await this.collection
      .aggregate<{ _id: number; count: number }>([
        { $group: { _id: '$chatTelegramId', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ])
      .toArray();
    return docs.map((d) => ({ chatTelegramId: d._id, count: d.count }));
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
