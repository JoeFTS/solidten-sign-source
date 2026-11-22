import type { Prisma } from '@prisma/client';
import { SigningStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { AppError, AppErrorCode } from '../../errors/app-error';
import {
  assertEnvelopeOpenForRecipientAction,
  ENVELOPE_DECLINED_MESSAGE,
  RECIPIENT_ALREADY_ACTED_MESSAGE,
} from './envelope-transition-lock';

type Recipient = { id: number; signingStatus: SigningStatus };

// The two reads the check makes, over a fixed list of (non-CC) recipients.
const fakeTx = (recipients: Recipient[]) =>
  ({
    recipient: {
      findMany: async () => recipients,
      findFirst: async ({ where }: { where: { id: number } }) => recipients.find((r) => r.id === where.id) ?? null,
    },
  }) as unknown as Prisma.TransactionClient;

const refusal = async (recipients: Recipient[], recipientId?: number) => {
  try {
    await assertEnvelopeOpenForRecipientAction(fakeTx(recipients), 'envelope_1', recipientId);
  } catch (err) {
    return AppError.parseError(err);
  }

  return null;
};

describe('assertEnvelopeOpenForRecipientAction', () => {
  it('answers ENVELOPE_REJECTED when another recipient declined, so the page shows "Document rejected"', async () => {
    const error = await refusal(
      [
        { id: 1, signingStatus: SigningStatus.NOT_SIGNED },
        { id: 2, signingStatus: SigningStatus.REJECTED },
      ],
      1,
    );

    expect(error?.code).toBe(AppErrorCode.ENVELOPE_REJECTED);
    expect(error?.message).toBe(ENVELOPE_DECLINED_MESSAGE);
  });

  it('keeps INVALID_REQUEST for the recipient who declined or signed themselves', async () => {
    const error = await refusal(
      [
        { id: 1, signingStatus: SigningStatus.SIGNED },
        { id: 2, signingStatus: SigningStatus.REJECTED },
      ],
      2,
    );

    expect(error?.code).toBe(AppErrorCode.INVALID_REQUEST);
    expect(error?.message).toBe(RECIPIENT_ALREADY_ACTED_MESSAGE);
  });

  it('does not say "rejected" when everyone has signed', async () => {
    const error = await refusal([{ id: 1, signingStatus: SigningStatus.SIGNED }]);

    expect(error?.code).toBe(AppErrorCode.INVALID_REQUEST);
  });

  it('lets the action through while someone can still act', async () => {
    expect(
      await refusal(
        [
          { id: 1, signingStatus: SigningStatus.NOT_SIGNED },
          { id: 2, signingStatus: SigningStatus.SIGNED },
        ],
        1,
      ),
    ).toBeNull();
  });
});
