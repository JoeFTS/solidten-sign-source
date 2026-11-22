import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { FIELD_FILE_KIND_LABELS } from '@documenso/lib/constants/field-file';
import { AppError } from '@documenso/lib/errors/app-error';
import type { TFileFieldMeta } from '@documenso/lib/types/field-meta';
import {
  formatFileSize,
  getFieldFileTokenDownloadPath,
  getFileInputAccept,
  resolveAllowedFileKinds,
  resolveFieldMaxFiles,
} from '@documenso/lib/utils/field-file';
import { trpc } from '@documenso/trpc/react';
import type { TSignEnvelopeFieldResponse } from '@documenso/trpc/server/envelope-router/sign-envelope-field.types';
import type { TFieldFileSummary } from '@documenso/trpc/server/field-file-router/schema';
import { Button } from '@documenso/ui/primitives/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@documenso/ui/primitives/dialog';
import { Trans, useLingui } from '@lingui/react/macro';
import { FileIcon, Loader2Icon } from 'lucide-react';
import { useRef, useState } from 'react';
import { createCallable } from 'react-call';

export type SignFieldFileDialogProps = {
  token: string;
  fieldId: number;
  recipientId: number;
  fieldMeta?: TFileFieldMeta;
};

/**
 * The last change the server made, for the signing page to apply. Null when nothing
 * changed.
 */
export type SignFieldFileDialogResult = TSignEnvelopeFieldResponse | null;

/**
 * Solid Ten: attach, replace or remove the files of an "Attach a file" field. Each action
 * is saved to the server at once; the dialog only shows the result.
 */
export const SignFieldFileDialog = createCallable<SignFieldFileDialogProps, SignFieldFileDialogResult>(
  ({ call, token, fieldId, recipientId, fieldMeta }) => {
    const { t } = useLingui();

    const inputRef = useRef<HTMLInputElement>(null);
    const replaceTargetRef = useRef<string | null>(null);

    const [lastResult, setLastResult] = useState<SignFieldFileDialogResult>(null);
    const [error, setError] = useState<string | null>(null);

    const utils = trpc.useUtils();

    const { data, isLoading } = trpc.fieldFile.listForSigner.useQuery({ token });

    const { mutateAsync: uploadFile, isPending: isUploading } = trpc.fieldFile.upload.useMutation();
    const { mutateAsync: removeFile, isPending: isRemoving } = trpc.fieldFile.remove.useMutation();

    const isBusy = isUploading || isRemoving;

    const files: TFieldFileSummary[] = (data?.files ?? []).filter(
      (file) => file.fieldId === fieldId && file.recipientId === recipientId,
    );

    const maxFiles = resolveFieldMaxFiles(fieldMeta?.maxFiles);
    const allowedKinds = resolveAllowedFileKinds(fieldMeta?.allowedFileTypes);

    const toMessage = (err: unknown) => {
      const parsed = AppError.parseError(err);

      return parsed.message || t`The file could not be saved. Try again.`;
    };

    const onPickFile = async (file: File) => {
      setError(null);

      if (data?.maxFileBytes && file.size > data.maxFileBytes) {
        setError(t`The file is larger than ${formatFileSize(data.maxFileBytes)}.`);
        return;
      }

      const formData = new FormData();

      formData.append(
        'payload',
        JSON.stringify({ token, fieldId, replaceFileId: replaceTargetRef.current ?? undefined }),
      );
      formData.append('file', file);

      try {
        const result = await uploadFile(formData);

        setLastResult({ signedField: result.signedField, affectedFields: result.affectedFields });
      } catch (err) {
        setError(toMessage(err));
      } finally {
        replaceTargetRef.current = null;
        await utils.fieldFile.listForSigner.invalidate({ token });
      }
    };

    const onRemove = async (fileId: string) => {
      setError(null);

      try {
        const result = await removeFile({ token, fieldId, fileId });

        setLastResult({ signedField: result.signedField, affectedFields: result.affectedFields });
      } catch (err) {
        setError(toMessage(err));
      } finally {
        await utils.fieldFile.listForSigner.invalidate({ token });
      }
    };

    const openPicker = (replaceFileId: string | null) => {
      replaceTargetRef.current = replaceFileId;
      inputRef.current?.click();
    };

    return (
      <Dialog open={true} onOpenChange={(value) => (!value && !isBusy ? call.end(lastResult) : null)}>
        <DialogContent data-testid="sign-field-file-dialog">
          <DialogHeader>
            <DialogTitle>{fieldMeta?.label || <Trans>Attach a file</Trans>}</DialogTitle>

            <DialogDescription className="mt-4">
              {maxFiles === 1 ? <Trans>Attach one file.</Trans> : <Trans>Attach up to {maxFiles} files.</Trans>}{' '}
              <Trans>Allowed: {allowedKinds.map((kind) => FIELD_FILE_KIND_LABELS[kind]).join(', ')}.</Trans>
              {data?.maxFileBytes ? (
                <>
                  {' '}
                  <Trans>Largest file: {formatFileSize(data.maxFileBytes)}.</Trans>
                </>
              ) : null}
            </DialogDescription>
          </DialogHeader>

          <input
            ref={inputRef}
            type="file"
            className="hidden"
            data-testid="sign-field-file-input"
            accept={getFileInputAccept(allowedKinds)}
            onChange={(event) => {
              const file = event.target.files?.[0];

              event.target.value = '';

              if (file) {
                void onPickFile(file);
              }
            }}
          />

          <div className="space-y-2">
            {isLoading && (
              <div className="flex items-center text-muted-foreground text-sm">
                <Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
                <Trans>Loading</Trans>
              </div>
            )}

            {files.map((file) => (
              <div
                key={file.id}
                className="flex items-center gap-2 rounded-md border border-border p-2 text-sm"
                data-testid="sign-field-file-item"
              >
                <FileIcon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />

                <a
                  className="min-w-0 flex-1 truncate underline-offset-2 hover:underline"
                  href={`${NEXT_PUBLIC_WEBAPP_URL()}${getFieldFileTokenDownloadPath(token, file.id)}`}
                  download={file.fileName}
                >
                  {file.fileName}
                </a>

                <span className="flex-shrink-0 text-muted-foreground text-xs">{formatFileSize(file.size)}</span>

                <Button type="button" variant="ghost" size="sm" disabled={isBusy} onClick={() => openPicker(file.id)}>
                  <Trans>Replace</Trans>
                </Button>

                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-destructive"
                  disabled={isBusy}
                  onClick={() => void onRemove(file.id)}
                >
                  <Trans>Remove</Trans>
                </Button>
              </div>
            ))}

            {error && (
              <p className="text-destructive text-sm" role="alert" data-testid="sign-field-file-error">
                {error}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="secondary" disabled={isBusy} onClick={() => call.end(lastResult)}>
              <Trans>Done</Trans>
            </Button>

            {files.length < maxFiles && (
              <Button
                type="button"
                loading={isUploading}
                disabled={isBusy || isLoading}
                onClick={() => openPicker(null)}
              >
                {files.length === 0 ? <Trans>Choose file</Trans> : <Trans>Add another file</Trans>}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  },
);
