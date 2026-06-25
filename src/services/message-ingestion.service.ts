import type {
  Message as TelegramMessage,
  Poll as TelegramPoll,
} from 'grammy/types';
import { MESSAGE_TYPE, type MessageType } from '../common/message-types.js';

export interface DerivedTelegramMessageContent {
  text?: string;
  fileName?: string;
  messageType: MessageType;
}

export const getTelegramMessageType = (
  message: TelegramMessage,
): MessageType => {
  if (message.text) return MESSAGE_TYPE.TEXT;
  if (message.poll) return MESSAGE_TYPE.POLL;
  if (message.photo) return MESSAGE_TYPE.PHOTO;
  if (message.video) return MESSAGE_TYPE.VIDEO;
  if (message.video_note) return MESSAGE_TYPE.VIDEO_NOTE;
  if (message.document) return MESSAGE_TYPE.DOCUMENT;
  if (message.sticker) return MESSAGE_TYPE.STICKER;
  if (message.voice) return MESSAGE_TYPE.VOICE;
  if (message.audio) return MESSAGE_TYPE.AUDIO;
  return MESSAGE_TYPE.OTHER;
};

export const deriveTelegramMessageContent = (
  message: TelegramMessage,
): DerivedTelegramMessageContent => {
  const messageType = getTelegramMessageType(message);
  let text: string | undefined = message.text ?? undefined;
  let fileName: string | undefined;

  if (message.poll) text = message.poll.question ?? text;
  if (message.photo) text = message.caption ?? text;
  if (message.video) {
    text = message.caption ?? text;
    fileName = message.video.file_name ?? undefined;
  }
  if (message.document) {
    text = message.caption ?? text;
    fileName = message.document.file_name ?? undefined;
  }
  if (message.video_note) text = message.caption ?? text;

  return { text, fileName, messageType };
};

export const buildTelegramPollContext = (poll: TelegramPoll): string => {
  const lines: string[] = [];
  const options = poll.options || [];
  lines.push('Poll details:');
  lines.push(`• Question: ${poll.question}`);
  lines.push(`• Options: ${options.map((option) => option.text).join(' | ')}`);
  lines.push(`• Total votes: ${poll.total_voter_count}`);
  lines.push('• Votes by option:');
  for (const [index, option] of options.entries()) {
    const voteLabel = option.voter_count === 1 ? 'vote' : 'votes';
    lines.push(
      `${index + 1}. ${option.text} - ${option.voter_count} ${voteLabel}`,
    );
  }
  lines.push(
    `• Multiple answers: ${poll.allows_multiple_answers ? 'yes' : 'no'}`,
  );
  lines.push(`• Anonymous: ${poll.is_anonymous ? 'yes' : 'no'}`);
  lines.push(`• Type: ${poll.type}`);
  if (poll.correct_option_id !== undefined && poll.type === 'quiz') {
    lines.push(`• Correct option index: ${poll.correct_option_id}`);
  }
  if (poll.explanation && poll.type === 'quiz') {
    lines.push(`• Explanation: ${poll.explanation}`);
  }
  if (poll.open_period !== undefined) {
    lines.push(`• Open period (sec): ${poll.open_period}`);
  }
  if (poll.close_date !== undefined) {
    lines.push(`• Close date (unix): ${poll.close_date}`);
  }
  return lines.join('\n');
};
