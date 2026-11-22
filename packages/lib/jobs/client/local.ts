import { prisma } from '@documenso/prisma';
import { sha256 } from '@noble/hashes/sha2';
import { BackgroundJobStatus, Prisma } from '@prisma/client';
import { CronExpressionParser } from 'cron-parser';
import type { Context as HonoContext } from 'hono';

import { NEXT_PRIVATE_INTERNAL_WEBAPP_URL } from '../../constants/app';
import { isDatabaseUnavailableError } from '../../errors/database-error-kind';
import { sign } from '../../server-only/crypto/sign';
import { verify } from '../../server-only/crypto/verify';
import { recordDatabaseWriteFailure } from '../../server-only/health/database-write-health';
import {
  type JobDefinition,
  type JobRunIO,
  type SimpleTriggerJobOptions,
  ZSimpleTriggerJobOptionsSchema,
} from './_internal/job';
import type { Json } from './_internal/json';
import {
  completeCutOffAtMostOnceTask,
  getAtMostOnceStartedAt,
  isCutOffAtMostOnceTask,
  markAtMostOnceTaskStarted,
  type TAtMostOnceAlongside,
  type TAtMostOnceOptions,
} from './at-most-once-task';
import { BaseJobProvider } from './base';
import { healUnsealedEnvelopes } from './heal-unsealed-envelopes';
import { healUnsentSigningRequests } from './heal-unsent-signing-requests';
import { deferJobForDatabaseOutage } from './job-database-outage';
import { handleJobFinalFailure } from './job-final-failure';
import { getMaxRetries, getNextRunAt } from './job-retry-policy';
import { withJobSlot } from './job-slots';
import {
  RECOVERY_INTERVAL_MS,
  RECOVERY_JITTER_MS,
  RECOVERY_STARTUP_DELAY_MS,
  runLocalJobRecovery,
  type TRecoveryOptions,
} from './local-recovery';
import { runJobMaybeInPdfChild } from './pdf-child-jobs';
import { recordTaskCompleted } from './task-completion';

/**
 * Build a deterministic BackgroundJob ID for a cron run so that multiple
 * instances of the local provider racing to enqueue the same slot will
 * collide on the primary key instead of creating duplicates.
 */
const createCronRunId = (jobId: string, scheduledFor: Date): string => {
  const key = `cron:${jobId}:${scheduledFor.toISOString()}`;
  const hash = Buffer.from(sha256(key)).toString('hex').slice(0, 24);

  return `cron_${hash}`;
};

/**
 * Solid Ten: BackgroundJob id for a trigger that carries its own idempotency `id`.
 */
const createTriggeredJobId = (id: string, jobDefinitionId: string): string => {
  const hash = Buffer.from(sha256(`trigger:${jobDefinitionId}:${id}`))
    .toString('hex')
    .slice(0, 24);

  return `job_${hash}`;
};

declare global {
  // eslint-disable-next-line no-var
  var __solidten_job_recovery_started__: boolean | undefined;
}

type CronJobEntry = {
  definition: JobDefinition;
  cron: string;
  lastTickAt: Date;
};

const CRON_POLL_INTERVAL_MS = 30_000; // 30 seconds
const CRON_POLL_JITTER_MS = 5_000; // 0-5 seconds random offset

export class LocalJobProvider extends BaseJobProvider {
  private static _instance: LocalJobProvider;

  private _jobDefinitions: Record<string, JobDefinition> = {};
  private _cronJobs: CronJobEntry[] = [];
  private _cronPoller: NodeJS.Timeout | null = null;
  private _recoveryTimer: NodeJS.Timeout | null = null;

  private constructor() {
    super();
  }

  static getInstance() {
    if (!LocalJobProvider._instance) {
      LocalJobProvider._instance = new LocalJobProvider();
    }

    return LocalJobProvider._instance;
  }

  public defineJob<N extends string, T>(definition: JobDefinition<N, T>) {
    this._jobDefinitions[definition.id] = {
      ...definition,
      enabled: definition.enabled ?? true,
    };

    if (definition.trigger.cron && definition.enabled !== false) {
      const alreadyRegistered = this._cronJobs.some((job) => job.definition.id === definition.id);

      if (!alreadyRegistered) {
        this._cronJobs.push({
          definition: {
            ...definition,
            enabled: definition.enabled ?? true,
          },
          cron: definition.trigger.cron,
          lastTickAt: new Date(),
        });

        console.log(`[JOBS]: Registered cron job ${definition.id} (${definition.trigger.cron})`);
      }
    }
  }

