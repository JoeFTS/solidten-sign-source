import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import type { TEnvelope } from '@documenso/lib/types/envelope';
import { formatFileSize, getFieldFileEnvelopeDownloadPath } from '@documenso/lib/utils/field-file';
import { trpc } from '@documenso/trpc/react';
import { useLingui } from '@lingui/react/macro';
import { FieldType } from '@prisma/client';
import { DateTime } from 'luxon';

export type DocumentPageViewAttachedFilesProps = {
  envelope: Pick<TEnvelope, 'id' | 'fields'>;
};

/**
 * Solid Ten: the files signers attached, for the sender's document page. Shown only when
 * the document has an "Attach a file" field.
 */
export const DocumentPageViewAttachedFiles = ({ envelope }: DocumentPageViewAttachedFilesProps) => {
  const { t, i18n } = useLingui();

  const hasFileFields = envelope.fields.some((field) => field.type === FieldType.FILE);

  const { data } = trpc.fieldFile.listForEnvelope.useQuery({ envelopeId: envelope.id }, { enabled: hasFileFields });

  if (!hasFileFields || !data) {
    return null;
  }

  return (
    <section
      className="flex flex-col rounded-xl border border-border bg-widget dark:bg-background"
      data-testid="document-attached-files"
    >
      <div className="px-4 py-3">
        <h1 className="font-medium text-foreground">{t`Attached files`}</h1>
      </div>

      {data.files.length === 0 ? (
        <p className="border-t px-4 py-3 text-muted-foreground text-sm">{t`No files attached yet.`}</p>
      ) : (
        <ul className="divide-y border-t text-muted-foreground">
          {data.files.map((file) => (
            <li key={file.id} className="px-4 py-2.5 text-sm">
              <a
                className="block truncate font-medium text-foreground underline-offset-2 hover:underline"
                href={`${NEXT_PUBLIC_WEBAPP_URL()}${getFieldFileEnvelopeDownloadPath(envelope.id, file.id)}`}
                download={file.fileName}
              >
                {file.fileName}
              </a>
              <p className="text-xs">
                {formatFileSize(file.size)} · {file.uploaderName || file.uploaderEmail} ·{' '}
                {DateTime.fromJSDate(file.createdAt).setLocale(i18n.locale).toLocaleString(DateTime.DATETIME_SHORT)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
