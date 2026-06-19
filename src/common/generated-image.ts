export const GENERATED_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
] as const;

export type GeneratedImageMimeType =
  (typeof GENERATED_IMAGE_MIME_TYPES)[number];

export interface ParsedGeneratedImageDataUrl {
  mimeType: GeneratedImageMimeType;
  base64: string;
  extension: 'jpg' | 'png' | 'webp';
}

const GENERATED_IMAGE_EXTENSIONS: Record<
  GeneratedImageMimeType,
  ParsedGeneratedImageDataUrl['extension']
> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export const parseGeneratedImageDataUrl = (
  value: string,
): ParsedGeneratedImageDataUrl | null => {
  const match = value.match(/^data:(image\/[^;]+);base64,([A-Za-z0-9+/=]+)$/i);
  if (!match) return null;

  const mimeType = match[1]!.toLowerCase();
  if (!isGeneratedImageMimeType(mimeType)) return null;

  return {
    mimeType,
    base64: match[2]!,
    extension: GENERATED_IMAGE_EXTENSIONS[mimeType],
  };
};

const isGeneratedImageMimeType = (
  value: string,
): value is GeneratedImageMimeType =>
  GENERATED_IMAGE_MIME_TYPES.includes(value as GeneratedImageMimeType);
