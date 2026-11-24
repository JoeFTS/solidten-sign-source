import { getServerLimits } from '@documenso/ee/server-only/limits/server';
import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { DATE_FORMATS, DEFAULT_DOCUMENT_DATE_FORMAT } from '@documenso/lib/constants/date-formats';
import { DocumentDataType, DocumentStatus, EnvelopeType, SigningStatus } from '@prisma/client';
import { tsr } from '@ts-rest/serverless/fetch';
import { match } from 'ts-pattern';
import '@documenso/lib/constants/time-zones';
import { DEFAULT_DOCUMENT_TIME_ZONE, TIME_ZONES } from '@documenso/lib/constants/time-zones';
import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { assertActionAuthAllowed } from '@documenso/lib/server-only/auth/assert-action-auth-allowed';
import { deleteDocument } from '@documenso/lib/server-only/document/delete-document';
import { findDocuments } from '@documenso/lib/server-only/document/find-documents';
import { resendDocument } from '@documenso/lib/server-only/document/resend-document';
import { sendDocument } from '@documenso/lib/server-only/document/send-document';
import { createDocumentData } from '@documenso/lib/server-only/document-data/create-document-data';
import { updateDocumentMeta } from '@documenso/lib/server-only/document-meta/upsert-document-meta';
import { assertEnvelopeMutable } from '@documenso/lib/server-only/envelope/assert-envelope-mutable';
import { createEnvelope } from '@documenso/lib/server-only/envelope/create-envelope';
import { getEnvelopeById, getEnvelopeWhereInput } from '@documenso/lib/server-only/envelope/get-envelope-by-id';
import { deleteDocumentField } from '@documenso/lib/server-only/field/delete-document-field';
import { updateEnvelopeFields } from '@documenso/lib/server-only/field/update-envelope-fields';
import {
  assertFieldLogicAllowed,
  toFieldLogicDefinitions,
} from '@documenso/lib/server-only/field-logic/assert-field-logic';
import { createEnvelopeRecipients } from '@documenso/lib/server-only/recipient/create-envelope-recipients';
import { deleteEnvelopeRecipient } from '@documenso/lib/server-only/recipient/delete-envelope-recipient';
import { getRecipientsForDocument } from '@documenso/lib/server-only/recipient/get-recipients-for-document';
import { setDocumentRecipients } from '@documenso/lib/server-only/recipient/set-document-recipients';
import { updateEnvelopeRecipients } from '@documenso/lib/server-only/recipient/update-envelope-recipients';
import { createDocumentFromTemplate } from '@documenso/lib/server-only/template/create-document-from-template';
import { deleteTemplate } from '@documenso/lib/server-only/template/delete-template';
import { findTemplates } from '@documenso/lib/server-only/template/find-templates';
import { getTemplateById } from '@documenso/lib/server-only/template/get-template-by-id';
import { extractDerivedDocumentEmailSettings } from '@documenso/lib/types/document-email';
import {
  ZCheckboxFieldMeta,
  ZDropdownFieldMeta,
  ZFieldMetaSchema,
  ZNumberFieldMeta,
  ZRadioFieldMeta,
  ZTextFieldMeta,
} from '@documenso/lib/types/field-meta';
import { getFileServerSide } from '@documenso/lib/universal/upload/get-file.server';
import { putNormalizedPdfFileServerSide } from '@documenso/lib/universal/upload/put-file.server';
import { getPresignGetUrl, getPresignPostUrl } from '@documenso/lib/universal/upload/server-actions';
import { isDocumentCompleted } from '@documenso/lib/utils/document';
import { createDocumentAuditLogData } from '@documenso/lib/utils/document-audit-logs';
import { mapSecondaryIdToDocumentId, mapSecondaryIdToTemplateId } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import { ApiContractV1 } from './contract';
import { authenticatedMiddleware } from './middleware/authenticated';

/**
 * Solid Ten Sign (O-F2): API v1 writes a request's authOptions straight onto the new document.
 * They pass the same action-auth check as every other path (plan flag, PASSWORD with password
 * sign-in off).
 */
const assertV1AuthOptionsAllowed = async (
  teamId: number,
  authOptions: { globalActionAuth?: readonly (string | null)[] | null } | null | undefined,
) => {
  if (!authOptions?.globalActionAuth?.length) {
    return;
  }

  const { organisation } = await prisma.team.findUniqueOrThrow({
    where: { id: teamId },
    select: { organisation: { select: { organisationClaim: true } } },
  });

  assertActionAuthAllowed({ next: authOptions.globalActionAuth, organisationClaim: organisation.organisationClaim });
};

/**
 * Solid Ten Sign (Q-3): whether a field or recipient is on the DOCUMENT with this legacy id, in
 * this team. Never a template: "documentId" only matches "document_<n>".
 */
const findV1DocumentOwning = async (
  userId: number,
  teamId: number,
  legacyDocumentId: string,
  item: { fieldId: number } | { recipientId: number },
): Promise<'ok' | 'no-document' | 'not-on-document'> => {
  const id = Number(legacyDocumentId);

  if (!Number.isInteger(id) || id <= 0) {
    return 'no-document';
  }

  const envelope = await getEnvelopeById({
    id: { type: 'documentId', id },
    type: EnvelopeType.DOCUMENT,
    userId,
    teamId,
  }).catch(() => null);

  if (!envelope) {
    return 'no-document';
  }

  const count =
    'fieldId' in item
      ? await prisma.field.count({ where: { id: item.fieldId, envelopeId: envelope.id } })
      : await prisma.recipient.count({ where: { id: item.recipientId, envelopeId: envelope.id } });

  return count > 0 ? 'ok' : 'not-on-document';
};

