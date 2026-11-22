import { prisma } from '@documenso/prisma';
import type { Envelope, Recipient } from '@prisma/client';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../types/document-audit-logs';
import type { TRecipientAccessAuth } from '../../types/document-auth';
import { DocumentAuth } from '../../types/document-auth';
import type { RequestMetadata } from '../../universal/extract-request-metadata';
import { createDocumentAuditLogData } from '../../utils/document-audit-logs';
import { extractDocumentAuthMethods } from '../../utils/document-auth';
import { isRecipientAuthorized } from './is-recipient-authorized';

/**
 * Solid Ten Sign (AUD-14): the emailed two-factor access code for an action
 * other than completion (a decline by link). Same rule and same audit entries
 * as completion: when the recipient's access needs the code, the action needs a
 * valid one. The attempt limit applies (AUD-1).
 */
export const assertAccess2FAForTokenAction = async ({
  envelope,
  recipient,
  userId,
  accessAuthOptions,
  requestMetadata,
}: {
  envelope: Pick<Envelope, 'id' | 'authOptions'>;
  recipient: Pick<Recipient, 'id' | 'name' | 'email' | 'envelopeId' | 'authOptions'>;
  userId?: number;
  accessAuthOptions?: TRecipientAccessAuth;
  requestMetadata?: RequestMetadata;
}) => {
  const { derivedRecipientAccessAuth } = extractDocumentAuthMethods({
    documentAuth: envelope.authOptions,
    recipientAuth: recipient.authOptions,
  });

  if (!derivedRecipientAccessAuth.includes(DocumentAuth.TWO_FACTOR_AUTH)) {
    return;
  }

  if (!accessAuthOptions) {
    throw new AppError(AppErrorCode.UNAUTHORIZED, {
      message: 'Access authentication required',
    });
  }

  const auditData = {
    recipientId: recipient.id,
    recipientName: recipient.name,
    recipientEmail: recipient.email,
  };

  const isValid = await isRecipientAuthorized({
    type: 'ACCESS_2FA',
    documentAuthOptions: envelope.authOptions,
    recipient,
    userId,
    authOptions: accessAuthOptions,
    requestMetadata,
  });

  await prisma.documentAuditLog.create({
    data: createDocumentAuditLogData({
      type: isValid
        ? DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_ACCESS_AUTH_2FA_VALIDATED
        : DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_ACCESS_AUTH_2FA_FAILED,
      envelopeId: envelope.id,
      requestMetadata,
      data: auditData,
    }),
  });

  if (!isValid) {
    throw new AppError(AppErrorCode.TWO_FACTOR_AUTH_FAILED, {
      message: 'Invalid 2FA authentication',
    });
  }
};
