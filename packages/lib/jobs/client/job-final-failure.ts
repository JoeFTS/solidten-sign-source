/**
 * Solid Ten: what happens when a job has used its last attempt (from the job endpoint or the
 * recovery sweep). Runs at most once per row: callers only call it after their own conditional
 * update moved the row to FAILED.
 */
export type TFailedJobRow = {
  id: string;
  jobId: string;
  payload: unknown;
  retried: number;
};

export const handleJobFinalFailure = async (row: TFailedJobRow) => {
  console.error(`[JOBS]: Job ${row.id} (${row.jobId}) failed for good after ${row.retried + 1} attempt(s)`);

  try {
    if (row.jobId === 'send.signing.requested.email') {
      // Loaded on use: the handler pulls in the jobs client, which imports this provider.
      const { markSigningRequestUndelivered } = await import('../definitions/solidten/signing-request-delivery');

      await markSigningRequestUndelivered({ payload: row.payload, attempts: row.retried + 1 });
    }

    if (row.jobId === 'send.document.completed.emails') {
      const { markCompletedEmailsUndelivered } = await import('../definitions/solidten/completed-email-delivery');

      await markCompletedEmailsUndelivered({ jobRowId: row.id, payload: row.payload, attempts: row.retried + 1 });
    }

    if (row.jobId === 'internal.seal-document') {
      const { markSealFailed } = await import('../definitions/solidten/seal-failed');

      await markSealFailed({ payload: row.payload, attempts: row.retried + 1 });
    }
  } catch (error) {
    console.error(`[JOBS]: Final-failure handling for job ${row.id} failed`, error);
  }
};
