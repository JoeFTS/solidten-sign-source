import { ZDocumentMetaRedirectUrlSchema } from '@documenso/lib/types/document-meta';
import {
  PUBLIC_FORM_INTRO_TEXT_MAX_LENGTH,
  PUBLIC_FORM_MAX_SUBMISSIONS_LIMIT,
  PUBLIC_FORM_THANK_YOU_MAX_LENGTH,
} from '@documenso/lib/utils/public-form';
import { zEmail } from '@documenso/lib/utils/zod';
import { z } from 'zod';

const ZTemplateEnvelopeIdSchema = z.string().min(1).describe('The id of the template envelope.');

export const ZGetPublicFormSettingsRequestSchema = z.object({
  envelopeId: ZTemplateEnvelopeIdSchema,
});

export const ZUpdatePublicFormSettingsRequestSchema = z.object({
  envelopeId: ZTemplateEnvelopeIdSchema,
  data: z.object({
    opensAt: z.date().nullable(),
    closesAt: z.date().nullable(),
    maxSubmissions: z.number().int().min(1).max(PUBLIC_FORM_MAX_SUBMISSIONS_LIMIT).nullable(),
    introText: z.string().max(PUBLIC_FORM_INTRO_TEXT_MAX_LENGTH).nullable(),
    thankYouMessage: z.string().max(PUBLIC_FORM_THANK_YOU_MAX_LENGTH).nullable(),
    redirectUrl: ZDocumentMetaRedirectUrlSchema.nullable(),
    requireVerifiedEmail: z.boolean(),
  }),
});

export const ZSetPublicFormClosedRequestSchema = z.object({
  envelopeId: ZTemplateEnvelopeIdSchema,
  closed: z.boolean(),
});

const ZResponsesFilterSchema = z.object({
  envelopeId: ZTemplateEnvelopeIdSchema,
  from: z.date().nullish(),
  to: z.date().nullish(),
});

export const ZFindPublicFormResponsesRequestSchema = ZResponsesFilterSchema.extend({
  page: z.number().int().min(1).optional(),
  perPage: z.number().int().min(1).max(100).optional(),
});

export const ZExportPublicFormResponsesRequestSchema = ZResponsesFilterSchema;

export const ZRequestPublicFormCodeRequestSchema = z.object({
  token: z.string().min(1).max(255),
  email: zEmail().max(254),
  openedToken: z.string().max(512).optional(),
  honeypot: z.string().max(255).optional(),
  captchaToken: z.string().max(4096).optional(),
});

export const ZVerifyPublicFormCodeRequestSchema = z.object({
  token: z.string().min(1).max(255),
  email: zEmail().max(254),
  code: z.string().trim().max(12),
});

export const ZVerifyPublicFormCodeResponseSchema = z.object({
  proof: z.string(),
});

/**
 * Sent with a direct template submission when the link is a public form.
 */
export const ZPublicFormSubmissionSchema = z.object({
  openedToken: z.string().max(200).optional(),
  verifiedProof: z.string().max(200).optional(),
  honeypot: z.string().max(255).optional(),
  captchaToken: z.string().max(4096).optional(),
});
