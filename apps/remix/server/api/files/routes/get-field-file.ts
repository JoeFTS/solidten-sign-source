import { getOptionalNonEmbedSession } from '@documenso/auth/server/lib/session/embed-session-restrictions';
import { getFieldFileMaxBytes } from '@documenso/lib/constants/field-file';
import {
  getSignerFieldFileForDownload,
  getTeamFieldFileForDownload,
  recordFieldFileDownload,
} from '@documenso/lib/server-only/field-file/field-file-access';
import { fieldFileDownloadRateLimit } from '@documenso/lib/server-only/field-file/rate-limits';
import { rateLimitResponse } from '@documenso/lib/server-only/rate-limit/rate-limit-middleware';
import { getTokenRateLimitKey } from '@documenso/lib/server-only/rate-limit/token-rate-limit-key';
import { DataContentType } from '@documenso/lib/types/data-content-meta';
import { getFileServerSide } from '@documenso/lib/universal/upload/get-file.server';
import { sValidator } from '@hono/standard-validator';
import type { DataContent, FieldFileUpload } from '@prisma/client';
import contentDisposition from 'content-disposition';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { HonoEnv } from '../../../router';
import { resolveRecipientTokenParam } from '../in-person-turn-token';
import { canTokenAccessDocument } from '../token-document-access';

/**
 * Solid Ten: download routes for files signers attached to "Attach a file" fields.
 *
 * - By signing link token: the uploader, or any recipient of the envelope when the sender
 *   marked the field "visible to all recipients".
 * - By session: team members who can open the document.
 *
 * Every failure answers 404, so a token cannot probe for files it may not see.
 */
const route = new Hono<HonoEnv>();

const ZTokenParamsSchema = z.object({
  token: z.string().min(1),
  fileId: z.string().min(1),
});

const ZSessionParamsSchema = z.object({
  envelopeId: z.string().min(1),
  fileId: z.string().min(1),
});

const sendFieldFile = async (
  c: Context<HonoEnv>,
  upload: FieldFileUpload & { dataContent: DataContent },
  /** Solid Ten Sign (S-H4): writes the download to the audit log once the bytes are ready. */
  recordDownload: () => Promise<void>,
) => {
  if (upload.dataContent.metadata.type !== DataContentType.FILE) {
    return c.json({ error: 'Not found' }, 404);
  }

  const bytes = await getFileServerSide({
    type: upload.dataContent.type,
    data: upload.dataContent.data,
  }).catch((error) => {
    console.error(error);

    return null;
  });

  if (!bytes) {
    return c.json({ error: 'Not found' }, 404);
  }

  // No audit entry, no file: the download is evidence.
  await recordDownload();

  // Always a download, with the content type found from the bytes at upload time.
  c.header('Content-Type', upload.mimeType);
  c.header('Content-Disposition', contentDisposition(upload.fileName, { type: 'attachment' }));
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Content-Security-Policy', "default-src 'none'; sandbox");
  c.header('Cache-Control', 'private, no-store');

  return c.body(bytes);
};

route.get('/token/:token/field-file/:fileId', sValidator('param', ZTokenParamsSchema), async (c) => {
  const { token: tokenParam, fileId } = c.req.valid('param');
  const token = await resolveRecipientTokenParam(c, tokenParam);

  const rateLimit = await fieldFileDownloadRateLimit.check({
    ip: c.get('context').requestMetadata.ipAddress ?? 'unknown',
    identifier: getTokenRateLimitKey(token),
  });

  // Solid Ten: the same 429 as every other route (LD3-L1).
  const limited = rateLimitResponse(c, rateLimit);

  if (limited) {
    return limited;
  }

  const upload = await getSignerFieldFileForDownload({ token, fileId });

  // Solid Ten Sign (SEC3-C1): the recipient's access requirement (an ACCOUNT recipient must be
  // signed in as that account), as for the document's own files. Still a 404, as for any file
  // the token may not see.
  if (!upload || !(await canTokenAccessDocument(c, { token, envelopeId: upload.envelopeId }))) {
    return c.json({ error: 'Not found' }, 404);
  }

  const { downloader, ...file } = upload;

  return await sendFieldFile(c, file, async () => {
    await recordFieldFileDownload({
      upload: file,
      via: 'RECIPIENT',
      user: { name: downloader.name, email: downloader.email },
      authSessionId: null,
      downloadedByRecipientId: downloader.id,
      requestMetadata: c.get('context').requestMetadata,
    });
  });
});

route.get('/envelope/:envelopeId/field-file/:fileId', sValidator('param', ZSessionParamsSchema), async (c) => {
  const { envelopeId, fileId } = c.req.valid('param');

  const session = await getOptionalNonEmbedSession(c);

  if (!session.user) {
    return c.json({ error: 'Not found' }, 404);
  }

  const upload = await getTeamFieldFileForDownload({ userId: session.user.id, envelopeId, fileId });

  if (!upload) {
    return c.json({ error: 'Not found' }, 404);
  }

  const { user } = session;

  return await sendFieldFile(c, upload, async () => {
    await recordFieldFileDownload({
      upload,
      via: 'TEAM',
      user: { id: user.id, name: user.name, email: user.email },
      authSessionId: session.session?.id ?? null,
      downloadedByRecipientId: null,
      requestMetadata: c.get('context').requestMetadata,
    });
  });
});

/**
 * Caps the request body of the file upload procedure before tRPC reads it into memory.
 * The headroom covers the multipart framing and the JSON payload.
 */
export const fieldFileUploadBodyLimit: MiddlewareHandler = async (c, next) =>
  bodyLimit({
    maxSize: getFieldFileMaxBytes() + 64 * 1024,
    onError: (ctx) => ctx.json({ error: 'The file is too large.' }, 413),
  })(c, next);

export default route;
