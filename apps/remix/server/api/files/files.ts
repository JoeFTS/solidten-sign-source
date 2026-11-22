import { getOptionalNonEmbedSession } from '@documenso/auth/server/lib/session/embed-session-restrictions';
import { APP_DOCUMENT_UPLOAD_SIZE_LIMIT } from '@documenso/lib/constants/app';
import { AppError } from '@documenso/lib/errors/app-error';
import { isDatabaseUnavailableError, toPublicDatabaseError } from '@documenso/lib/errors/database-errors';
import { createServerBusyError, isTransactionTimeoutError, SERVER_BUSY_CODE } from '@documenso/lib/errors/server-busy';
import {
  presignFileTokenReachesEnvelope,
  type VerifiedPresignFileToken,
  verifyPresignFileToken,
} from '@documenso/lib/server-only/embedding-presign/verify-presign-file-token';
import { formatMegabyteLimit, megabytesToBytes } from '@documenso/lib/universal/unit-convertions';
import { putNormalizedPdfFileServerSide } from '@documenso/lib/universal/upload/put-file.server';
import { prisma } from '@documenso/prisma';
import { sValidator } from '@hono/standard-validator';
import type { Prisma } from '@prisma/client';
import { Hono } from 'hono';
import type { HonoEnv } from '../../router';
import { checkEnvelopeFileAccess, handleEnvelopeItemFileRequest, resolveFileUploadUserId } from './files.helpers';
import {
  ZGetEnvelopeItemFileDownloadRequestParamsSchema,
  ZGetEnvelopeItemFileRequestParamsSchema,
  ZGetEnvelopeItemFileRequestQuerySchema,
  ZGetEnvelopeItemFileTokenDownloadRequestParamsSchema,
  ZGetEnvelopeItemFileTokenRequestParamsSchema,
  ZUploadPdfRequestSchema,
  ZUploadPdfResponseSchema,
} from './files.types';
import { resolveRecipientTokenParam } from './in-person-turn-token';
import getDataContentImageRoute from './routes/get-data-content-image';
import getDataContentImageByTokenRoute from './routes/get-data-content-image-by-token';
import getEnvelopeItemPdfRoute from './routes/get-envelope-item-pdf';
import getEnvelopeItemPdfByTokenRoute from './routes/get-envelope-item-pdf-by-token';
import getFieldFileRoute from './routes/get-field-file';
import { canTokenAccessDocument } from './token-document-access';

