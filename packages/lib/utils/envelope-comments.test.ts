import { DocumentStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  COMMENT_MAX_LENGTH,
  countUnreadRecipientComments,
  getCommentBodyError,
  getCommentsClosedReason,
  getRecipientCommentThreadKey,
  getRecipientVisibleThreadKeys,
  normaliseCommentBody,
  resolveEnvelopeCommentSettings,
  SHARED_COMMENT_THREAD_KEY,
} from './envelope-comments';

describe('normaliseCommentBody', () => {
  it('keeps text and HTML as typed, trims and squeezes blank lines', () => {
    expect(normaliseCommentBody('  <b>Hi</b>\r\n\r\n\r\n\r\nthere  ')).toBe('<b>Hi</b>\n\nthere');
  });

  it('removes control characters but keeps line breaks and tabs', () => {
    expect(normaliseCommentBody('a\u0000b\u0007c\td\ne\u007f')).toBe('abc\td\ne');
  });
});

describe('getCommentBodyError', () => {
  it('refuses empty and too long comments', () => {
    expect(getCommentBodyError('')).toBe('EMPTY');
    expect(getCommentBodyError('x'.repeat(COMMENT_MAX_LENGTH))).toBeNull();
    expect(getCommentBodyError('x'.repeat(COMMENT_MAX_LENGTH + 1))).toBe('TOO_LONG');
  });
});

describe('getCommentsClosedReason', () => {
  it('is open only while pending', () => {
    expect(getCommentsClosedReason({ status: DocumentStatus.PENDING, deletedAt: null })).toBeNull();
    expect(getCommentsClosedReason({ status: DocumentStatus.DRAFT, deletedAt: null })).toBe('NOT_SENT');
    expect(getCommentsClosedReason({ status: DocumentStatus.COMPLETED, deletedAt: null })).toBe('COMPLETED');
    expect(getCommentsClosedReason({ status: DocumentStatus.REJECTED, deletedAt: null })).toBe('REJECTED');
    expect(getCommentsClosedReason({ status: DocumentStatus.CANCELLED, deletedAt: null })).toBe('CANCELLED');
    expect(getCommentsClosedReason({ status: DocumentStatus.PENDING, deletedAt: new Date() })).toBe('DELETED');
  });
});

describe('resolveEnvelopeCommentSettings', () => {
  const teamSettings = { commentsEnabled: true, commentsSharedThread: false };

  it('uses the team default when the document has no choice', () => {
    expect(resolveEnvelopeCommentSettings({ envelopeSettings: null, teamSettings })).toEqual({
      enabled: true,
      sharedThread: false,
      isTeamDefault: true,
    });
  });

  it("prefers the document's own choice", () => {
    expect(
      resolveEnvelopeCommentSettings({ envelopeSettings: { enabled: false, sharedThread: true }, teamSettings }),
    ).toEqual({ enabled: false, sharedThread: true, isTeamDefault: false });
  });
});

describe('thread keys', () => {
  it('gives a reassigned recipient a new thread', () => {
    const before = getRecipientCommentThreadKey({ id: 7, email: 'Old@Example.com' });
    const after = getRecipientCommentThreadKey({ id: 7, email: 'new@example.com' });

    expect(before).toBe('recipient:7:old@example.com');
    expect(after).not.toBe(before);
  });

  it('shows the shared thread only when the document uses one', () => {
    const recipient = { id: 3, email: 'a@example.com' };

    expect(getRecipientVisibleThreadKeys({ recipient, sharedThread: false })).toEqual(['recipient:3:a@example.com']);
    expect(getRecipientVisibleThreadKeys({ recipient, sharedThread: true })).toEqual([
      'recipient:3:a@example.com',
      SHARED_COMMENT_THREAD_KEY,
    ]);
  });
});

describe('countUnreadRecipientComments', () => {
  it('counts recipient comments after the team last read', () => {
    const comments = [
      { authorType: 'RECIPIENT' as const, createdAt: new Date('2026-01-01T10:00:00Z') },
      { authorType: 'TEAM' as const, createdAt: new Date('2026-01-01T11:00:00Z') },
      { authorType: 'RECIPIENT' as const, createdAt: new Date('2026-01-01T12:00:00Z') },
    ];

    expect(countUnreadRecipientComments({ comments, teamReadAt: null })).toBe(2);
    expect(countUnreadRecipientComments({ comments, teamReadAt: new Date('2026-01-01T11:30:00Z') })).toBe(1);
  });
});
