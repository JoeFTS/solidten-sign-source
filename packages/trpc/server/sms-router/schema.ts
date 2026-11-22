import { z } from 'zod';

import type { TrpcRouteMeta } from '../trpc';

const ZSenderLabelSchema = z.string().max(40).nullable().optional();

export const ZGetTeamSmsSettingsRequestSchema = z.object({
  teamId: z.number(),
});

export const ZGetOrganisationSmsSettingsRequestSchema = z.object({
  organisationId: z.string(),
});

export const ZUpdateOrganisationSmsSettingsRequestSchema = z.object({
  organisationId: z.string(),
  enabled: z.boolean().optional(),
  senderLabel: ZSenderLabelSchema,
});

export const ZUpdateTeamSmsSettingsRequestSchema = z.object({
  teamId: z.number(),
  enabled: z.boolean().nullable().optional(),
  senderLabel: ZSenderLabelSchema,
});

export const setRecipientPhoneMeta: TrpcRouteMeta = {
  openapi: {
    method: 'POST',
    path: '/envelope/recipient/phone/set',
    summary: 'Set recipient mobile number',
    description:
      'Store the mobile number used to text the signing link to a recipient. Send null to remove it. Only available when text messages are set up on the server.',
    tags: ['Recipients'],
  },
};

export const ZSetRecipientPhoneRequestSchema = z.object({
  envelopeId: z.string(),
  recipientId: z.number(),
  phoneNumber: z.string().max(32).nullable().describe('Mobile number, ideally in E.164 form such as +15551234567.'),
});

export const ZSetRecipientPhoneResponseSchema = z.object({
  phoneE164: z.string().nullable(),
});

export const getEnvelopeSmsStatusMeta: TrpcRouteMeta = {
  openapi: {
    method: 'GET',
    path: '/envelope/{envelopeId}/sms',
    summary: 'Get text message status',
    description: 'Returns the mobile numbers and text message delivery status for the recipients of an envelope.',
    tags: ['Envelope'],
  },
};

export const ZGetEnvelopeSmsStatusRequestSchema = z.object({
  envelopeId: z.string(),
});

export const ZGetEnvelopeSmsStatusResponseSchema = z.object({
  isSupported: z.boolean(),
  recipients: z
    .object({
      recipientId: z.number(),
      phoneE164: z.string().nullable(),
      status: z.string().nullable(),
      lastError: z.string().nullable(),
      sentAt: z.date().nullable(),
      optedOutAt: z.date().nullable(),
    })
    .array(),
  messages: z
    .object({
      id: z.string(),
      recipientId: z.number(),
      purpose: z.string(),
      status: z.string(),
      errorCode: z.string().nullable(),
      createdAt: z.date(),
    })
    .array(),
});
