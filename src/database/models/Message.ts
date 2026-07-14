import {
  Collection,
  CreateIndexesOptions,
  IndexSpecification,
  ObjectId,
} from 'mongodb';
import { TelegramUser } from './TelegramUser.js';
import { MessageType } from '../../common/message-types.js';
import logger from '../../common/logger.js';

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
  deliveryFormat?: string;
  deliveryText?: string;
  deliveryFallbackReason?: string;
  isDeleted?: boolean;
  deletedAt?: Date;
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

export interface MessageStatsInput {
  chatTelegramId: number;
  since?: Date;
  until?: Date;
  timeZone: string;
  dayLimit: number;
  topUsersLimit: number;
  topHoursLimit: number;
  excludeUserTelegramId?: number;
}

export interface MessageDailyCount {
  day: string;
  count: number;
}

export interface MessageTopUserCount {
  userTelegramId: number;
  username?: string;
  firstName?: string;
  lastName?: string;
  isBot?: boolean;
  count: number;
}

export interface MessagePeakHourCount {
  hour: string;
  count: number;
}

export interface MessageStats {
  totalMessages: number;
  firstSentAt?: Date;
  lastSentAt?: Date;
  byDay: MessageDailyCount[];
  topUsers: MessageTopUserCount[];
  peakHours: MessagePeakHourCount[];
}

export interface RawMessageSnapshot {
  telegramId: number;
  sentAt?: Date;
  messageType?: MessageType;
  payload?: unknown;
}

interface MessageStatsFacetResult {
  totals?: {
    totalMessages: number;
    firstSentAt?: Date;
    lastSentAt?: Date;
  }[];
  byDay?: { _id: string; count: number }[];
  topUsers?: {
    _id: number;
    count: number;
    user?: {
      username?: string;
      firstName?: string;
      lastName?: string;
      isBot?: boolean;
    };
  }[];
  peakHours?: { _id: string; count: number }[];
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
    if (typeof options?.limit === 'number')
      stages.push({ $limit: options.limit });
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

  async findRawByMessageTelegramId(
    telegramId: number,
    chatTelegramId: number,
  ): Promise<RawMessageSnapshot | null> {
    return this.collection.findOne(
      { telegramId, chatTelegramId },
      {
        projection: {
          _id: 0,
          telegramId: 1,
          sentAt: 1,
          messageType: 1,
          payload: 1,
        },
      },
    );
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
      deliveryFormat: messageData.deliveryFormat,
      deliveryText: messageData.deliveryText,
      deliveryFallbackReason: messageData.deliveryFallbackReason,
      isDeleted: messageData.isDeleted,
      deletedAt: messageData.deletedAt,
      forwardOrigin: messageData.forwardOrigin,
      forwardFromUserTelegramId: messageData.forwardFromUserTelegramId,
      payload: messageData.payload,
      createdAt: now,
      updatedAt: now,
    };

    await this.collection.updateOne(
      {
        telegramId: newMessage.telegramId,
        chatTelegramId: newMessage.chatTelegramId,
      },
      {
        $set: {
          userTelegramId: newMessage.userTelegramId,
          text: newMessage.text,
          context: newMessage.context,
          fileName: newMessage.fileName,
          replyToMessageTelegramId: newMessage.replyToMessageTelegramId,
          replyQuoteText: newMessage.replyQuoteText,
          sentAt: newMessage.sentAt,
          editDate: newMessage.editDate,
          messageType: newMessage.messageType,
          deliveryFormat: newMessage.deliveryFormat,
          deliveryText: newMessage.deliveryText,
          deliveryFallbackReason: newMessage.deliveryFallbackReason,
          isDeleted: newMessage.isDeleted,
          deletedAt: newMessage.deletedAt,
          forwardOrigin: newMessage.forwardOrigin,
          forwardFromUserTelegramId: newMessage.forwardFromUserTelegramId,
          payload: newMessage.payload,
          updatedAt: now,
        },
        $setOnInsert: {
          telegramId: newMessage.telegramId,
          chatTelegramId: newMessage.chatTelegramId,
          edits: [],
          reactions: [],
          createdAt: now,
        },
      },
      { upsert: true },
    );
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
      { telegramId: messageId, chatTelegramId: chatId },
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

  async replaceUserReactions(
    messageTelegramId: number,
    chatTelegramId: number,
    userTelegramId: number,
    reactions: Omit<MessageReaction, 'userTelegramId' | 'addedAt'>[],
  ): Promise<void> {
    const message = await this.findByMessageTelegramId(
      messageTelegramId,
      chatTelegramId,
    );
    if (!message) {
      throw new Error('Message not found');
    }

    const now = new Date();
    const otherUserReactions = message.reactions.filter(
      (reaction) => reaction.userTelegramId !== userTelegramId,
    );
    const replacementReactions: MessageReaction[] = reactions.map(
      (reaction) => ({
        ...reaction,
        userTelegramId,
        addedAt: now,
      }),
    );

    await this.collection.updateOne(
      { telegramId: messageTelegramId, chatTelegramId },
      {
        $set: {
          reactions: [...otherUserReactions, ...replacementReactions],
          updatedAt: now,
        },
      },
    );
  }

