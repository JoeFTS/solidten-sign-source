import { prisma } from '@documenso/prisma';
import { EnvelopeType, FieldType } from '@prisma/client';

import { IS_FILE_UPLOAD_ENABLED } from '../../constants/field-file';
import { AppError, AppErrorCode } from '../../errors/app-error';
import { isTspEnvelope } from '../../types/signature-level';

type FieldLike = {
  id?: number | null;
  type?: FieldType | string;
  fieldMeta?: unknown;
};

/**
 * A field is an "Attach a file" field by its type or, where only the meta was loaded, by
 * the meta's own type tag.
 */
export const isFileField = (field: FieldLike) => {
  if (field.type === FieldType.FILE) {
    return true;
  }

  const meta = field.fieldMeta;

  return typeof meta === 'object' && meta !== null && !Array.isArray(meta) && 'type' in meta && meta.type === 'file';
};

export type AssertFileFieldsAllowedOptions = {
  envelope: {
    id: string;
    type: EnvelopeType;
    internalVersion: number;
    signatureLevel: string;
  };
  fields: FieldLike[];
  existingFields?: { id: number; type?: FieldType | string; fieldMeta?: unknown }[];
};

/**
 * Refuse a field save that would place "Attach a file" fields where they cannot work:
 * version 1 envelopes, advanced or qualified signatures, templates with a direct link, or
 * a server that has the feature turned off (fields stored before it was turned off stay).
 */
export const assertFileFieldsAllowed = async ({
  envelope,
  fields,
  existingFields = [],
}: AssertFileFieldsAllowedOptions) => {
  const fileFields = fields.filter(isFileField);

  if (fileFields.length === 0) {
    return;
  }

  if (!IS_FILE_UPLOAD_ENABLED()) {
    const hasNewFileField = fileFields.some(
      (field) => !existingFields.some((existing) => existing.id === field.id && isFileField(existing)),
    );

    if (hasNewFileField) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: '"Attach a file" fields are turned off on this server.',
      });
    }
  }

  if (envelope.internalVersion !== 2) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: '"Attach a file" fields need a version 2 envelope.',
    });
  }

  if (isTspEnvelope(envelope)) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: '"Attach a file" fields cannot be used with advanced or qualified signatures.',
    });
  }

  if (envelope.type === EnvelopeType.TEMPLATE) {
    const directLink = await prisma.templateDirectLink.findFirst({
      where: {
        envelopeId: envelope.id,
      },
      select: {
        id: true,
      },
    });

    if (directLink) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: '"Attach a file" fields cannot be used on a template with a direct link or public form.',
      });
    }
  }
};

/**
 * A direct link (now a public form) creates the document and signs it in one request,
 * with no signing token to upload against, so templates with "Attach a file" fields
 * cannot have one.
 */
export const assertNoFileFieldsForDirectTemplate = (fields: FieldLike[]) => {
  if (fields.some(isFileField)) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message:
        'This template has an "Attach a file" field, so it cannot be used as a direct link or public form. Remove the field or send the template as a document.',
    });
  }
};