  /**
   * Start the single cron poller for all registered cron jobs.
   *
   * Must be called explicitly at application startup after all jobs have been
   * defined. The poller runs every 30 seconds (+ random jitter to avoid
   * thundering herd across instances) and evaluates all registered cron jobs
   * for due slots.
   *
   * For each due slot it creates a BackgroundJob row with a deterministic ID.
   * If the insert succeeds the job is dispatched; if it fails with a unique
   * constraint violation (P2002) another instance already claimed that slot.
   */
  public override startCron() {
    // Solid Ten: the recovery sweep re-runs jobs whose POST was lost (see local-recovery.ts).
    this.startRecovery();

    if (this._cronPoller) {
      return;
    }

    if (this._cronJobs.length === 0) {
      return;
    }

    const tick = () => {
      const jitter = Math.floor(Math.random() * CRON_POLL_JITTER_MS);

      this._cronPoller = setTimeout(() => {
        void this.processCronTick().finally(tick);
      }, CRON_POLL_INTERVAL_MS + jitter);
    };

    tick();

    console.log(`[JOBS]: Started cron poller for ${this._cronJobs.length} job(s)`);
  }

  private async processCronTick() {
    for (const cronJob of this._cronJobs) {
      try {
        const dueSlots = this.getDueCronSlots(cronJob);

        cronJob.lastTickAt = new Date();

        if (dueSlots.length === 0) {
          continue;
        }

        // Only take the latest slot — sweep-style jobs don't need to catch up
        // every missed slot after downtime, just the most recent one.
        const scheduledFor = dueSlots[dueSlots.length - 1];
        const deterministicId = createCronRunId(cronJob.definition.id, scheduledFor);

        const pendingJob = await prisma.backgroundJob
          .create({
            data: {
              id: deterministicId,
              jobId: cronJob.definition.id,
              name: cronJob.definition.name,
              version: cronJob.definition.version,
              payload: { scheduledFor: scheduledFor.toISOString() },
            },
          })
          .catch((error: unknown) => {
            // P2002 = unique constraint violation — another instance already enqueued this slot.
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
              return null;
            }

            throw error;
          });

        if (!pendingJob) {
          continue;
        }

        await this.submitJobToEndpoint({
          jobId: pendingJob.id,
          jobDefinitionId: pendingJob.jobId,
          data: {
            name: cronJob.definition.trigger.name,
            payload: { scheduledFor: scheduledFor.toISOString() },
          },
          isRetry: false,
        });
      } catch (error) {
        console.error(`[JOBS]: Cron tick failed for ${cronJob.definition.id}`, error);
      }
    }
  }

  private startRecovery() {
    // Solid Ten: one recovery sweep per process. The production server is two bundles, each
    // with its own copy of this class, so the guard lives on globalThis (RT4-L1).
    if (this._recoveryTimer || globalThis.__solidten_job_recovery_started__) {
      return;
    }

    globalThis.__solidten_job_recovery_started__ = true;

    // Solid Ten: documents left in PDF temp folders by a process that died (pdf-child/temp-files.ts).
    void import('../../server-only/pdf-child/temp-files')
      .then(async ({ sweepPdfTempFiles }) => await sweepPdfTempFiles())
      .catch((error: unknown) => console.error('[PDF]: Temp folder sweep failed', error));

    const schedule = (delay: number) => {
      this._recoveryTimer = setTimeout(() => {
        void this.runRecovery()
          .catch((error: unknown) => console.error('[JOBS:recovery] Sweep failed', error))
          .finally(() => schedule(RECOVERY_INTERVAL_MS + Math.floor(Math.random() * RECOVERY_JITTER_MS)));
      }, delay);
    };

    // Once shortly after startup (the server must be listening, the sweep POSTs to itself), then every minute.
    schedule(RECOVERY_STARTUP_DELAY_MS);
  }

  /** Run one recovery sweep now. Exposed for tests and operations. */
  public async runRecovery(options: Pick<TRecoveryOptions, 'now' | 'jobIds' | 'batchSize'> = {}) {
    // Solid Ten: a process that shuts down claims nothing more (graceful-shutdown.ts).
    if (globalThis.__solidten_shutdown__?.isDraining) {
      return { resubmitted: [], failed: [], rescheduled: [] };
    }

    const result = await runLocalJobRecovery({
      ...options,
      definitions: this._jobDefinitions,
      submit: async (submitOptions) => await this.submitJobToEndpoint(submitOptions),
    });

    // Solid Ten: queue signing requests a failed send never queued (R-M6). Skipped when the
    // sweep is scoped to given rows (tests).
    if (!options.jobIds) {
      await healUnsentSigningRequests({ now: options.now }).catch((error: unknown) =>
        console.error('[JOBS:recovery] Healing unsent signing requests failed', error),
      );

      // Solid Ten: seal a completed document whose seal was never queued (FS2-L6).
      await healUnsealedEnvelopes({ now: options.now }).catch((error: unknown) =>
        console.error('[JOBS:recovery] Healing unsealed envelopes failed', error),
      );
    }

    return result;
  }

  /**
   * Use cron-parser to find all cron slots that are due between the last tick
   * and now.
   */
  private getDueCronSlots(cronJob: CronJobEntry): Date[] {
    const expr = CronExpressionParser.parse(cronJob.cron, {
      currentDate: cronJob.lastTickAt,
    });

    const now = new Date();
    const slots: Date[] = [];

    let next = expr.next();

    while (next.toDate() <= now) {
      slots.push(next.toDate());
      next = expr.next();
    }

    return slots;
  }

  public async triggerJob(options: SimpleTriggerJobOptions) {
    const eligibleJobs = Object.values(this._jobDefinitions).filter((job) => job.trigger.name === options.name);

    await Promise.all(
      eligibleJobs.map(async (job) => {
        // Ideally we will change this to a createMany with returning later once we upgrade Prisma
        // @see: https://github.com/prisma/prisma/releases/tag/5.14.0
        // Solid Ten: an `id` makes the trigger idempotent (as BullMQ treats it): the row id is
        // derived from it, and a second trigger with the same id is dropped.
        const pendingJob = await prisma.backgroundJob
          .create({
            data: {
              id: options.id ? createTriggeredJobId(options.id, job.id) : undefined,
              maxRetries: getMaxRetries(job.id),
              jobId: job.id,
              name: job.name,
              version: job.version,
              // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
              payload: options.payload as Prisma.InputJsonValue,
            },
          })
          .catch((error: unknown) => {
            if (options.id && error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
              return null;
            }

            throw error;
          });

        if (!pendingJob) {
          return;
        }

        await this.submitJobToEndpoint({
          jobId: pendingJob.id,
          jobDefinitionId: pendingJob.jobId,
          data: options,
          isRetry: false,
        });
      }),
    );
  }

  public getApiHandler(): (c: HonoContext) => Promise<Response | void> {
    return async (c: HonoContext) => {
      const req = c.req;

      if (req.method !== 'POST') {
        return c.text('Method not allowed', 405);
      }

      const jobId = req.header('x-job-id');
      const signature = req.header('x-job-signature');
      const isRetry = req.header('x-job-retry') !== undefined;

      const options = await req
        .json()
        .then(async (data) => ZSimpleTriggerJobOptionsSchema.parseAsync(data))
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
        .then((data) => data as SimpleTriggerJobOptions)
        .catch(() => null);

      if (!options) {
        return c.text('Bad request', 400);
      }

      const definition = this._jobDefinitions[options.name];

      if (typeof jobId !== 'string' || typeof signature !== 'string' || typeof options !== 'object') {
        return c.text('Bad request', 400);
      }

      if (!definition) {
        return c.text('Job not found', 404);
      }

      if (definition && !definition.enabled) {
        console.log('Attempted to trigger a disabled job', options.name);

        return c.text('Job not found', 404);
      }

      if (!signature || !verify(options, signature)) {
        return c.text('Unauthorized', 401);
      }

      let payload = options.payload;

      if (definition.trigger.schema) {
        const result = definition.trigger.schema.safeParse(payload);

        if (!result.success) {
          return c.text('Bad request', 400);
        }

        payload = result.data;
      }

      console.log(`[JOBS]: Triggering job ${options.name} with payload`, payload);

      let backgroundJob = await prisma.backgroundJob
        .update({
          where: {
            id: jobId,
            status: BackgroundJobStatus.PENDING,
          },
          data: {
            status: BackgroundJobStatus.PROCESSING,
            retried: {
              increment: isRetry ? 1 : 0,
            },
            lastRetriedAt: isRetry ? new Date() : undefined,
          },
        })
        .catch(() => null);

      if (!backgroundJob) {
        return c.text('Job not found', 404);
      }

      try {
        // Solid Ten: a large seal holds the heavy-PDF slot; its PDF work runs in a child (pdf-child-jobs.ts).
        const { maxRetries } = backgroundJob;

        // Solid Ten (FS3-L1): at most NEXT_PRIVATE_ST_JOB_CONCURRENCY jobs at a time (job-slots.ts).
        await withJobSlot(
          { jobId, definitionId: definition.id },
          async () =>
            await runJobMaybeInPdfChild(
              { jobId, definitionId: definition.id, payload, maxRetries },
              async () =>
                await definition.handler({
                  payload,
                  io: this.createJobRunIO(jobId, maxRetries),
                }),
            ),
        );

        backgroundJob = await prisma.backgroundJob.update({
          where: {
            id: jobId,
            status: BackgroundJobStatus.PROCESSING,
          },
          data: {
            status: BackgroundJobStatus.COMPLETED,
            completedAt: new Date(),
          },
        });
      } catch (error) {
        console.log(`[JOBS]: Job ${options.name} failed`, error);

        // Solid Ten (DISK-I1): the database could not take the job's work: wait, do not count it.
        if (isDatabaseUnavailableError(error)) {
          recordDatabaseWriteFailure();

          const isDeferred = await deferJobForDatabaseOutage(backgroundJob).catch(() => false);

          // Not even that could be written: the row stays PROCESSING and the sweep, which knows
          // about the outage, re-runs it without counting it.
          return isDeferred ? c.text('OK', 200) : c.text('Database unavailable', 503);
        }

        // Solid Ten: jobs with a backoff (email) wait between attempts and spend their budget on
        // any failure; see job-retry-policy.ts.
        const nextRunAt = getNextRunAt(backgroundJob.jobId, backgroundJob.retried);

        const taskHasExceededRetries = error instanceof BackgroundTaskExceededRetriesError;
        const jobHasExceededRetries =
          backgroundJob.retried >= backgroundJob.maxRetries &&
          (nextRunAt !== null || !(error instanceof BackgroundTaskFailedError));

        if (taskHasExceededRetries || jobHasExceededRetries) {
          backgroundJob = await prisma.backgroundJob.update({
            where: {
              id: jobId,
              status: BackgroundJobStatus.PROCESSING,
            },
            data: {
              status: BackgroundJobStatus.FAILED,
              completedAt: new Date(),
            },
          });

          await handleJobFinalFailure(backgroundJob);

          return c.text('Task exceeded retries', 500);
        }

        backgroundJob = await prisma.backgroundJob.update({
          where: {
            id: jobId,
            status: BackgroundJobStatus.PROCESSING,
          },
          data: {
            status: BackgroundJobStatus.PENDING,
            nextRunAt,
            // Solid Ten: it failed normally this time (it did not take the process down), so its
            // next attempt is counted as usual (see local-recovery.ts).
            lastCrashedAt: null,
            cutOffCount: null,
          },
        });

        // Solid Ten: the recovery sweep starts it when nextRunAt has passed.
        if (nextRunAt) {
          console.log(`[JOBS]: Job ${jobId} (${backgroundJob.jobId}) will be retried at ${nextRunAt.toISOString()}`);

          return c.text('OK', 200);
        }

        await this.submitJobToEndpoint({
          jobId,
          jobDefinitionId: backgroundJob.jobId,
          data: options,
          isRetry: true,
        });
      }

      return c.text('OK', 200);
    };
  }

  private async submitJobToEndpoint(options: {
    jobId: string;
    jobDefinitionId: string;
    data: SimpleTriggerJobOptions;
    isRetry?: boolean;
  }) {
    const { jobId, jobDefinitionId, data, isRetry } = options;

    const endpoint = `${NEXT_PRIVATE_INTERNAL_WEBAPP_URL()}/api/jobs/${jobDefinitionId}/${jobId}`;
    const signature = sign(data);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Job-Id': jobId,
      'X-Job-Signature': signature,
    };

    if (isRetry) {
      headers['X-Job-Retry'] = '1';
    }

    console.log('Submitting job to endpoint:', endpoint);
    await Promise.race([
      fetch(endpoint, {
        method: 'POST',
        body: JSON.stringify(data),
        headers,
      }).catch(() => null),
      new Promise((resolve) => {
        setTimeout(resolve, 150);
      }),
    ]);
  }

  private createJobRunIO(jobId: string, jobMaxRetries = 3): JobRunIO {
    // Solid Ten: a task may fail once per job attempt (a job with a long backoff has more than 3).
    const taskMaxRetries = Math.max(3, jobMaxRetries + 1);

    return {
      runTask: async <T extends void | Json>(
        cacheKey: string,
        callback: (markSending?: (alongside?: TAtMostOnceAlongside) => Promise<void>) => Promise<T>,
        options?: { atMostOnce?: boolean } & TAtMostOnceOptions,
      ) => {
        const hashedKey = Buffer.from(sha256(cacheKey)).toString('hex');

        let task = await prisma.backgroundJobTask.findFirst({
          where: {
            id: `task-${hashedKey}--${jobId}`,
            jobId,
          },
        });

        if (!task) {
          task = await prisma.backgroundJobTask.create({
            data: {
              id: `task-${hashedKey}--${jobId}`,
              name: cacheKey,
              jobId,
              status: BackgroundJobStatus.PENDING,
            },
          });
        }

        if (task.status === BackgroundJobStatus.COMPLETED) {
          // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
          return task.result as T;
        }

        if (task.retried >= taskMaxRetries) {
          throw new BackgroundTaskExceededRetriesError('Task exceeded retries');
        }

        // Solid Ten: an at-most-once task cut off during an earlier send is not run again.
        if (options?.atMostOnce && isCutOffAtMostOnceTask(task)) {
          await options.onCutOff?.(getAtMostOnceStartedAt(task));
          await completeCutOffAtMostOnceTask(task.id, cacheKey);

          return null as T;
        }

        const taskId = task.id;

        let result: T;

        try {
          result = await callback(
            options?.atMostOnce
              ? async (alongside?: TAtMostOnceAlongside) => await markAtMostOnceTaskStarted(taskId, alongside)
              : undefined,
          );
        } catch (err) {
          // Solid Ten (DISK-I1): a database outage does not spend the task's budget.
          const isDatabaseOutage = isDatabaseUnavailableError(err);

          task = await prisma.backgroundJobTask.update({
            where: {
              id: task.id,
              jobId,
            },
            data: {
              status: BackgroundJobStatus.PENDING,
              // Solid Ten: a recorded failure clears the at-most-once marker, so the retry may run.
              result: Prisma.JsonNull,
              retried: isDatabaseOutage
                ? undefined
                : {
                    increment: 1,
                  },
            },
          });

          console.log(`[JOBS:${task.id}] Task failed`, err);

          // Solid Ten: the cause is kept, so the job endpoint can tell an outage from a fault.
          throw new BackgroundTaskFailedError('Task failed', { cause: err });
        }

        // Solid Ten (FS3-L1): the callback returned, so its work is done (a message may have gone
        // out). A failure to record that is not a failed task: it is retried, and when it still
        // fails the task is left as it is, so an at-most-once task keeps its "sending" marker and a
        // re-run skips it (and writes its "may have been sent" entry) instead of sending again.
        task = await recordTaskCompleted({ taskId: task.id, jobId, result });

        return result;
      },
      triggerJob: async (_cacheKey, payload) => await this.triggerJob(payload),
      logger: {
        debug: (...args) => console.debug(`[${jobId}]`, ...args),
        error: (...args) => console.error(`[${jobId}]`, ...args),
        info: (...args) => console.info(`[${jobId}]`, ...args),
        log: (...args) => console.log(`[${jobId}]`, ...args),
        warn: (...args) => console.warn(`[${jobId}]`, ...args),
      },
      // eslint-disable-next-line @typescript-eslint/require-await
      wait: async () => {
        throw new Error('Not implemented');
      },
    };
  }
}

class BackgroundTaskFailedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'BackgroundTaskFailedError';
  }
}

class BackgroundTaskExceededRetriesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackgroundTaskExceededRetriesError';
  }
}
