export const MESSAGE_TYPE = {
  TEXT: 'text',
  PHOTO: 'photo',
  VIDEO: 'video',
  VIDEO_NOTE: 'video_note',
  DOCUMENT: 'document',
  STICKER: 'sticker',
  VOICE: 'voice',
  AUDIO: 'audio',
  OTHER: 'other',
} as const;

export type MessageType = typeof MESSAGE_TYPE[keyof typeof MESSAGE_TYPE];