  async markDeleted(
    messageTelegramId: number,
    chatTelegramId: number,
  ): Promise<void> {
    const now = new Date();
    await this.collection.updateOne(
      { telegramId: messageTelegramId, chatTelegramId },
      {
        $set: {
          isDeleted: true,
          deletedAt: now,
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

  async getMessagesBefore(
    chatId: number,
    messageTelegramId: number,
    limit: number,
  ): Promise<PopulatedMessage[]> {
    const pipeline = this.buildPipeline(
      {
        chatTelegramId: chatId,
        telegramId: { $lt: messageTelegramId },
      },
      { sort: { telegramId: -1 }, limit },
    );

    return await this.collection
      .aggregate<PopulatedMessage>(pipeline)
      .toArray();
  }

  async searchMessages(input: {
    chatTelegramId: number;
    query?: string;
    since?: Date;
    until?: Date;
    fromUserTelegramId?: number;
    beforeMessageTelegramId?: number;
    limit: number;
  }): Promise<PopulatedMessage[]> {
    const match: Record<string, unknown> = {
      chatTelegramId: input.chatTelegramId,
    };

    if (input.query?.trim()) {
      match.text = { $regex: escapeRegex(input.query.trim()), $options: 'i' };
    }

    if (input.since || input.until) {
      const sentAt: Record<string, Date> = {};
      if (input.since) sentAt.$gte = input.since;
      if (input.until) sentAt.$lte = input.until;
      match.sentAt = sentAt;
    }

    if (typeof input.fromUserTelegramId === 'number') {
      match.userTelegramId = input.fromUserTelegramId;
    }

    if (typeof input.beforeMessageTelegramId === 'number') {
      match.telegramId = { $lt: input.beforeMessageTelegramId };
    }

    const pipeline = this.buildPipeline(match, {
      sort: { telegramId: -1 },
      limit: input.limit,
    });

    return this.collection.aggregate<PopulatedMessage>(pipeline).toArray();
  }

  async getChatStats(input: MessageStatsInput): Promise<MessageStats> {
    const match = this.buildStatsMatch(input);
    const byDayExpression = this.dateToStringExpression(
      '%Y-%m-%d',
      input.timeZone,
    );
    const byHourExpression = this.dateToStringExpression(
      '%Y-%m-%d %H:00',
      input.timeZone,
    );

    const [result] = await this.collection
      .aggregate<MessageStatsFacetResult>([
        { $match: match },
        {
          $facet: {
            totals: [
              {
                $group: {
                  _id: null,
                  totalMessages: { $sum: 1 },
                  firstSentAt: { $min: '$sentAt' },
                  lastSentAt: { $max: '$sentAt' },
                },
              },
            ],
            byDay: [
              {
                $group: {
                  _id: byDayExpression,
                  count: { $sum: 1 },
                },
              },
              { $sort: { _id: -1 } },
              { $limit: input.dayLimit },
            ],
            topUsers: [
              { $group: { _id: '$userTelegramId', count: { $sum: 1 } } },
              { $sort: { count: -1, _id: 1 } },
              { $limit: input.topUsersLimit },
              {
                $lookup: {
                  from: 'telegramusers',
                  localField: '_id',
                  foreignField: 'telegramId',
                  as: 'user',
                },
              },
              { $addFields: { user: { $arrayElemAt: ['$user', 0] } } },
              {
                $project: {
                  _id: 1,
                  count: 1,
                  'user.username': 1,
                  'user.firstName': 1,
                  'user.lastName': 1,
                  'user.isBot': 1,
                },
              },
            ],
            peakHours: [
              {
                $group: {
                  _id: byHourExpression,
                  count: { $sum: 1 },
                },
              },
              { $sort: { count: -1, _id: -1 } },
              { $limit: input.topHoursLimit },
            ],
          },
        },
      ])
      .toArray();

    const totals = result?.totals?.[0];

    return {
      totalMessages: totals?.totalMessages ?? 0,
      firstSentAt: totals?.firstSentAt,
      lastSentAt: totals?.lastSentAt,
      byDay:
        result?.byDay?.map((item) => ({
          day: item._id,
          count: item.count,
        })) ?? [],
      topUsers:
        result?.topUsers?.map((item) => ({
          userTelegramId: item._id,
          username: item.user?.username,
          firstName: item.user?.firstName,
          lastName: item.user?.lastName,
          isBot: item.user?.isBot,
          count: item.count,
        })) ?? [],
      peakHours:
        result?.peakHours?.map((item) => ({
          hour: item._id,
          count: item.count,
        })) ?? [],
    };
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

  async getMessageCountsByChat(): Promise<
    { chatTelegramId: number; count: number }[]
  > {
    const docs = await this.collection
      .aggregate<{
        _id: number;
        count: number;
      }>([
        { $group: { _id: '$chatTelegramId', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ])
      .toArray();
    return docs.map((d) => ({ chatTelegramId: d._id, count: d.count }));
  }

  async createIndexes(): Promise<void> {
    try {
      await this.collection.dropIndex('telegramId_1');
      logger.info('Dropped legacy global telegramId index');
    } catch (error) {
      logger.info(
        { error },
        'Legacy global telegramId index not present or already removed',
      );
    }

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
        keys: { chatTelegramId: 1, telegramId: -1 },
        description: 'Archive cursor pagination index',
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
        keys: { chatTelegramId: 1, text: 1 },
        description: 'Scoped text search prefilter index',
      },
      {
        keys: { 'reactions.userTelegramId': 1 },
        description: 'Reaction user lookup index',
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

  private buildStatsMatch(input: MessageStatsInput): Record<string, unknown> {
    const match: Record<string, unknown> = {
      chatTelegramId: input.chatTelegramId,
    };

    if (input.since || input.until) {
      const sentAt: Record<string, Date> = {};
      if (input.since) sentAt.$gte = input.since;
      if (input.until) sentAt.$lt = input.until;
      match.sentAt = sentAt;
    }

    if (typeof input.excludeUserTelegramId === 'number') {
      match.userTelegramId = { $ne: input.excludeUserTelegramId };
    }

    return match;
  }

  private dateToStringExpression(format: string, timeZone: string) {
    return {
      $dateToString: {
        format,
        date: '$sentAt',
        timezone: timeZone,
      },
    };
  }
}
