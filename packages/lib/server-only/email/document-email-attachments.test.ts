import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getDocumentDelivery,
  getDocumentDeliveryForBytes,
  getEmailAttachmentLimitBytes,
  isMessageTooLargeError,
  sendWithDocumentDeliveryFallback,
} from './document-email-attachments';

const file = (bytes: number) => ({ content: Buffer.alloc(bytes) });
const MB = 1024 * 1024;

afterEach(() => {
  delete process.env.NEXT_PRIVATE_ST_EMAIL_ATTACHMENT_LIMIT_MB;
});

describe('signed document in an email', () => {
  it('attaches up to 7 MB of file content by default, summed over all files', () => {
    expect(getEmailAttachmentLimitBytes()).toBe(7 * MB);
    expect(getDocumentDelivery([file(7 * MB)])).toBe('ATTACHMENT');
    expect(getDocumentDelivery([file(4 * MB), file(3 * MB + 1)])).toBe('LINK');
  });

  it('follows NEXT_PRIVATE_ST_EMAIL_ATTACHMENT_LIMIT_MB', () => {
    process.env.NEXT_PRIVATE_ST_EMAIL_ATTACHMENT_LIMIT_MB = '20';
    expect(getDocumentDelivery([file(19 * MB)])).toBe('ATTACHMENT');

    process.env.NEXT_PRIVATE_ST_EMAIL_ATTACHMENT_LIMIT_MB = 'nonsense';
    expect(getEmailAttachmentLimitBytes()).toBe(7 * MB);
  });

  it('knows a size refusal from other mail errors', () => {
    expect(isMessageTooLargeError({ responseCode: 552, response: '552 5.3.4 Message size exceeds fixed limit' })).toBe(
      true,
    );
    expect(isMessageTooLargeError({ responseCode: 554, response: '554 Message too large' })).toBe(true);
    expect(isMessageTooLargeError({ responseCode: 550, response: '550 5.1.1 User unknown' })).toBe(false);
    expect(isMessageTooLargeError({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' })).toBe(false);
    expect(isMessageTooLargeError({ responseCode: 452, response: '452 Message size too large right now' })).toBe(false);
  });

  it('sends the link version once when the attached version is refused as too large', async () => {
    const send = vi
      .fn<(delivery: 'ATTACHMENT' | 'LINK') => Promise<void>>()
      .mockRejectedValueOnce({ responseCode: 552, response: '552 message size exceeds limit' })
      .mockResolvedValueOnce(undefined);

    await expect(sendWithDocumentDeliveryFallback('ATTACHMENT', send)).resolves.toBe('LINK');
    expect(send.mock.calls.map(([delivery]) => delivery)).toEqual(['ATTACHMENT', 'LINK']);
  });

  it('does not change the message for other errors (the job retries it)', async () => {
    const send = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));

    await expect(sendWithDocumentDeliveryFallback('ATTACHMENT', send)).rejects.toThrow('ECONNREFUSED');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('sends a link straight away when the files are above the limit', async () => {
    const send = vi.fn().mockResolvedValue(undefined);

    await expect(sendWithDocumentDeliveryFallback(getDocumentDeliveryForBytes(8 * MB), send)).resolves.toBe('LINK');
    expect(send.mock.calls.map(([delivery]) => delivery)).toEqual(['LINK']);
  });

  it('decides from the stored size, and treats an unknown size as too large', () => {
    expect(getDocumentDeliveryForBytes(7 * MB)).toBe('ATTACHMENT');
    expect(getDocumentDeliveryForBytes(36 * MB)).toBe('LINK');
    expect(getDocumentDeliveryForBytes(null)).toBe('LINK');
  });
});
