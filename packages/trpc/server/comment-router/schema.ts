import { COMMENT_MAX_LENGTH } from '@documenso/lib/utils/envelope-comments';
import { zMultiLineText } from '@documenso/lib/utils/safe-text';
import { z } from 'zod';

// The server trims and checks the length again after removing control characters.
// Solid Ten Sign (S-L5): bidirectional overrides are removed too.
const ZCommentBodySchema = zMultiLineText(COMMENT_MAX_LENGTH * 2);

export const ZRecipientCommentsRequestSchema = z.object({
  token: z.string().min(1),
});

export const ZPostRecipientCommentRequestSchema = z.object({
  token: z.string().min(1),
  body: ZCommentBodySchema,
});

export const ZEnvelopeCommentsRequestSchema = z.object({
  envelopeId: z.string().min(1),
});

export const ZReplyToCommentThreadRequestSchema = z.object({
  envelopeId: z.string().min(1),
  threadId: z.string().min(1),
  body: ZCommentBodySchema,
});

export const ZSetCommentThreadResolvedRequestSchema = z.object({
  envelopeId: z.string().min(1),
  threadId: z.string().min(1),
  resolved: z.boolean(),
});

export const ZUpdateEnvelopeCommentSettingsRequestSchema = z.object({
  envelopeId: z.string().min(1),
  enabled: z.boolean(),
  sharedThread: z.boolean(),
});
