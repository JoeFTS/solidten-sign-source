import { getJobSlotStats } from '@documenso/lib/jobs/client/job-slots';
import { getCertificateStatus } from '@documenso/lib/server-only/cert/cert-status';
import { getDatabaseWriteHealth } from '@documenso/lib/server-only/health/database-write-health';
import { canSeeHealthDetail } from '@documenso/lib/server-only/health/health-detail-access';
import { getJobHealth, type TJobHealth } from '@documenso/lib/server-only/jobs/job-health';
import { heavyPdfQueue } from '@documenso/lib/server-only/pdf/heavy-pdf-queue';
import { getPdfChildStats } from '@documenso/lib/server-only/pdf-child/run-pdf-operation';
import { getCapsReachedToday } from '@documenso/lib/server-only/rate-limit/server-cap-alerts';
import { prisma } from '@documenso/prisma';

type CheckStatus = 'ok' | 'warning' | 'degraded' | 'error';

export const loader = async ({ request }: { request: Request }) => {
  const checks: {
    database: { status: CheckStatus; writes?: 'ok' | 'failing' };
    certificate: { status: CheckStatus };
  } = {
    database: { status: 'ok' },
    certificate: { status: 'ok' },
  };

  let overallStatus: CheckStatus = 'ok';

  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    checks.database = { status: 'error' };
    overallStatus = 'error';
  }

  // Solid Ten (DISK-L2): the database answers reads but refuses writes (full disk, read-only).
  const databaseWrites = checks.database.status === 'ok' ? await getDatabaseWriteHealth() : null;

  if (databaseWrites?.writes === 'failing') {
    checks.database = { status: 'degraded', writes: 'failing' };
    overallStatus = 'degraded';
  }

  try {
    const certStatus = await getCertificateStatus();

    if (certStatus.isAvailable) {
      checks.certificate = { status: 'ok' };
    } else {
      checks.certificate = { status: 'warning' };

      if (overallStatus === 'ok') {
        overallStatus = 'warning';
      }
    }
  } catch {
    checks.certificate = { status: 'error' };
    overallStatus = 'error';
  }

  const body = { status: overallStatus, timestamp: new Date().toISOString(), checks };
  // Solid Ten: degraded (writes fail) is 503, so an uptime monitor alerts.
  const init = { status: overallStatus === 'error' ? 500 : overallStatus === 'degraded' ? 503 : 200 };

  // Solid Ten Sign: the detail below only for monitoring (a token, or a direct local call).
  if (!canSeeHealthDetail(request.headers)) {
    return Response.json(body, init);
  }

  // Solid Ten: background job counts so monitoring can alert (no secrets, counts only).
  const jobs: TJobHealth | null = await getJobHealth().catch(() => null);

  // Solid Ten Sign: server-wide daily caps reached today (forms or texts stopped until 00:00 UTC).
  const capsReachedToday = await getCapsReachedToday().catch(() => null);

  // Solid Ten: heavy PDF work in this process (LD2-A): one runs, the others wait their turn.
  const { isBusy, waiting } = heavyPdfQueue.stats();

  return Response.json(
    {
      ...body,
      jobs,
      capsReachedToday,
      pdfQueue: { busy: isBusy, waiting },
      // Solid Ten: heavy PDF work in child processes (runs, fallbacks to this process, children that died).
      pdfChild: getPdfChildStats(),
      // Solid Ten: this process's memory, so a retained-memory regression shows up (LD3-H1).
      memory: { rssMb: Math.round(process.memoryUsage().rss / (1024 * 1024)) },
      // Solid Ten: whether the database takes writes, and the last write it refused (DISK-L2).
      databaseWrites,
      // Solid Ten: background jobs running and waiting for a slot in this process (FS3-L1).
      jobSlots: getJobSlotStats(),
    },
    init,
  );
};
