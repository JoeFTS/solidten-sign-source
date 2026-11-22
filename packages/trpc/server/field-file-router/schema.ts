import { ZFieldSchema } from '@documenso/lib/types/field';
import { z } from 'zod';
import { zfd } from 'zod-form-data';

import { zodFormData } from '../../utils/zod-form-data';

export const ZFieldFileSummarySchema = z.object({
  id: z.string(),
  envelopeId: z.string(),
  fieldId: z.number(),
  recipientId: z.number(),
  fileName: z.string(),
  mimeType: z.string(),
  size: z.number(),
  sha256: z.string(),
  uploaderName: z.string(),
  uploaderEmail: z.string(),
  createdAt: z.date(),
});

export type TFieldFileSummary = z.infer<typeof ZFieldFileSummarySchema>;

const ZSignedFieldSchema = ZFieldSchema.omit({
  templateId: true,
  documentId: true,
});

export const ZUploadFieldFilePayloadSchema = z.object({
  token: z.string().min(1),
  fieldId: z.number(),
  replaceFileId: z.string().min(1).nullish(),
});

/**
 * The size is checked in the route against the server limit; the declared content type
 * is ignored, the bytes are checked instead.
 */
export const ZUploadFieldFileRequestSchema = zodFormData({
  payload: zfd.json(ZUploadFieldFilePayloadSchema),
  // Not `zfd.file()`: it turns a zero-byte file into "Required". The upload code refuses an
  // empty file itself, with "The file is empty."
  file: z.instanceof(File, { message: 'Attach a file.' }),
});

export const ZUploadFieldFileResponseSchema = z.object({
  file: ZFieldFileSummarySchema,
  signedField: ZSignedFieldSchema,
  affectedFields: z.array(ZSignedFieldSchema),
});

export const ZRemoveFieldFileRequestSchema = z.object({
  token: z.string().min(1),
  fieldId: z.number(),
  fileId: z.string().min(1),
});

export const ZRemoveFieldFileResponseSchema = z.object({
  signedField: ZSignedFieldSchema,
  affectedFields: z.array(ZSignedFieldSchema),
});

export const ZListSignerFieldFilesRequestSchema = z.object({
  token: z.string().min(1),
});

export const ZListSignerFieldFilesResponseSchema = z.object({
  files: z.array(ZFieldFileSummarySchema),
  maxFileBytes: z.number(),
});

export const ZListEnvelopeFieldFilesRequestSchema = z.object({
  envelopeId: z.string().min(1),
});

export const ZListEnvelopeFieldFilesResponseSchema = z.object({
  files: z.array(ZFieldFileSummarySchema),
});