export const filesRoute = new Hono<HonoEnv>()
  /**
   * Uploads a document file to the appropriate storage location and creates
   * a document data record.
   */
  .post('/upload-pdf', sValidator('form', ZUploadPdfRequestSchema), async (c) => {
    try {
      const userId = await resolveFileUploadUserId(c);

      if (!userId) {
        return c.json({ error: 'Unauthorized' }, 401);
      }

      const { file } = c.req.valid('form');

      if (!file) {
        return c.json({ error: 'No file provided' }, 400);
      }

      // Solid Ten: the same megabyte as every other size check (unit-convertions.ts).
      const MAX_FILE_SIZE = megabytesToBytes(APP_DOCUMENT_UPLOAD_SIZE_LIMIT);

      if (file.size > MAX_FILE_SIZE) {
        return c.json(
          { error: `File cannot be larger than ${formatMegabyteLimit(APP_DOCUMENT_UPLOAD_SIZE_LIMIT)}` },
          400,
        );
      }

      const { documentData } = await putNormalizedPdfFileServerSide(file);

      // Parsed so the response cannot drift from the shape `putPdfFile` reads
      // on the client, and so the file bytes are stripped rather than sent back.
      return c.json(ZUploadPdfResponseSchema.parse(documentData));
    } catch (error) {
      // Solid Ten: busy (the heavy-PDF queue is full, or a transaction ran out of time) is a 503.
      const busy =
        isTransactionTimeoutError(error) || (error instanceof AppError && error.code === SERVER_BUSY_CODE)
          ? createServerBusyError()
          : null;

      if (busy) {
        c.header('Retry-After', busy.headers?.['Retry-After'] ?? '15');

        return c.json({ error: busy.message }, 503);
      }

      // Solid Ten (AUD-2 follow-up): a file the PDF child cannot process gets the plain 422.
      if (error instanceof AppError && error.code === 'DOCUMENT_TOO_COMPLEX') {
        return c.json({ error: error.message }, 422);
      }

      // Solid Ten (DISK-L1): the database cannot store it now (full disk, unreachable).
      if (isDatabaseUnavailableError(error)) {
        const unavailable = toPublicDatabaseError(error, 'an upload');

        c.header('Retry-After', unavailable?.headers?.['Retry-After'] ?? '30');

        return c.json({ error: unavailable?.message, code: unavailable?.code }, 503);
      }

      console.error('Upload failed:', error);
      return c.json({ error: 'Upload failed' }, 500);
    }
  })
  .get(
    '/envelope/:envelopeId/envelopeItem/:envelopeItemId',
    sValidator('param', ZGetEnvelopeItemFileRequestParamsSchema),
    sValidator('query', ZGetEnvelopeItemFileRequestQuerySchema),
    async (c) => {
      const { envelopeId, envelopeItemId } = c.req.valid('param');
      const { token } = c.req.query();

      const session = await getOptionalNonEmbedSession(c);

      let userId = session.user?.id;
      let presign: VerifiedPresignFileToken | undefined;

      if (token) {
        presign = await verifyPresignFileToken(token);

        userId = presign?.userId;
      }

      if (!userId) {
        return c.json({ error: 'Unauthorized' }, 401);
      }

      const envelope = await prisma.envelope.findFirst({
        where: {
          id: envelopeId,
        },
        include: {
          envelopeItems: {
            where: {
              id: envelopeItemId,
            },
            include: {
              documentData: true,
            },
          },
        },
      });

      if (!envelope) {
        return c.json({ error: 'Envelope not found' }, 404);
      }

      const [envelopeItem] = envelope.envelopeItems;

      if (!envelopeItem) {
        return c.json({ error: 'Envelope item not found' }, 404);
      }

      if (!presignFileTokenReachesEnvelope(presign, envelope)) {
        return c.json({ error: 'Unauthorized' }, 401);
      }

      const hasAccess = await checkEnvelopeFileAccess({
        userId,
        teamId: envelope.teamId,
        envelopeType: envelope.type,
        templateType: envelope.templateType,
        visibility: envelope.visibility,
        ownerId: envelope.userId,
      });

      if (!hasAccess) {
        return c.json({ error: 'User does not have access to the team that this envelope is associated with' }, 403);
      }

      if (!envelopeItem.documentData) {
        return c.json({ error: 'Document data not found' }, 404);
      }

      return await handleEnvelopeItemFileRequest({
        title: envelopeItem.title,
        status: envelope.status,
        documentData: envelopeItem.documentData,
        version: 'signed',
        isDownload: false,
        context: c,
      });
    },
  )
  .get(
    '/envelope/:envelopeId/envelopeItem/:envelopeItemId/download/:version?',
    sValidator('param', ZGetEnvelopeItemFileDownloadRequestParamsSchema),
    async (c) => {
      const logger = c.get('logger');

      try {
        const { envelopeId, envelopeItemId, version } = c.req.valid('param');

        const session = await getOptionalNonEmbedSession(c);

        if (!session.user) {
          return c.json({ error: 'Unauthorized' }, 401);
        }

        const envelope = await prisma.envelope.findFirst({
          where: {
            id: envelopeId,
          },
          include: {
            envelopeItems: {
              where: {
                id: envelopeItemId,
              },
              include: {
                documentData: true,
              },
            },
            recipients: {
              select: {
                role: true,
                signingStatus: true,
              },
            },
          },
        });

        if (!envelope) {
          return c.json({ error: 'Envelope not found' }, 404);
        }

        const [envelopeItem] = envelope.envelopeItems;

        if (!envelopeItem) {
          return c.json({ error: 'Envelope item not found' }, 404);
        }

        const hasDownloadAccess = await checkEnvelopeFileAccess({
          userId: session.user.id,
          teamId: envelope.teamId,
          envelopeType: envelope.type,
          templateType: envelope.templateType,
          visibility: envelope.visibility,
          ownerId: envelope.userId,
        });

        if (!hasDownloadAccess) {
          return c.json(
            {
              error: 'User does not have access to the team that this envelope is associated with',
            },
            403,
          );
        }

        if (!envelopeItem.documentData) {
          return c.json({ error: 'Document data not found' }, 404);
        }

        const baseOptions = {
          title: envelopeItem.title,
          documentData: envelopeItem.documentData,
          isDownload: true,
          context: c,
        } as const;

        if (version === 'pending') {
          return await handleEnvelopeItemFileRequest({
            ...baseOptions,
            version,
            envelopeItemId: envelopeItem.id,
            envelope,
          });
        }

        return await handleEnvelopeItemFileRequest({
          ...baseOptions,
          version,
          status: envelope.status,
        });
      } catch (error) {
        logger.error(error);

        if (error instanceof AppError) {
          const { status, body } = AppError.toRestAPIError(error);

          return c.json({ error: body.message, code: error.code }, status);
        }

        return c.json({ error: 'Internal server error' }, 500);
      }
    },
  )
  .get(
    '/token/:token/envelopeItem/:envelopeItemId',
    sValidator('param', ZGetEnvelopeItemFileTokenRequestParamsSchema),
    async (c) => {
      const { token: tokenParam, envelopeItemId } = c.req.valid('param');
      const token = await resolveRecipientTokenParam(c, tokenParam);

      let envelopeWhereQuery: Prisma.EnvelopeItemWhereUniqueInput = {
        id: envelopeItemId,
        envelope: {
          recipients: {
            some: {
              token,
            },
          },
        },
      };

      if (token.startsWith('qr_')) {
        envelopeWhereQuery = {
          id: envelopeItemId,
          envelope: {
            qrToken: token,
          },
        };
      }

      const envelopeItem = await prisma.envelopeItem.findUnique({
        where: envelopeWhereQuery,
        include: {
          envelope: true,
          documentData: true,
        },
      });

      if (!envelopeItem || !(await canTokenAccessDocument(c, { token, envelopeId: envelopeItem.envelopeId }))) {
        return c.json({ error: 'Envelope item not found' }, 404);
      }

      if (!envelopeItem.documentData) {
        return c.json({ error: 'Document data not found' }, 404);
      }

      return await handleEnvelopeItemFileRequest({
        title: envelopeItem.title,
        status: envelopeItem.envelope.status,
        documentData: envelopeItem.documentData,
        version: 'signed',
        isDownload: false,
        context: c,
      });
    },
  )
  .get(
    '/token/:token/envelopeItem/:envelopeItemId/download/:version?',
    sValidator('param', ZGetEnvelopeItemFileTokenDownloadRequestParamsSchema),
    async (c) => {
      const { token: tokenParam, envelopeItemId, version } = c.req.valid('param');
      const token = await resolveRecipientTokenParam(c, tokenParam);

      let envelopeWhereQuery: Prisma.EnvelopeItemWhereUniqueInput = {
        id: envelopeItemId,
        envelope: {
          recipients: {
            some: {
              token,
            },
          },
        },
      };

      if (token.startsWith('qr_')) {
        envelopeWhereQuery = {
          id: envelopeItemId,
          envelope: {
            qrToken: token,
          },
        };
      }

      const envelopeItem = await prisma.envelopeItem.findUnique({
        where: envelopeWhereQuery,
        include: {
          envelope: true,
          documentData: true,
        },
      });

      if (!envelopeItem || !(await canTokenAccessDocument(c, { token, envelopeId: envelopeItem.envelopeId }))) {
        return c.json({ error: 'Envelope item not found' }, 404);
      }

      if (!envelopeItem.documentData) {
        return c.json({ error: 'Document data not found' }, 404);
      }

      return await handleEnvelopeItemFileRequest({
        title: envelopeItem.title,
        status: envelopeItem.envelope.status,
        documentData: envelopeItem.documentData,
        version,
        isDownload: true,
        context: c,
      });
    },
  );

// PDF routes for both tokens and auth based
// Is different to the other file endpoints since it uses documentDataId for hard caching.
filesRoute.route('/', getEnvelopeItemPdfRoute);
filesRoute.route('/', getEnvelopeItemPdfByTokenRoute);

// Content image routes for both tokens and auth based, hard cached by dataContentId.
filesRoute.route('/', getDataContentImageRoute);
filesRoute.route('/', getDataContentImageByTokenRoute);
filesRoute.route('/', getFieldFileRoute);
