import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import type { TFieldFile } from '@documenso/lib/types/field';
import { FieldType } from '@prisma/client';

import { SignFieldFileDialog, type SignFieldFileDialogResult } from '~/components/dialogs/sign-field-file-dialog';

type HandleFileFieldClickOptions = {
  field: TFieldFile;
  token: string;
  isDirectTemplate: boolean;
};

/**
 * Solid Ten: open the file dialog for an "Attach a file" field. Uploads and removals are
 * saved by the dialog; the result is the last field change, for the page to apply.
 *
 * Direct-link templates cannot hold these fields (the server refuses them), so the
 * dialog never opens there.
 */
export const handleFileFieldClick = async ({
  field,
  token,
  isDirectTemplate,
}: HandleFileFieldClickOptions): Promise<SignFieldFileDialogResult> => {
  if (field.type !== FieldType.FILE) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Invalid field type',
    });
  }

  if (isDirectTemplate) {
    return null;
  }

  return await SignFieldFileDialog.call({
    token,
    fieldId: field.id,
    recipientId: field.recipientId,
    fieldMeta: field.fieldMeta,
  });
};
