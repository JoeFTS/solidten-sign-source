import { PDF } from '@libpdf/core';
import { i18n } from '@lingui/core';
import type { DocumentMeta, Envelope, Field, Recipient, Signature } from '@prisma/client';
import { FieldType } from '@prisma/client';
import { prop, sortBy } from 'remeda';
import { ZSupportedLanguageCodeSchema } from '../../constants/i18n';
import type { TDocumentAuditLogBaseSchema } from '../../types/document-audit-logs';
import { CERTIFICATE_AUTH_LEVEL_LABELS, getCertificateAuthLevel } from '../../utils/certificate-auth-level';
import { getRecordedAccessAuth } from '../../utils/certificate-recorded-access';
import { extractDocumentAuthMethods } from '../../utils/document-auth';
import { getTranslations } from '../../utils/i18n';
import { getInPersonHostFromAuditLog } from '../../utils/in-person-audit';
import { formatPublicFormAuthLevel } from '../../utils/public-form-certificate';
import { getDocumentCertificateAuditLogs } from '../document/get-document-certificate-audit-logs';
import { getCertificateAttachedFiles } from '../field-file/field-file-access';
import { getOrganisationClaimByTeamId } from '../organisation/get-organisation-claims';
import { getPublicFormVerificationByRecipient } from '../public-form/public-form-responses';
import { renderAttachedFilesCertificate } from './render-attached-files-certificate';
import { renderCertificate } from './render-certificate';

export type GenerateCertificatePdfOptions = {
  /**
   * Note: completedAt is not included since it's not real at this point in time.
   *
   * If we actually need it here in the future, we will need to preserve the
   * completedAt value and pass it to the final `envelope.update` function when
   * the document is initially sealed.
   */
  envelope: Omit<Envelope, 'completedAt'> & {
    documentMeta: DocumentMeta;
  };
  envelopeOwner: {
    name: string;
    email: string;
  };
  recipients: Recipient[];
  fields: (Pick<Field, 'id' | 'type' | 'secondaryId' | 'recipientId'> & {
    signature?: Pick<Signature, 'signatureImageAsBase64' | 'typedSignature'> | null;
  })[];
  language?: string;
  pageWidth: number;
  pageHeight: number;
};

export const generateCertificatePdf = async (options: GenerateCertificatePdfOptions) => {
  const { envelope, envelopeOwner, recipients, fields, language, pageWidth, pageHeight } = options;

  const documentLanguage = ZSupportedLanguageCodeSchema.parse(language);

  const [organisationClaim, auditLogs, messages] = await Promise.all([
    getOrganisationClaimByTeamId({ teamId: envelope.teamId }),
    getDocumentCertificateAuditLogs({
      envelopeId: envelope.id,
    }),
    getTranslations(documentLanguage),
  ]);

  i18n.loadAndActivate({
    locale: documentLanguage,
    messages,
  });

  const publicFormVerification = await getPublicFormVerificationByRecipient(envelope.id);

  const payload = {
    recipients: recipients.map((recipient) => {
      const recipientId = recipient.id;

      const signatureField = fields.find(
        (field) => field.recipientId === recipient.id && field.type === FieldType.SIGNATURE,
      );

      const emailSent: TDocumentAuditLogBaseSchema | undefined = auditLogs['EMAIL_SENT'].find(
        (log) => log.type === 'EMAIL_SENT' && log.data.recipientId === recipientId,
      );

      const smsSent: TDocumentAuditLogBaseSchema | undefined = auditLogs['SMS_SENT'].find(
        (log) => log.type === 'SMS_SENT' && log.data.recipientId === recipientId,
      );

      const documentSent: TDocumentAuditLogBaseSchema | undefined = auditLogs['DOCUMENT_SENT'].find(
        (log) => log.type === 'DOCUMENT_SENT',
      );

      const documentOpened: TDocumentAuditLogBaseSchema | undefined = auditLogs['DOCUMENT_OPENED'].find(
        (log) => log.type === 'DOCUMENT_OPENED' && log.data.recipientId === recipientId,
      );

      const documentRecipientCompleted: TDocumentAuditLogBaseSchema | undefined = auditLogs[
        'DOCUMENT_RECIPIENT_COMPLETED'
      ].find((log) => log.type === 'DOCUMENT_RECIPIENT_COMPLETED' && log.data.recipientId === recipientId);

      const documentRecipientRejected: TDocumentAuditLogBaseSchema | undefined = auditLogs[
        'DOCUMENT_RECIPIENT_REJECTED'
      ].find((log) => log.type === 'DOCUMENT_RECIPIENT_REJECTED' && log.data.recipientId === recipientId);

      const extractedAuthMethods = extractDocumentAuthMethods({
        documentAuth: envelope.authOptions,
        recipientAuth: recipient.authOptions,
      });

      const insertedAuditLogsWithFieldAuth = sortBy(
        auditLogs.DOCUMENT_FIELD_INSERTED.filter(
          (log) => log.data.recipientId === recipient.id && log.data.fieldSecurity,
        ),
        [prop('createdAt'), 'desc'],
      );

      const actionAuthMethod = insertedAuditLogsWithFieldAuth.at(0)?.data?.fieldSecurity?.type;

      // Solid Ten Sign (FINDINGS 11): "no action auth" no longer hides the access check.
      let authLevel = i18n._(
        CERTIFICATE_AUTH_LEVEL_LABELS[
          getCertificateAuthLevel({
            actionAuth: actionAuthMethod,
            // Solid Ten (AUD-8): the access recorded when the recipient acted; older documents
            // without that record print the settings at seal time, as before.
            accessAuth: (
              getRecordedAccessAuth(
                [...auditLogs.DOCUMENT_RECIPIENT_COMPLETED, ...auditLogs.DOCUMENT_RECIPIENT_REJECTED],
                recipientId,
              ) ?? extractedAuthMethods.derivedRecipientAccessAuth
            ).at(0),
          })
        ],
      );

      authLevel = formatPublicFormAuthLevel(publicFormVerification.get(recipient.id), i18n) ?? authLevel;

      return {
        id: recipient.id,
        name: recipient.name,
        email: recipient.email,
        role: recipient.role,
        signingStatus: recipient.signingStatus,
        signatureField,
        rejectionReason: recipient.rejectionReason,
        authLevel,
        inPersonHost: getInPersonHostFromAuditLog(
          auditLogs.DOCUMENT_RECIPIENT_COMPLETED.find((log) => log.data.recipientId === recipientId) ??
            auditLogs.DOCUMENT_RECIPIENT_REJECTED.find((log) => log.data.recipientId === recipientId),
        ),
        logs: {
          emailed: emailSent ?? null,
          texted: smsSent ?? null,
          sent: documentSent ?? null,
          opened: documentOpened ?? null,
          completed: documentRecipientCompleted ?? null,
          rejected: documentRecipientRejected ?? null,
        },
      };
    }),
    envelopeOwner,
    envelopeId: envelope.id,
    qrToken: envelope.qrToken,
    hidePoweredBy: organisationClaim.flags.hidePoweredBy ?? false,
    pageWidth,
    pageHeight,
    i18n,
  };

  const certificatePages = await renderCertificate(payload);

  // Solid Ten: files signers attached get their own pages after the signer table.
  const attachedFilePages = await renderAttachedFilesCertificate({
    files: await getCertificateAttachedFiles(envelope.id),
    envelopeId: envelope.id,
    i18n,
    pageWidth,
    pageHeight,
  });

  return await PDF.merge([...certificatePages, ...attachedFilePages]);
};
