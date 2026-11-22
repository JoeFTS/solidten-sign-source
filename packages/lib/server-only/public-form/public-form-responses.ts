import { prisma } from '@documenso/prisma';
import { type DocumentStatus, type Prisma, TeamMemberRole } from '@prisma/client';

import { TEAM_DOCUMENT_VISIBILITY_MAP } from '../../constants/teams';
import { toCsv } from '../../utils/csv';
import { mapSecondaryIdToDocumentId } from '../../utils/envelope';
import { getTeamById } from '../team/get-team';
import { getPublicFormIdForTemplate } from './public-form-settings';

export const PUBLIC_FORM_EXPORT_MAX_ROWS = 10_000;

export type PublicFormResponseStatus = DocumentStatus | 'DELETED';

export type FindPublicFormResponsesOptions = {
  userId: number;
  teamId: number;
  envelopeId: string;
  /**
   * Inclusive start and exclusive end of the submission time.
   */
  from?: Date | null;
  to?: Date | null;
  page?: number;
  perPage?: number;
};

const buildWhere = (formId: string, from?: Date | null, to?: Date | null): Prisma.StPublicFormSubmissionWhereInput => ({
  formId,
  createdAt: {
    ...(from ? { gte: from } : {}),
    ...(to ? { lt: to } : {}),
  },
});

/**
 * Solid Ten (AUD-29): the response envelope ids of a form the caller may see, by the rule envelope.get
 * applies (visibility for their team role, or they own it, or they are a recipient). `null` means every
 * response: a team ADMIN sees every visibility, and also the rows whose document is gone.
 */
const getVisibleResponseEnvelopeIds = async ({
  formId,
  userId,
  teamId,
}: {
  formId: string;
  userId: number;
  teamId: number;
}): Promise<string[] | null> => {
  const team = await getTeamById({ userId, teamId });

  if (team.currentTeamRole === TeamMemberRole.ADMIN) {
    return null;
  }

  const [user, submissions] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } }),
    prisma.stPublicFormSubmission.findMany({ where: { formId }, select: { envelopeId: true } }),
  ]);

  const visible = await prisma.envelope.findMany({
    where: {
      id: { in: submissions.map((submission) => submission.envelopeId) },
      teamId,
      OR: [
        { visibility: { in: TEAM_DOCUMENT_VISIBILITY_MAP[team.currentTeamRole] } },
        { userId },
        { recipients: { some: { email: user.email } } },
      ],
    },
    select: { id: true },
  });

  return visible.map((envelope) => envelope.id);
};

const onlyVisible = (visibleIds: string[] | null): Prisma.StPublicFormSubmissionWhereInput =>
  visibleIds === null ? {} : { envelopeId: { in: visibleIds } };

const withStatus = async (
  submissions: Awaited<ReturnType<typeof prisma.stPublicFormSubmission.findMany>>,
  teamId: number,
) => {
  const envelopes = await prisma.envelope.findMany({
    where: {
      id: { in: submissions.map((submission) => submission.envelopeId) },
      teamId,
    },
    select: { id: true, status: true, secondaryId: true, deletedAt: true },
  });

  return submissions.map((submission) => {
    const envelope = envelopes.find((candidate) => candidate.id === submission.envelopeId);

    const status: PublicFormResponseStatus = !envelope || envelope.deletedAt ? 'DELETED' : envelope.status;

    return {
      id: submission.id,
      createdAt: submission.createdAt,
      submitterEmail: submission.submitterEmail,
      submitterName: submission.submitterName,
      emailVerified: submission.emailVerified,
      envelopeId: submission.envelopeId,
      documentId: envelope ? mapSecondaryIdToDocumentId(envelope.secondaryId) : null,
      status,
    };
  });
};

export const findPublicFormResponses = async ({
  userId,
  teamId,
  envelopeId,
  from,
  to,
  page = 1,
  perPage = 20,
}: FindPublicFormResponsesOptions) => {
  const { formId } = await getPublicFormIdForTemplate({ userId, teamId, envelopeId });

  if (!formId) {
    return { data: [], count: 0, totalCount: 0, currentPage: 1, perPage, totalPages: 0 };
  }

  const visible = onlyVisible(await getVisibleResponseEnvelopeIds({ formId, userId, teamId }));

  const where = { ...buildWhere(formId, from, to), ...visible };

  const [submissions, count, totalCount] = await Promise.all([
    prisma.stPublicFormSubmission.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    prisma.stPublicFormSubmission.count({ where }),
    prisma.stPublicFormSubmission.count({ where: { formId, ...visible } }),
  ]);

  return {
    data: await withStatus(submissions, teamId),
    count,
    totalCount,
    currentPage: page,
    perPage,
    totalPages: Math.ceil(count / perPage),
  };
};

export const exportPublicFormResponsesCsv = async ({
  userId,
  teamId,
  envelopeId,
  from,
  to,
}: Omit<FindPublicFormResponsesOptions, 'page' | 'perPage'>) => {
  const { formId, envelope } = await getPublicFormIdForTemplate({ userId, teamId, envelopeId });

  const submissions = formId
    ? await prisma.stPublicFormSubmission.findMany({
        where: {
          ...buildWhere(formId, from, to),
          ...onlyVisible(await getVisibleResponseEnvelopeIds({ formId, userId, teamId })),
        },
        orderBy: { createdAt: 'desc' },
        take: PUBLIC_FORM_EXPORT_MAX_ROWS,
      })
    : [];

  const rows = await withStatus(submissions, teamId);

  const csv = toCsv(
    ['submitted_at', 'submitter_name', 'submitter_email', 'email_verified', 'status', 'document_id', 'envelope_id'],
    rows.map((row) => [
      row.createdAt,
      row.submitterName,
      row.submitterEmail,
      row.emailVerified,
      row.status,
      row.documentId,
      row.envelopeId,
    ]),
  );

  const safeTitle = envelope.title.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 60) || 'form';

  return { csv, filename: `${safeTitle}-responses.csv` };
};

/**
 * Which recipients of a document came in through a public form, and whether their email was
 * verified. Read by the signing certificate.
 */
export const getPublicFormVerificationByRecipient = async (envelopeId: string) => {
  const logs = await prisma.documentAuditLog.findMany({
    where: { envelopeId, type: 'DOCUMENT_PUBLIC_FORM_SUBMITTED' },
    select: { data: true },
  });

  const verification = new Map<number, boolean>();

  for (const { data } of logs) {
    if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
      const { recipientId, emailVerified } = data as Record<string, unknown>;

      if (typeof recipientId === 'number' && typeof emailVerified === 'boolean') {
        verification.set(recipientId, emailVerified);
      }
    }
  }

  return verification;
};

/**
 * The form's thank-you message for the person who submitted it, shown on the completion page.
 */
export const getPublicFormThankYouMessage = async ({
  envelopeId,
  recipientEmail,
}: {
  envelopeId: string;
  recipientEmail: string;
}) => {
  const submission = await prisma.stPublicFormSubmission.findUnique({
    where: { envelopeId },
    select: { submitterEmail: true, form: { select: { thankYouMessage: true } } },
  });

  if (!submission || submission.submitterEmail !== recipientEmail.toLowerCase()) {
    return null;
  }

  return submission.form.thankYouMessage;
};