export const ApiContractV1Implementation = tsr.router(ApiContractV1, {
  getDocuments: authenticatedMiddleware(async (args, user, team) => {
    const page = Number(args.query.page) || 1;
    const perPage = Number(args.query.perPage) || 10;

    const { data: documents, totalPages } = await findDocuments({
      page,
      perPage,
      userId: user.id,
      teamId: team.id,
      folderId: args.query.folderId,
    });

    return {
      status: 200,
      body: {
        documents: documents.map((document) => ({
          id: mapSecondaryIdToDocumentId(document.secondaryId),
          externalId: document.externalId,
          userId: document.userId,
          teamId: document.teamId,
          folderId: document.folderId,
          title: document.title,
          status: document.status,
          createdAt: document.createdAt,
          updatedAt: document.updatedAt,
          completedAt: document.completedAt,
        })),
        totalPages,
      },
    };
  }),

  getDocument: authenticatedMiddleware(async (args, user, team, { logger }) => {
    const { id: documentId } = args.params;

    logger.info({
      input: {
        id: documentId,
      },
    });

    try {
      const { envelopeWhereInput } = await getEnvelopeWhereInput({
        id: {
          type: 'documentId',
          id: Number(documentId),
        },
        type: EnvelopeType.DOCUMENT,
        userId: user.id,
        teamId: team.id,
      });

      const envelope = await prisma.envelope.findFirstOrThrow({
        where: envelopeWhereInput,
        include: {
          recipients: {
            orderBy: {
              id: 'asc',
            },
          },
          fields: {
            include: {
              signature: true,
              recipient: {
                select: {
                  name: true,
                  email: true,
                  signingStatus: true,
                },
              },
            },
            orderBy: {
              id: 'asc',
            },
          },
        },
      });

      const { fields, recipients } = envelope;

      const parsedMetaFields = fields.map((field) => {
        let parsedMetaOrNull = null;

        if (field.fieldMeta) {
          const result = ZFieldMetaSchema.safeParse(field.fieldMeta);

          if (!result.success) {
            throw new Error('Field meta parsing failed for field ' + field.id);
          }

          parsedMetaOrNull = result.data;
        }

        return {
          ...field,
          fieldMeta: parsedMetaOrNull,
        };
      });

      const legacyDocumentId = mapSecondaryIdToDocumentId(envelope.secondaryId);

      return {
        status: 200,
        body: {
          id: legacyDocumentId,
          externalId: envelope.externalId,
          userId: envelope.userId,
          teamId: envelope.teamId,
          folderId: envelope.folderId,
          title: envelope.title,
          status: envelope.status,
          createdAt: envelope.createdAt,
          updatedAt: envelope.updatedAt,
          completedAt: envelope.completedAt,
          recipients: recipients.map((recipient) => ({
            id: recipient.id,
            documentId: legacyDocumentId,
            email: recipient.email,
            name: recipient.name,
            role: recipient.role,
            signingOrder: recipient.signingOrder,
            token: recipient.token,
            signedAt: recipient.signedAt,
            readStatus: recipient.readStatus,
            signingStatus: recipient.signingStatus,
            sendStatus: recipient.sendStatus,
            signingUrl: `${NEXT_PUBLIC_WEBAPP_URL()}/sign/${recipient.token}`,
          })),
          fields: parsedMetaFields,
        },
      };
    } catch (err) {
      return {
        status: 404,
        body: {
          message: 'Document not found',
        },
      };
    }
  }),

  downloadSignedDocument: authenticatedMiddleware(async (args, user, team, { logger }) => {
    const { id: documentId } = args.params;
    const { downloadOriginalDocument } = args.query;

    logger.info({
      input: {
        id: documentId,
      },
    });

    try {
      const envelope = await getEnvelopeById({
        id: {
          type: 'documentId',
          id: Number(documentId),
        },
        type: EnvelopeType.DOCUMENT,
        userId: user.id,
        teamId: team.id,
      }).catch(() => null);

      const firstDocumentData = envelope?.envelopeItems[0]?.documentData;

      if (!envelope || !firstDocumentData) {
        return {
          status: 404,
          body: {
            message: 'Document not found',
          },
        };
      }

      // This error is done AFTER the get envelope so we can test access controls without S3.
      if (process.env.NEXT_PUBLIC_UPLOAD_TRANSPORT !== 's3') {
        return {
          status: 500,
          body: {
            message: 'Document downloads are only available when S3 storage is configured.',
          },
        };
      }

      if (DocumentDataType.S3_PATH !== firstDocumentData.type) {
        return {
          status: 400,
          body: {
            message: 'Invalid document data type',
          },
        };
      }

      // A cancelled document was never sealed, so its data is the unsigned original.
      // Treat it as not-completed here so a "signed" version is never served for it.
      // REJECTED and COMPLETED keep their prior behavior.
      const hasSignedArtifact = isDocumentCompleted(envelope.status) && envelope.status !== DocumentStatus.CANCELLED;

      if (!downloadOriginalDocument && !hasSignedArtifact) {
        return {
          status: 400,
          body: {
            message: 'Document is not completed yet.',
          },
        };
      }

      if (envelope.envelopeItems.length !== 1) {
        return {
          status: 400,
          body: {
            message: 'API V1 does not support items',
          },
        };
      }

      const { url } = await getPresignGetUrl(
        downloadOriginalDocument ? firstDocumentData.initialData : firstDocumentData.data,
      );

      return {
        status: 200,
        body: { downloadUrl: url },
      };
    } catch (err) {
      return {
        status: 500,
        body: {
          message: 'Error downloading the document. Please try again.',
        },
      };
    }
  }),

  deleteDocument: authenticatedMiddleware(async (args, user, team, { logger, metadata }) => {
    const { id: documentId } = args.params;

    logger.info({
      input: {
        id: documentId,
      },
    });

    try {
      const legacyDocumentId = Number(documentId);

      const envelope = await getEnvelopeById({
        id: {
          type: 'documentId',
          id: legacyDocumentId,
        },
        type: EnvelopeType.DOCUMENT,
        userId: user.id,
        teamId: team.id,
      });

      if (!envelope) {
        return {
          status: 404,
          body: {
            message: 'Document not found',
          },
        };
      }

      const deletedDocument = await deleteDocument({
        id: {
          type: 'documentId',
          id: legacyDocumentId,
        },
        userId: user.id,
        teamId: team.id,
        requestMetadata: metadata,
      });

      return {
        status: 200,
        body: {
          id: legacyDocumentId,
          externalId: deletedDocument.externalId,
          userId: deletedDocument.userId,
          teamId: deletedDocument.teamId,
          title: deletedDocument.title,
          status: deletedDocument.status,
          createdAt: deletedDocument.createdAt,
          updatedAt: deletedDocument.updatedAt,
          completedAt: deletedDocument.completedAt,
        },
      };
    } catch (err) {
      return {
        status: 404,
        body: {
          message: 'Document not found',
        },
      };
    }
  }),

  createDocument: authenticatedMiddleware(async (args, user, team, { metadata }) => {
    const { body } = args;

    try {
      if (process.env.NEXT_PUBLIC_UPLOAD_TRANSPORT !== 's3') {
        return {
          status: 500,
          body: {
            message: 'Create document is not available without S3 transport.',
          },
        };
      }

      const { remaining } = await getServerLimits({ userId: user.id, teamId: team.id });

      if (remaining.documents <= 0) {
        return {
          status: 400,
          body: {
            message: 'You have reached the maximum number of documents allowed for this month',
          },
        };
      }

      const dateFormat = body.meta.dateFormat
        ? DATE_FORMATS.find((format) => format.value === body.meta.dateFormat)
        : DATE_FORMATS.find((format) => format.value === DEFAULT_DOCUMENT_DATE_FORMAT);

      if (body.meta.dateFormat && !dateFormat) {
        return {
          status: 400,
          body: {
            message: 'Invalid date format. Please provide a valid date format',
          },
        };
      }

      const timezone = body.meta.timezone
        ? TIME_ZONES.find((tz) => tz === body.meta.timezone)
        : DEFAULT_DOCUMENT_TIME_ZONE;

      const isTimeZoneValid = body.meta.timezone ? TIME_ZONES.includes(String(timezone)) : true;

      if (!isTimeZoneValid) {
        return {
          status: 400,
          body: {
            message: 'Invalid timezone. Please provide a valid timezone',
          },
        };
      }

      const fileName = body.title.endsWith('.pdf') ? body.title : `${body.title}.pdf`;

      const { url, key } = await getPresignPostUrl(fileName, 'application/pdf');

      const documentData = await createDocumentData({
        data: key,
        type: DocumentDataType.S3_PATH,
      });

      const envelope = await createEnvelope({
        userId: user.id,
        teamId: team.id,
        internalVersion: 1,
        data: {
          title: body.title,
          type: EnvelopeType.DOCUMENT,
          externalId: body.externalId || undefined,
          formValues: body.formValues,
          folderId: body.folderId,
          envelopeItems: [
            {
              documentDataId: documentData.id,
            },
          ],
          globalAccessAuth: body.authOptions?.globalAccessAuth,
          globalActionAuth: body.authOptions?.globalActionAuth,
        },
        attachments: body.attachments,
        meta: {
          subject: body.meta.subject,
          message: body.meta.message,
          timezone,
          dateFormat: dateFormat?.value,
          redirectUrl: body.meta.redirectUrl,
          signingOrder: body.meta.signingOrder,
          allowDictateNextSigner: body.meta.allowDictateNextSigner,
          language: body.meta.language,
          typedSignatureEnabled: body.meta.typedSignatureEnabled,
          uploadSignatureEnabled: body.meta.uploadSignatureEnabled,
          drawSignatureEnabled: body.meta.drawSignatureEnabled,
          distributionMethod: body.meta.distributionMethod,
          emailSettings: body.meta.emailSettings,
        },
        requestMetadata: metadata,
      });

      const legacyDocumentId = mapSecondaryIdToDocumentId(envelope.secondaryId);

      const { recipients } = await setDocumentRecipients({
        userId: user.id,
        teamId: team.id,
        id: {
          type: 'documentId',
          id: legacyDocumentId,
        },
        recipients: body.recipients,
        requestMetadata: metadata,
      });

      return {
        status: 200,
        body: {
          uploadUrl: url,
          documentId: legacyDocumentId,
          recipients: recipients.map((recipient) => ({
            recipientId: recipient.id,
            name: recipient.name,
            email: recipient.email,
            token: recipient.token,
            role: recipient.role,
            signingOrder: recipient.signingOrder,
            signingUrl: `${NEXT_PUBLIC_WEBAPP_URL()}/sign/${recipient.token}`,
          })),
        },
      };
    } catch (err) {
      return {
        status: 404,
        body: {
          message: 'An error has occured while uploading the file',
        },
      };
    }
  }),

  createTemplate: authenticatedMiddleware(async (args, user, team, { metadata }) => {
    const { body } = args;
    const {
      title,
      folderId,
      externalId,
      visibility,
      globalAccessAuth,
      globalActionAuth,
      publicTitle,
      publicDescription,
      type,
      meta,
      attachments,
    } = body;

    try {
      if (process.env.NEXT_PUBLIC_UPLOAD_TRANSPORT !== 's3') {
        return {
          status: 500,
          body: {
            message: 'Create template is not available without S3 transport.',
          },
        };
      }

      const dateFormat = meta?.dateFormat
        ? DATE_FORMATS.find((format) => format.value === meta?.dateFormat)
        : DATE_FORMATS.find((format) => format.value === DEFAULT_DOCUMENT_DATE_FORMAT);

      if (meta?.dateFormat && !dateFormat) {
        return {
          status: 400,
          body: {
            message: 'Invalid date format. Please provide a valid date format',
          },
        };
      }

      const timezone = meta?.timezone ? TIME_ZONES.find((tz) => tz === meta?.timezone) : DEFAULT_DOCUMENT_TIME_ZONE;

      const isTimeZoneValid = meta?.timezone ? TIME_ZONES.includes(String(timezone)) : true;

      if (!isTimeZoneValid) {
        return {
          status: 400,
          body: {
            message: 'Invalid timezone. Please provide a valid timezone',
          },
        };
      }

      const fileName = title?.endsWith('.pdf') ? title : `${title}.pdf`;

      const { url, key } = await getPresignPostUrl(fileName, 'application/pdf');

      const templateDocumentData = await createDocumentData({
        data: key,
        type: DocumentDataType.S3_PATH,
      });

      const createdTemplate = await createEnvelope({
        userId: user.id,
        teamId: team.id,
        internalVersion: 1,
        data: {
          type: EnvelopeType.TEMPLATE,
          envelopeItems: [
            {
              documentDataId: templateDocumentData.id,
            },
          ],
          templateType: type,
          title,
          folderId,
          externalId: externalId ?? undefined,
          visibility,
          globalAccessAuth,
          globalActionAuth,
          publicTitle,
          publicDescription,
        },
        meta,
        attachments,
        requestMetadata: metadata,
      });

      const fullTemplate = await getTemplateById({
        id: {
          type: 'envelopeId',
          id: createdTemplate.id,
        },
        userId: user.id,
        teamId: team.id,
      });

      return {
        status: 200,
        body: {
          uploadUrl: url,
          template: fullTemplate,
        },
      };
    } catch (err) {
      return {
        status: 404,
        body: {
          message: 'An error has occured while creating the template',
        },
      };
    }
  }),

  deleteTemplate: authenticatedMiddleware(async (args, user, team, { logger }) => {
    const { id: templateId } = args.params;

    logger.info({
      input: {
        id: templateId,
      },
    });

    try {
      const deletedTemplate = await deleteTemplate({
        id: {
          type: 'templateId',
          id: Number(templateId),
        },
        userId: user.id,
        teamId: team.id,
      });

      const legacyTemplateId = mapSecondaryIdToTemplateId(deletedTemplate.secondaryId);

      return {
        status: 200,
        body: {
          id: legacyTemplateId,
          externalId: deletedTemplate.externalId,
          type: deletedTemplate.templateType,
          title: deletedTemplate.title,
          userId: deletedTemplate.userId,
          teamId: deletedTemplate.teamId,
          createdAt: deletedTemplate.createdAt,
          updatedAt: deletedTemplate.updatedAt,
        },
      };
    } catch (err) {
      return {
        status: 404,
        body: {
          message: 'Template not found',
        },
      };
    }
  }),

  getTemplate: authenticatedMiddleware(async (args, user, team, { logger }) => {
    const { id: templateId } = args.params;

    logger.info({
      input: {
        id: templateId,
      },
    });

    try {
      const template = await getTemplateById({
        id: {
          type: 'templateId',
          id: Number(templateId),
        },
        userId: user.id,
        teamId: team.id,
      });

      return {
        status: 200,
        body: {
          ...template,
          templateMeta: template.templateMeta
            ? {
                ...template.templateMeta,
                templateId: template.id,
              }
            : null,
          Field: template.fields.map((field) => ({
            ...field,
            fieldMeta: field.fieldMeta ? ZFieldMetaSchema.parse(field.fieldMeta) : null,
          })),
          Recipient: template.recipients,
        },
      };
    } catch (err) {
      return AppError.toRestAPIError(err);
    }
  }),

  getTemplates: authenticatedMiddleware(async (args, user, team) => {
    const page = Number(args.query.page) || 1;
    const perPage = Number(args.query.perPage) || 10;

    try {
      const { data: templates, totalPages } = await findTemplates({
        page,
        perPage,
        userId: user.id,
        teamId: team.id,
      });

      return {
        status: 200,
        body: {
          templates: templates.map((template) => ({
            id: mapSecondaryIdToTemplateId(template.secondaryId),
            externalId: template.externalId,
            type: template.templateType,
            title: template.title,
            userId: template.userId,
            teamId: template.teamId,
            createdAt: template.createdAt,
            updatedAt: template.updatedAt,
            directLink: template.directLink,
            Field: template.fields.map((field) => ({
              ...field,
              templateId: mapSecondaryIdToTemplateId(template.secondaryId),
              fieldMeta: field.fieldMeta ? ZFieldMetaSchema.parse(field.fieldMeta) : null,
            })),
            Recipient: template.recipients,
          })),
          totalPages,
        },
      };
    } catch (err) {
      return AppError.toRestAPIError(err);
    }
  }),

  createDocumentFromTemplate: authenticatedMiddleware(async (args, user, team, { logger, metadata }) => {
    const { body, params } = args;

    logger.info({
      input: {
        templateId: params.templateId,
      },
    });

    const { remaining } = await getServerLimits({ userId: user.id, teamId: team.id });

    if (remaining.documents <= 0) {
      return {
        status: 400,
        body: {
          message: 'You have reached the maximum number of documents allowed for this month',
        },
      };
    }

    const templateId = Number(params.templateId);

    const fileName = body.title.endsWith('.pdf') ? body.title : `${body.title}.pdf`;

    const template = await getEnvelopeById({
      id: {
        type: 'templateId',
        id: templateId,
      },
      type: EnvelopeType.TEMPLATE,
      userId: user.id,
      teamId: team.id,
    });

    if (template.envelopeItems.length !== 1) {
      throw new Error('API V1 does not support templates with multiple documents');
    }

    // V1 API request schema uses indices for recipients
    // So we remap the recipients to attach the IDs
    const mappedRecipients = body.recipients.map((recipient, index) => {
      const existingRecipient = template.recipients.at(index);

      if (!existingRecipient) {
        throw new Error('Recipient not found.');
      }

      return {
        id: existingRecipient.id,
        name: recipient.name,
        email: recipient.email,
        signingOrder: recipient.signingOrder,
        role: recipient.role, // You probably shouldn't be able to change the role.
      };
    });

    // Solid Ten Sign (O-F2): the one action-auth check, for the authOptions this route writes.
    await assertV1AuthOptionsAllowed(team.id, body.authOptions);

    const createdEnvelope = await createDocumentFromTemplate({
      id: {
        type: 'templateId',
        id: templateId,
      },
      externalId: body.externalId || null,
      userId: user.id,
      teamId: team.id,
      recipients: mappedRecipients,
      override: {
        ...body.meta,
        title: body.title,
      },
      attachments: body.attachments,
      formValues: body.formValues,
      requestMetadata: metadata,
    });

    const envelopeItems = await prisma.envelopeItem.findMany({
      where: {
        envelopeId: createdEnvelope.id,
      },
      include: {
        documentData: true,
      },
    });

    const firstEnvelopeItemData = envelopeItems[0].documentData;

    if (!firstEnvelopeItemData) {
      throw new Error('Document data not found.');
    }

    if (body.formValues) {
      const pdf = await getFileServerSide(firstEnvelopeItemData);

      // Solid Ten (AUD-5): the form values are filled in the PDF child, with the normalisation.
      const { documentData: newDocumentData } = await putNormalizedPdfFileServerSide(
        { name: fileName, type: 'application/pdf', arrayBuffer: async () => Promise.resolve(Buffer.from(pdf)) },
        { formValues: body.formValues },
      );

      await prisma.envelopeItem.update({
        where: {
          id: firstEnvelopeItemData.id,
        },
        data: {
          title: body.title || fileName,
          documentDataId: newDocumentData.id,
        },
      });
    }

    if (body.authOptions || body.formValues) {
      await prisma.envelope.update({
        where: {
          id: createdEnvelope.id,
        },
        data: {
          formValues: body.formValues,
          authOptions: body.authOptions,
        },
      });
    }

    return {
      status: 200,
      body: {
        documentId: mapSecondaryIdToDocumentId(createdEnvelope.secondaryId),
        recipients: createdEnvelope.recipients.map((recipient) => ({
          recipientId: recipient.id,
          name: recipient.name,
          email: recipient.email,
          token: recipient.token,
          role: recipient.role,
          signingOrder: recipient.signingOrder,

          signingUrl: `${NEXT_PUBLIC_WEBAPP_URL()}/sign/${recipient.token}`,
        })),
      },
    };
  }),

  generateDocumentFromTemplate: authenticatedMiddleware(async (args, user, team, { logger, metadata }) => {
    const { body, params } = args;

    logger.info({
      input: {
        templateId: params.templateId,
      },
    });

    const { remaining } = await getServerLimits({ userId: user.id, teamId: team.id });

    if (remaining.documents <= 0) {
      return {
        status: 400,
        body: {
          message: 'You have reached the maximum number of documents allowed for this month',
        },
      };
    }

    const templateId = Number(params.templateId);

    let envelope: Awaited<ReturnType<typeof createDocumentFromTemplate>> | null = null;

    try {
      // Solid Ten Sign (O-F2): the one action-auth check, for the authOptions this route writes
      // (before: accepted PASSWORD with password sign-in off, and skipped the plan check).
      await assertV1AuthOptionsAllowed(team.id, body.authOptions);

      envelope = await createDocumentFromTemplate({
        id: {
          type: 'templateId',
          id: templateId,
        },
        externalId: body.externalId || null,
        userId: user.id,
        teamId: team.id,
        recipients: body.recipients,
        prefillFields: body.prefillFields,
        folderId: body.folderId,
        override: {
          title: body.title,
          ...body.meta,
        },
        formValues: body.formValues,
        requestMetadata: metadata,
      });
    } catch (err) {
      return AppError.toRestAPIError(err);
    }

    if (body.authOptions) {
      await prisma.envelope.update({
        where: {
          id: envelope.id,
        },
        data: {
          authOptions: body.authOptions,
        },
      });
    }

    const legacyDocumentId = mapSecondaryIdToDocumentId(envelope.secondaryId);

    return {
      status: 200,
      body: {
        documentId: legacyDocumentId,
        recipients: envelope.recipients.map((recipient) => ({
          recipientId: recipient.id,
          name: recipient.name,
          email: recipient.email,
          token: recipient.token,
          role: recipient.role,
          signingOrder: recipient.signingOrder,
          signingUrl: `${NEXT_PUBLIC_WEBAPP_URL()}/sign/${recipient.token}`,
        })),
      },
    };
  }),

  sendDocument: authenticatedMiddleware(async (args, user, team, { logger, metadata }) => {
    const { id: documentId } = args.params;
    const { sendEmail, sendCompletionEmails } = args.body;

    logger.info({
      input: {
        id: documentId,
      },
    });

    try {
      const legacyDocumentId = Number(documentId);

      const envelope = await getEnvelopeById({
        id: {
          type: 'documentId',
          id: legacyDocumentId,
        },
        type: EnvelopeType.DOCUMENT,
        userId: user.id,
        teamId: team.id,
      });

      if (!envelope) {
        return {
          status: 404,
          body: {
            message: 'Document not found',
          },
        };
      }

      if (isDocumentCompleted(envelope.status)) {
        return {
          status: 400,
          body: {
            message: 'Document is already complete',
          },
        };
      }

      const emailSettings = extractDerivedDocumentEmailSettings(envelope.documentMeta);

      // Update document email settings if sendCompletionEmails is provided
      if (typeof sendCompletionEmails === 'boolean') {
        await updateDocumentMeta({
          id: {
            type: 'envelopeId',
            id: envelope.id,
          },
          userId: user.id,
          teamId: team.id,
          emailSettings: {
            ...emailSettings,
            documentCompleted: sendCompletionEmails,
            ownerDocumentCompleted: sendCompletionEmails,
          },
          requestMetadata: metadata,
        });
      }

      const { recipients, ...sentDocument } = await sendDocument({
        id: {
          type: 'envelopeId',
          id: envelope.id,
        },
        userId: user.id,
        teamId: team.id,
        sendEmail,
        requestMetadata: metadata,
      });

      return {
        status: 200,
        body: {
          message: 'Document sent for signing successfully',
          id: mapSecondaryIdToDocumentId(sentDocument.secondaryId),
          externalId: sentDocument.externalId,
          userId: sentDocument.userId,
          teamId: sentDocument.teamId,
          title: sentDocument.title,
          status: sentDocument.status,
          createdAt: sentDocument.createdAt,
          updatedAt: sentDocument.updatedAt,
          completedAt: sentDocument.completedAt,
          recipients: recipients.map((recipient) => ({
            ...recipient,
            signingUrl: `${NEXT_PUBLIC_WEBAPP_URL()}/sign/${recipient.token}`,
          })),
        },
      };
    } catch (err) {
      return AppError.toRestAPIError(err);
    }
  }),

  resendDocument: authenticatedMiddleware(async (args, user, team, { logger, metadata }) => {
    const { id: documentId } = args.params;
    const { recipients } = args.body;

    logger.info({
      input: {
        id: documentId,
      },
    });

    try {
      await resendDocument({
        userId: user.id,
        id: {
          type: 'documentId',
          id: Number(documentId),
        },
        recipients,
        teamId: team.id,
        requestMetadata: metadata,
      });

      return {
        status: 200,
        body: {
          message: 'Document resend successfully initiated',
        },
      };
    } catch (err) {
      // Solid Ten Sign (F4): a refusal the caller can act on (such as an unverified direct-link
      // address) answers 400 with its message, as the web app does. Everything else stays a 500.
      if (AppError.parseError(err).code === AppErrorCode.INVALID_REQUEST) {
        return AppError.toRestAPIError(err);
      }

      return {
        status: 500,
        body: {
          message: 'An error has occured while resending the document',
        },
      };
    }
  }),

  createRecipient: authenticatedMiddleware(async (args, user, team, { logger, metadata }) => {
    const { id: documentId } = args.params;
    const { name, email, role, authOptions, signingOrder } = args.body;

    logger.info({
      input: {
        id: documentId,
      },
    });

    const legacyDocumentId = Number(documentId);

    const envelope = await getEnvelopeById({
      id: {
        type: 'documentId',
        id: legacyDocumentId,
      },
      type: EnvelopeType.DOCUMENT,
      userId: user.id,
      teamId: team.id,
    });

    if (!envelope) {
      return {
        status: 404,
        body: {
          message: 'Document not found',
        },
      };
    }

    // Solid Ten Sign (R): each closed state gives its own reason (before: "Document is already
    // completed" also for a declined or cancelled document).
    if (isDocumentCompleted(envelope.status)) {
      const closedMessage =
        envelope.status === DocumentStatus.REJECTED
          ? 'This document was declined, so recipients can no longer be added.'
          : envelope.status === DocumentStatus.CANCELLED
            ? 'This document was cancelled, so recipients can no longer be added.'
            : 'Document is already completed';

      return {
        status: 400,
        body: {
          message: closedMessage,
        },
      };
    }

    // Solid Ten Sign (Q-4): a recipient can only be added while the document is a draft or waiting
    // for signatures.
    if (envelope.status !== DocumentStatus.DRAFT && envelope.status !== DocumentStatus.PENDING) {
      return {
        status: 400,
        body: {
          message: 'Recipients can only be added to a draft or to a document that is waiting for signatures.',
        },
      };
    }

    const recipients = await getRecipientsForDocument({
      documentId: Number(documentId),
      userId: user.id,
      teamId: team.id,
    });

    const recipientAlreadyExists = recipients.some((recipient) => recipient.email === email.toLowerCase());

    if (recipientAlreadyExists) {
      return {
        status: 400,
        body: {
          message: 'Recipient already exists',
        },
      };
    }

    try {
      // Solid Ten Sign (Q-4): add only the new recipient. Before, the existing recipients were
      // passed to setDocumentRecipients WITHOUT their ids, so each was deleted and re-created: on a
      // sent document the signer got a new id and token, lost their fields and became NOT_SENT,
      // and their emailed link answered 404 (upstream, v2.22.0).
      const { recipients: newRecipients } = await createEnvelopeRecipients({
        id: { type: 'envelopeId', id: envelope.id },
        userId: user.id,
        teamId: team.id,
        recipients: [
          {
            email,
            name,
            role,
            signingOrder,
            actionAuth: authOptions?.actionAuth ?? [],
          },
        ],
        requestMetadata: metadata,
      });

      const newRecipient = newRecipients.find((recipient) => recipient.email === email.toLowerCase());

      if (!newRecipient) {
        throw new Error('Recipient not found');
      }

      return {
        status: 200,
        body: {
          ...newRecipient,
          documentId: Number(documentId),
          signingUrl: `${NEXT_PUBLIC_WEBAPP_URL()}/sign/${newRecipient.token}`,
        },
      };
    } catch (err) {
      // Solid Ten Sign (O-F5): a refusal with a reason (400, or the plan's 401) keeps it; only an
      // unexpected error is the generic 500.
      if (err instanceof AppError) {
        const restError = AppError.toRestAPIError(err);

        if (restError.status === 400 || restError.status === 401 || restError.status === 403) {
          return restError as typeof restError & { status: 400 | 401 | 403 };
        }
      }

      return {
        status: 500,
        body: {
          message: 'An error has occured while creating the recipient',
        },
      };
    }
  }),

  updateRecipient: authenticatedMiddleware(async (args, user, team, { logger, metadata }) => {
    const { id: documentId, recipientId } = args.params;
    const { name, email, role, authOptions, signingOrder } = args.body;

    logger.info({
      input: {
        id: documentId,
        recipientId,
      },
    });

    const legacyDocumentId = Number(documentId);

    const envelope = await getEnvelopeById({
      id: {
        type: 'documentId',
        id: legacyDocumentId,
      },
      type: EnvelopeType.DOCUMENT,
      userId: user.id,
      teamId: team.id,
    });

    if (!envelope) {
      return {
        status: 404,
        body: {
          message: 'Document not found',
        },
      };
    }

    if (isDocumentCompleted(envelope.status)) {
      return {
        status: 400,
        body: {
          message: 'Document is already completed',
        },
      };
    }

    // Solid Ten Sign (O-F8): a recipient that is not on this document is a 404 with that reason
    // (before: the editor's "document changed" text, answered as a 401 by the middleware).
    if (!envelope.recipients.some((recipient) => recipient.id === Number(recipientId))) {
      return {
        status: 404,
        body: {
          message: 'Recipient not found',
        },
      };
    }

    const updatedRecipient = await updateEnvelopeRecipients({
      userId: user.id,
      teamId: team.id,
      id: {
        type: 'envelopeId',
        id: envelope.id,
      },
      recipients: [
        {
          id: Number(recipientId),
          email,
          name,
          role,
          signingOrder,
          actionAuth: authOptions?.actionAuth ?? [],
        },
      ],
      requestMetadata: metadata,
    })
      .then(({ recipients }) => recipients[0])
      .catch(null);

    if (!updatedRecipient) {
      return {
        status: 404,
        body: {
          message: 'Recipient not found',
        },
      };
    }

    return {
      status: 200,
      body: {
        ...updatedRecipient,
        documentId: Number(documentId),
        signingUrl: `${NEXT_PUBLIC_WEBAPP_URL()}/sign/${updatedRecipient.token}`,
      },
    };
  }),

  deleteRecipient: authenticatedMiddleware(async (args, user, team, { logger, metadata }) => {
    const { id: documentId, recipientId } = args.params;

    logger.info({
      input: {
        id: documentId,
        recipientId,
      },
    });

    // Solid Ten Sign (Q-3): the recipient must be on the document the URL names (the document id
    // was not used: a recipient of any envelope of the team, a template's too, could be removed).
    const owner = await findV1DocumentOwning(user.id, team.id, documentId, { recipientId: Number(recipientId) });

    // A document that is not this team's keeps the old answer (401); a recipient not on it is 404.
    if (owner === 'no-document') {
      return { status: 401, body: { message: 'Document not found' } };
    }

    if (owner !== 'ok') {
      return { status: 404, body: { message: 'Recipient not found' } };
    }

    const deletedRecipient = await deleteEnvelopeRecipient({
      userId: user.id,
      teamId: team.id,
      recipientId: Number(recipientId),
      requestMetadata: {
        requestMetadata: metadata.requestMetadata,
        source: 'apiV1',
        auth: 'api',
        auditUser: {
          id: team.id,
          email: team.name,
          name: team.name,
        },
      },
    });

    return {
      status: 200,
      body: {
        ...deletedRecipient,
        documentId: Number(documentId),
        signingUrl: '',
      },
    };
  }),

  createField: authenticatedMiddleware(async (args, user, team, { logger, metadata }) => {
    const { id: documentId } = args.params;

    logger.info({
      input: {
        id: documentId,
      },
    });

    const fields = Array.isArray(args.body) ? args.body : [args.body];

    const { envelopeWhereInput } = await getEnvelopeWhereInput({
      id: {
        type: 'documentId',
        id: Number(documentId),
      },
      type: EnvelopeType.DOCUMENT,
      teamId: team.id,
      userId: user.id,
    });

    const envelope = await prisma.envelope.findFirst({
      where: envelopeWhereInput,
      select: {
        id: true,
        secondaryId: true,
        status: true,
        type: true,
        internalVersion: true,
        signatureLevel: true,
        envelopeItems: {
          select: { id: true },
        },
      },
    });

    if (!envelope) {
      return {
        status: 404,
        body: { message: 'Document not found' },
      };
    }

    const firstEnvelopeItemId = envelope.envelopeItems[0].id;

    if (!firstEnvelopeItemId) {
      throw new Error('Missing envelope item ID');
    }

    if (envelope.envelopeItems.length !== 1) {
      throw new Error('API V1 does not support multiple documents');
    }

    if (isDocumentCompleted(envelope.status)) {
      return {
        status: 400,
        body: { message: 'Document is already completed' },
      };
    }

    try {
      // Solid Ten: the same checks as every v2 field save (number formats and values, field
      // rules, file fields, the AES/QES lock), so v1 is not a way around them.
      await assertEnvelopeMutable(envelope);

      const existingFields = await prisma.field.findMany({ where: { envelopeId: envelope.id } });

      await assertFieldLogicAllowed({
        envelope,
        fields: toFieldLogicDefinitions([
          ...existingFields,
          ...fields.map((fieldData) => ({
            type: fieldData.type,
            recipientId: Number(fieldData.recipientId),
            envelopeItemId: firstEnvelopeItemId,
            pageNumber: fieldData.pageNumber,
            fieldMeta: fieldData.fieldMeta,
          })),
        ]),
        existingFields,
      });

      const createdFields = await prisma.$transaction(async (tx) => {
        return Promise.all(
          fields.map(async (fieldData) => {
            const { recipientId, type, pageNumber, pageWidth, pageHeight, pageX, pageY, fieldMeta } = fieldData;

            if (pageNumber <= 0) {
              throw new AppError(AppErrorCode.INVALID_BODY, { message: 'Invalid page number' });
            }

            const recipient = await tx.recipient.findFirst({
              where: {
                id: Number(recipientId),
                envelopeId: envelope.id,
              },
            });

            if (!recipient) {
              // Solid Ten Sign (R-2b): a recipient of another envelope is a 404, not a 500.
              throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Recipient not found' });
            }

            if (recipient.signingStatus === SigningStatus.SIGNED) {
              throw new AppError(AppErrorCode.INVALID_BODY, { message: 'Recipient has already signed the document' });
            }

            const advancedField = ['NUMBER', 'RADIO', 'CHECKBOX', 'DROPDOWN', 'TEXT'].includes(type);

            if (advancedField && !fieldMeta) {
              throw new AppError(AppErrorCode.INVALID_BODY, {
                message:
                  'Field meta is required for this type of field. Please provide the appropriate field meta object.',
              });
            }

            if (fieldMeta && fieldMeta.type.toLowerCase() !== String(type).toLowerCase()) {
              throw new AppError(AppErrorCode.INVALID_BODY, {
                message: 'Field meta type does not match the field type',
              });
            }

            const result = match(type)
              .with('RADIO', () => ZRadioFieldMeta.safeParse(fieldMeta))
              .with('CHECKBOX', () => ZCheckboxFieldMeta.safeParse(fieldMeta))
              .with('DROPDOWN', () => ZDropdownFieldMeta.safeParse(fieldMeta))
              .with('NUMBER', () => ZNumberFieldMeta.safeParse(fieldMeta))
              .with('TEXT', () => ZTextFieldMeta.safeParse(fieldMeta))
              .with('SIGNATURE', 'INITIALS', 'DATE', 'EMAIL', 'NAME', () => ({
                success: true,
                data: undefined,
              }))
              .with('FREE_SIGNATURE', 'FILE', (type) => ({
                success: false,
                error: `${type} is not supported`,
                data: undefined,
              }))
              .exhaustive();

            if (!result.success) {
              throw new AppError(AppErrorCode.INVALID_BODY, { message: 'Field meta parsing failed' });
            }

            const field = await tx.field.create({
              data: {
                envelopeId: envelope.id,
                envelopeItemId: firstEnvelopeItemId,
                recipientId: Number(recipientId),
                type,
                page: pageNumber,
                positionX: pageX,
                positionY: pageY,
                width: pageWidth,
                height: pageHeight,
                customText: '',
                inserted: false,
                fieldMeta: result.data,
              },
              include: {
                recipient: true,
              },
            });

            await tx.documentAuditLog.create({
              data: createDocumentAuditLogData({
                type: 'FIELD_CREATED',
                envelopeId: envelope.id,
                user: {
                  id: team.id ?? user.id,
                  email: team?.name ?? user.email,
                  name: team ? '' : user.name,
                },
                data: {
                  fieldId: field.secondaryId,
                  fieldRecipientEmail: field.recipient?.email ?? '',
                  fieldRecipientId: recipientId,
                  fieldType: field.type,
                },
                requestMetadata: metadata.requestMetadata,
              }),
            });

            return {
              id: field.id,
              documentId: mapSecondaryIdToDocumentId(envelope.secondaryId),
              recipientId: field.recipientId ?? -1,
              type: field.type,
              pageNumber: field.page,
              pageX: Number(field.positionX),
              pageY: Number(field.positionY),
              pageWidth: Number(field.width),
              pageHeight: Number(field.height),
              customText: field.customText,
              fieldMeta: field.fieldMeta ? ZFieldMetaSchema.parse(field.fieldMeta) : undefined,
              inserted: field.inserted,
            };
          }),
        );
      });

      return {
        status: 200,
        body: {
          fields: createdFields,
          documentId: Number(documentId),
        },
      };
    } catch (err) {
      return AppError.toRestAPIError(err);
    }
  }),

  updateField: authenticatedMiddleware(async (args, user, team, { logger, metadata }) => {
    const { id: documentId, fieldId } = args.params;
    const { recipientId, type, pageNumber, pageWidth, pageHeight, pageX, pageY, fieldMeta } = args.body;

    logger.info({
      input: {
        id: documentId,
        fieldId,
      },
    });

    const envelope = await getEnvelopeById({
      id: {
        type: 'documentId',
        id: Number(documentId),
      },
      type: EnvelopeType.DOCUMENT,
      userId: user.id,
      teamId: team.id,
    });

    if (!envelope) {
      return {
        status: 404,
        body: {
          message: 'Document not found',
        },
      };
    }

    // Solid Ten Sign (Q-3): a field that is not on this document is a 404, not the editor's text.
    if ((await prisma.field.count({ where: { id: Number(fieldId), envelopeId: envelope.id } })) === 0) {
      return {
        status: 404,
        body: {
          message: 'Field not found',
        },
      };
    }

    const legacyDocumentId = mapSecondaryIdToDocumentId(envelope.secondaryId);

    const firstEnvelopeItemId = envelope.envelopeItems[0].id;

    if (!firstEnvelopeItemId) {
      throw new Error('Missing document data');
    }

    if (envelope.envelopeItems.length > 1) {
      throw new Error('API V1 does not support multiple documents');
    }

    if (isDocumentCompleted(envelope.status)) {
      return {
        status: 400,
        body: {
          message: 'Document is already completed',
        },
      };
    }

    const recipient = await prisma.recipient.findFirst({
      where: {
        id: Number(recipientId),
        envelopeId: envelope.id,
      },
    });

    if (!recipient) {
      return {
        status: 404,
        body: {
          message: 'Recipient not found',
        },
      };
    }

    if (recipient.signingStatus === SigningStatus.SIGNED) {
      return {
        status: 400,
        body: {
          message: 'Recipient has already signed the document',
        },
      };
    }

    const { fields } = await updateEnvelopeFields({
      userId: user.id,
      teamId: team.id,
      id: {
        type: 'documentId',
        id: legacyDocumentId,
      },
      fields: [
        {
          id: Number(fieldId),
          type,
          pageNumber,
          pageX,
          pageY,
          width: pageWidth,
          height: pageHeight,
          fieldMeta: fieldMeta ? ZFieldMetaSchema.parse(fieldMeta) : undefined,
        },
      ],
      requestMetadata: {
        requestMetadata: metadata.requestMetadata,
        source: 'apiV1',
        auth: 'api',
        auditUser: {
          id: team.id,
          email: team.name,
          name: team.name,
        },
      },
    });

    const updatedField = fields[0];

    return {
      status: 200,
      body: {
        id: updatedField.id,
        documentId: legacyDocumentId,
        recipientId: updatedField.recipientId ?? -1,
        type: updatedField.type,
        pageNumber: updatedField.page,
        pageX: Number(updatedField.positionX),
        pageY: Number(updatedField.positionY),
        pageWidth: Number(updatedField.width),
        pageHeight: Number(updatedField.height),
        customText: updatedField.customText,
        inserted: updatedField.inserted,
      },
    };
  }),

  deleteField: authenticatedMiddleware(async (args, user, team, { logger, metadata }) => {
    // Note: documentId isn't actually used anywhere, so we just return it.
    const { id: unverifiedDocumentId, fieldId } = args.params;

    logger.info({
      input: {
        id: unverifiedDocumentId,
        fieldId,
      },
    });

    // Solid Ten Sign (Q-3): the field must be on the document the URL names. Before, the document
    // id was not used: a field of any envelope of the team was taken (a template's field, when a
    // document and a template share the legacy number), and a field not on the document answered
    // 500. Template and document legacy numbers are separate counters, so the same number can name
    // both; a v1 document route only ever looks up "document_<n>".
    const owner = await findV1DocumentOwning(user.id, team.id, unverifiedDocumentId, { fieldId: Number(fieldId) });

    // A document that is not this team's keeps the old answer (401), which callers rely on so as
    // not to learn whether it exists; a field that is not on the document is a 404.
    if (owner === 'no-document') {
      return { status: 401, body: { message: 'Document not found' } };
    }

    if (owner !== 'ok') {
      return { status: 404, body: { message: 'Field not found' } };
    }

    const deletedField = await deleteDocumentField({
      fieldId: Number(fieldId),
      userId: user.id,
      teamId: team.id,
      requestMetadata: {
        requestMetadata: metadata.requestMetadata,
        source: 'apiV1',
        auth: 'api',
        auditUser: {
          id: team.id,
          email: team.name,
          name: team.name,
        },
      },
    });

    const remappedField = {
      id: deletedField.id,
      documentId: Number(unverifiedDocumentId),
      recipientId: deletedField.recipientId ?? -1,
      type: deletedField.type,
      pageNumber: deletedField.page,
      pageX: Number(deletedField.positionX),
      pageY: Number(deletedField.positionY),
      pageWidth: Number(deletedField.width),
      pageHeight: Number(deletedField.height),
      customText: deletedField.customText,
      inserted: deletedField.inserted,
    };

    return {
      status: 200,
      body: remappedField,
    };
  }),
});
