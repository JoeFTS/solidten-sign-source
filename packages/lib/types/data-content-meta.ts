import { z } from 'zod';

export enum DataContentType {
  IMAGE = 'image',
  // Solid Ten: a file a signer attached to an "Attach a file" field.
  FILE = 'file',
}

export const ZDataContentTypeSchema = z.nativeEnum(DataContentType);

export const ZDataContentImageMeta = z.object({
  type: z.literal(DataContentType.IMAGE),

  // Intrinsic pixel dimensions, recorded on upload so renderers can resolve the aspect ratio before the bytes are loaded.
  width: z.number().int().positive(),
  height: z.number().int().positive(),

  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),

  fileName: z.string().max(255),

  fileSize: z.number().int().nonnegative(),
});

export type TDataContentImageMeta = z.infer<typeof ZDataContentImageMeta>;

export const ZDataContentFileMeta = z.object({
  type: z.literal(DataContentType.FILE),

  // The content type found from the bytes, never the one the browser declared.
  mimeType: z.string().max(255),

  fileName: z.string().max(255),

  fileSize: z.number().int().nonnegative(),

  sha256: z.string().length(64),
});

export type TDataContentFileMeta = z.infer<typeof ZDataContentFileMeta>;

export const ZDataContentMetaSchema = z.discriminatedUnion('type', [ZDataContentImageMeta, ZDataContentFileMeta]);

export type TDataContentMeta = z.infer<typeof ZDataContentMetaSchema>;
