import { downloadFile } from '@documenso/lib/client-only/download-file';
import {
  buildDocumentUsageCsv,
  buildMemberUsageCsv,
  formatDurationShort,
  type TUsageReportMemberSummary,
  type TUsageReportSummary,
} from '@documenso/lib/utils/usage-report';
import { trpc } from '@documenso/trpc/react';
import { Button } from '@documenso/ui/primitives/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@documenso/ui/primitives/card';
import { Skeleton } from '@documenso/ui/primitives/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@documenso/ui/primitives/table';
import { useToast } from '@documenso/ui/primitives/use-toast';
import { Trans, useLingui } from '@lingui/react/macro';
import { DownloadIcon } from 'lucide-react';
import { useState } from 'react';

import { AnalyticsQueryError } from './analytics-query-error';

type TRangeInput = {
  timezone: string;
  range: 'custom' | '7d' | '30d' | '90d' | '12m';
  from?: string;
  to?: string;
};

export type AnalyticsUsageReportCardProps = {
  scope: { type: 'team'; teamId: number } | { type: 'organisation'; organisationId: string };
  rangeInput: TRangeInput;
  /** Used in the CSV file names, for example the team URL. */
  fileNamePrefix: string;
};

export const AnalyticsUsageReportCard = ({ scope, rangeInput, fileNamePrefix }: AnalyticsUsageReportCardProps) => {
  const { t } = useLingui();
  const { toast } = useToast();
  const utils = trpc.useUtils();

  const [isDownloadingDocuments, setIsDownloadingDocuments] = useState(false);

  const teamQuery = trpc.usageReport.getTeam.useQuery(
    { ...rangeInput, teamId: scope.type === 'team' ? scope.teamId : 0 },
    { enabled: scope.type === 'team' },
  );

  const organisationQuery = trpc.usageReport.getOrganisation.useQuery(
    { ...rangeInput, organisationId: scope.type === 'organisation' ? scope.organisationId : '' },
    { enabled: scope.type === 'organisation' },
  );

  const query = scope.type === 'team' ? teamQuery : organisationQuery;
  const data = query.data;

  const fileSuffix = data ? `${data.range.from}_to_${data.range.to}` : 'report';

  const onDownloadMembers = () => {
    if (!data) {
      return;
    }

    downloadFile({
      filename: `${fileNamePrefix}-members-${fileSuffix}.csv`,
      data: new Blob([buildMemberUsageCsv(data.members)], { type: 'text/csv;charset=utf-8' }),
    });
  };

  const onDownloadDocuments = async () => {
    setIsDownloadingDocuments(true);

    try {
      const result =
        scope.type === 'team'
          ? await utils.usageReport.getTeamDocuments.fetch({ ...rangeInput, teamId: scope.teamId })
          : await utils.usageReport.getOrganisationDocuments.fetch({
              ...rangeInput,
              organisationId: scope.organisationId,
            });

      downloadFile({
        filename: `${fileNamePrefix}-documents-${result.range.from}_to_${result.range.to}.csv`,
        data: new Blob([buildDocumentUsageCsv(result.documents, { includeTeam: scope.type === 'organisation' })], {
          type: 'text/csv;charset=utf-8',
        }),
      });

      if (result.isTruncated) {
        toast({
          title: t`Only the newest documents were included`,
          description: t`Choose a shorter date range to export everything.`,
        });
      }
    } catch {
      toast({
        title: t`Something went wrong`,
        description: t`We could not build the document list. Please try again.`,
        variant: 'destructive',
      });
    } finally {
      setIsDownloadingDocuments(false);
    }
  };

  return (
    <Card data-testid="analytics-usage-report">
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle className="text-base">
            <Trans>Usage report</Trans>
          </CardTitle>
          <CardDescription>
            <Trans>Outcomes and time to complete for documents sent in this period</Trans>
          </CardDescription>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!data}
            onClick={onDownloadMembers}
            data-testid="usage-report-download-members"
          >
            <DownloadIcon className="mr-1.5 h-3.5 w-3.5" />
            <Trans>Members CSV</Trans>
          </Button>

          <Button
            variant="outline"
            size="sm"
            loading={isDownloadingDocuments}
            onClick={() => void onDownloadDocuments()}
            data-testid="usage-report-download-documents"
          >
            <DownloadIcon className="mr-1.5 h-3.5 w-3.5" />
            <Trans>Documents CSV</Trans>
          </Button>
        </div>
      </CardHeader>

      <CardContent>
        {query.isError ? (
          <AnalyticsQueryError onRetry={query.refetch} />
        ) : !data ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <div className="flex flex-col gap-6">
            <UsageSummaryTiles summary={data.summary} />
            <UsageMemberTable members={data.members} />
          </div>
        )}
      </CardContent>
    </Card>
  );
};

const UsageSummaryTiles = ({ summary }: { summary: TUsageReportSummary }) => {
  const { t } = useLingui();

  const tiles = [
    { key: 'declined', label: t`Declined`, value: String(summary.declined) },
    { key: 'expired', label: t`Expired`, value: String(summary.expired) },
    { key: 'cancelled', label: t`Cancelled`, value: String(summary.cancelled) },
    {
      key: 'average',
      label: t`Average time to complete`,
      value: formatDurationShort(summary.timeToComplete.averageMs) ?? '-',
    },
    {
      key: 'median',
      label: t`Median time to complete`,
      value: formatDurationShort(summary.timeToComplete.medianMs) ?? '-',
    },
  ];

  return (
    <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
      {tiles.map((tile) => (
        <div key={tile.key} className="rounded-lg border p-3">
          <dt className="text-muted-foreground text-xs">{tile.label}</dt>
          <dd
            className="mt-1 font-semibold text-foreground text-xl tabular-nums"
            data-testid={`usage-report-${tile.key}`}
          >
            {tile.value}
          </dd>
        </div>
      ))}
    </dl>
  );
};

const UsageMemberTable = ({ members }: { members: TUsageReportMemberSummary[] }) => {
  if (members.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        <Trans>No members</Trans>
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>
              <Trans>Member</Trans>
            </TableHead>
            <TableHead className="text-right">
              <Trans>Sent</Trans>
            </TableHead>
            <TableHead className="text-right">
              <Trans>Completed</Trans>
            </TableHead>
            <TableHead className="text-right">
              <Trans>Declined</Trans>
            </TableHead>
            <TableHead className="text-right">
              <Trans>Expired</Trans>
            </TableHead>
            <TableHead className="text-right">
              <Trans>Cancelled</Trans>
            </TableHead>
            <TableHead className="text-right">
              <Trans>Average</Trans>
            </TableHead>
            <TableHead className="text-right">
              <Trans>Median</Trans>
            </TableHead>
          </TableRow>
        </TableHeader>

        <TableBody>
          {members.map((member) => (
            <TableRow key={member.userId} data-testid="usage-report-member-row">
              <TableCell>
                <div className="font-medium">{member.name || member.email}</div>
                {member.name && <div className="text-muted-foreground text-xs">{member.email}</div>}
              </TableCell>
              <TableCell className="text-right tabular-nums">{member.sent}</TableCell>
              <TableCell className="text-right tabular-nums">{member.completed}</TableCell>
              <TableCell className="text-right tabular-nums">{member.declined}</TableCell>
              <TableCell className="text-right tabular-nums">{member.expired}</TableCell>
              <TableCell className="text-right tabular-nums">{member.cancelled}</TableCell>
              <TableCell className="text-right tabular-nums">
                {formatDurationShort(member.timeToComplete.averageMs) ?? '-'}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatDurationShort(member.timeToComplete.medianMs) ?? '-'}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
};
