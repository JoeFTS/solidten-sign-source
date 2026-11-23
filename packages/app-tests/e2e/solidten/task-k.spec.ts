import { prisma } from '@documenso/prisma';
import { FieldType } from '@documenso/prisma/client';
import { expect, test } from '@playwright/test';

import { apiCreateTestContext, apiSeedPendingDocument } from '../fixtures/api-seeds';
import { apiSignin } from '../fixtures/authentication';

/**
 * Solid Ten Sign, task K.
 * K-2: a signing email the organisation's email limit stops is no longer dropped silently.
 * (K-1 is a static unit test: packages/lib/utils/in-app-links.test.ts.)
 */

test.describe('K-2: signing email stopped by the email limit', () => {
  test.skip(
    process.env.DANGEROUS_BYPASS_RATE_LIMITS === 'true',
    'needs DANGEROUS_BYPASS_RATE_LIMITS off on the app and the tests (it turns the limit off)',
  );

  test('the recipient is marked "Not delivered", the audit says why, and the owner is told', async ({
    page,
    request,
  }) => {
    const context = await apiCreateTestContext('k2-limit');

    const { organisation } = await prisma.team.findUniqueOrThrow({
      where: { id: context.team.id },
      select: { organisation: { select: { organisationClaimId: true } } },
    });

    await prisma.organisationClaim.update({
      where: { id: organisation.organisationClaimId },
      data: { emailQuota: 0 },
    });

    const signerEmail = `k2-limit-${Date.now()}@test.documenso.com`;

    const { envelope } = await apiSeedPendingDocument(request, {
      context,
      recipients: [{ email: signerEmail, name: 'Limited Signer' }],
      fieldsPerRecipient: [[{ type: FieldType.SIGNATURE, page: 1, positionX: 60, positionY: 5, width: 20, height: 5 }]],
    });

    const recipient = await prisma.recipient.findFirstOrThrow({ where: { envelopeId: envelope.id } });

    await expect
      .poll(async () => (await prisma.recipient.findUniqueOrThrow({ where: { id: recipient.id } })).deliveryFailedAt, {
        timeout: 60_000,
      })
      .not.toBeNull();

    const entries = await prisma.documentAuditLog.findMany({
      where: { envelopeId: envelope.id, type: 'EMAIL_NOT_DELIVERED' },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].data).toMatchObject({ recipientId: recipient.id, emailType: 'SIGNING_REQUEST', reason: 'LIMIT' });

    const notices = await prisma.backgroundJob.findMany({
      where: {
        jobId: 'send.solidten.notice.email',
        AND: [
          { payload: { path: ['kind'], equals: 'SIGNING_REQUEST_NOT_DELIVERED' } },
          { payload: { path: ['envelopeId'], equals: envelope.id } },
        ],
      },
    });
    expect(notices).toHaveLength(1);
    expect(notices[0].payload).toMatchObject({ recipientId: recipient.id, reason: 'LIMIT' });

    // The document page shows the existing "Not delivered" badge (with Resend).
    await apiSignin({
      page,
      email: context.user.email,
      redirectPath: `/t/${context.team.url}/documents/${envelope.id}`,
    });
    await expect(page.getByTestId(`recipient-not-delivered-${recipient.id}`)).toBeVisible({ timeout: 30_000 });
  });
});
