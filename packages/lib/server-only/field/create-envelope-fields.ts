import { plainRefusal } from '@documenso/lib/errors/plain-refusal';
import { DOCUMENT_AUDIT_LOG_TYPE } from '@documenso/lib/types/document-audit-logs';
import type { TFieldAndMeta } from '@documenso/lib/types/field-meta';
import type { ApiRequestMetadata } from '@documenso/lib/universal/extract-request-metadata';
import { getFileServerSide } from '@documenso/lib/universal/upload/get-file.server';
import { putPdfFileServerSide } from '@documenso/lib/universal/upload/put-file.server';
import { createDocumentAuditLogData } from '@documenso/lib/utils/document-audit-logs';
import { prisma } from '@documenso/prisma';
import { EnvelopeType } from '@prisma/client';
import { AppError, AppErrorCode } from '../../errors/app-error';
import type { EnvelopeIdOptions } from '../../utils/envelope';
import { mapFieldToLegacyField } from '../../utils/fields';
import { canRecipientFieldsBeModified } from '../../utils/recipients';
import { assertEnvelopeMutable } from '../envelope/assert-envelope-mutable';
import { getEnvelopeWhereInput } from '../envelope/get-envelope-by-id';
import { assertFieldLogicAllowed, toFieldLogicDefinitions } from '../field-logic/assert-field-logic';
import type { BoundingBox } from '../pdf/auto-place-fields';
import { findTextInPdfIsolated, whiteoutRegionsIsolated } from '../pdf-child/isolated-pdf';

type CoordinatePosition = {
  page: number;
  positionX: number;
  positionY: number;
  width: number;
  height: number;
};

type PlaceholderPosition = {
  placeholder: string;
  width?: number;
  height?: number;
  /**
   * When true, creates a field at every occurrence of the placeholder in the PDF.
   * When false or omitted, only the first occurrence is used.
   */
  matchAll?: boolean;
};

type FieldPosition = CoordinatePosition | PlaceholderPosition;

export type CreateEnvelopeFieldInput = TFieldAndMeta & {
  /**
   * The ID of the item to insert the fields into.
   *
   * If blank, the first item will be used.
   */
  envelopeItemId?: string;

  recipientId: number;
} & FieldPosition;

export interface CreateEnvelopeFieldsOptions {
  userId: number;
  teamId: number;
  id: EnvelopeIdOptions;

  fields: CreateEnvelopeFieldInput[];
  requestMetadata: ApiRequestMetadata;
}

const isPlaceholderPosition = (position: FieldPosition): position is PlaceholderPosition => {
  return 'placeholder' in position;
};

export const createEnvelopeFields = async ({
  userId,
  teamId,
  id,
  fields,
  requestMetadata,
}: CreateEnvelopeFieldsOptions) => {
  const { envelopeWhereInput } = await getEnvelopeWhereInput({
    id,
    type: null, // Null to allow any type of envelope.
    userId,
    teamId,
  });

  const envelope = await prisma.envelope.findFirst({
    where: envelopeWhereInput,
    include: {
      recipients: true,
      fields: true,
      envelopeItems: {
        include: {
          documentData: true,
        },
      },
    },
  });

  if (!envelope) {
    throw new AppError(AppErrorCode.NOT_FOUND, {
      message: 'Envelope not found',
    });
  }

  assertEnvelopeMutable(envelope);

  if (envelope.type === EnvelopeType.DOCUMENT && envelope.completedAt) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Envelope already complete',
    });
  }

  const firstEnvelopeItem = envelope.envelopeItems[0];

  if (!firstEnvelopeItem) {
    throw new AppError(AppErrorCode.NOT_FOUND, {
      message: 'Envelope item not found',
    });
  }

  const hasPlaceholderFields = fields.some((field) => isPlaceholderPosition(field));

  /*
    Solid Ten (AUD-2 follow-up): placeholder text is searched in the PDF child (never in this
    process), once per envelope item that has placeholder fields. Only the match boxes and page
    sizes come back; the bytes are kept for the whiteout below, which also runs in the child.
  */
  const pdfCache = new Map<
    string,
    {
      bytes: Uint8Array;
      pages: Array<{ width: number; height: number }>;
      textMatches: Record<string, Array<{ pageIndex: number; bbox: BoundingBox }>>;
    }
  >();

  if (hasPlaceholderFields) {
    const needlesByItem = new Map<string, Set<string>>();

    for (const field of fields) {
      if (isPlaceholderPosition(field)) {
        const itemId = field.envelopeItemId || firstEnvelopeItem.id;
        needlesByItem.set(itemId, (needlesByItem.get(itemId) ?? new Set()).add(field.placeholder));
      }
    }

    for (const item of envelope.envelopeItems) {
      const needles = needlesByItem.get(item.id);

      if (!needles) {
        continue;
      }

      const bytes = new Uint8Array(await getFileServerSide(item.documentData));
      const { pages, textMatches } = await findTextInPdfIsolated(bytes, [...needles]);

      pdfCache.set(item.id, { bytes, pages, textMatches });
    }
  }

  /*
    Collect placeholder bounding boxes that need to be whited out, grouped by
    envelope item ID. Populated during field resolution below.
  */
  const placeholderWhiteouts = new Map<string, Array<{ pageIndex: number; bbox: BoundingBox }>>();

  // Field validation and placeholder resolution.
  const validatedFields = fields.flatMap((field) => {
    const recipient = envelope.recipients.find((recipient) => recipient.id === field.recipientId);

    // The item to attach the fields to MUST belong to the document.
    if (
      field.envelopeItemId &&
      !envelope.envelopeItems.find((envelopeItem) => envelopeItem.id === field.envelopeItemId)
    ) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: 'Item to attach fields to must belong to the document',
      });
    }

    // Each field MUST have a recipient associated with it.
    if (!recipient) {
      throw plainRefusal(
        AppErrorCode.INVALID_REQUEST,
        'A field belongs to a recipient who is not on this document. Reload the page and try again.',
        { recipientId: field.recipientId },
      );
    }

    // Check whether the recipient associated with the field can have new fields created.
    if (!canRecipientFieldsBeModified(recipient, envelope.fields)) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: 'Recipient type cannot have fields, or they have already interacted with the document.',
      });
    }

    const envelopeItemId = field.envelopeItemId || firstEnvelopeItem.id;

    /*
      Resolve field position(s). Placeholder fields are resolved by searching the
      PDF text for the placeholder string and using its bounding box.
      When matchAll is true, all occurrences produce fields.
    */
    if (isPlaceholderPosition(field)) {
      const pdfDoc = pdfCache.get(envelopeItemId);

      if (!pdfDoc) {
        throw plainRefusal(
          AppErrorCode.NOT_FOUND,
          'The PDF of this document could not be read. Try again, or upload the file again.',
          { envelopeItemId },
        );
      }

      const matches = pdfDoc.textMatches[field.placeholder] ?? [];

      if (matches.length === 0) {
        throw new AppError(AppErrorCode.INVALID_BODY, {
          message: `Placeholder "${field.placeholder}" not found in PDF`,
        });
      }

      const matchesToProcess = field.matchAll ? matches : [matches[0]];
      const { pages } = pdfDoc;

      return matchesToProcess.map((match) => {
        const page = pages[match.pageIndex];

        /*
          Record this placeholder's bounding box for whiteout. The bbox is in
          the original PDF coordinate system (points, bottom-left origin).
        */
        if (!placeholderWhiteouts.has(envelopeItemId)) {
          placeholderWhiteouts.set(envelopeItemId, []);
        }

        placeholderWhiteouts.get(envelopeItemId)!.push({
          pageIndex: match.pageIndex,
          bbox: match.bbox,
        });

        /*
          Convert point-based coordinates (bottom-left origin) to percentage-based
          coordinates (top-left origin) matching the system's field coordinate format.
        */
        const topLeftY = page.height - match.bbox.y - match.bbox.height;

        const widthPercent = field.width ?? (match.bbox.width / page.width) * 100;
        const heightPercent = field.height ?? (match.bbox.height / page.height) * 100;

        return {
          type: field.type,
          fieldMeta: field.fieldMeta,
          recipientId: field.recipientId,
          envelopeItemId,
          recipientEmail: recipient.email,
          page: match.pageIndex + 1,
          positionX: (match.bbox.x / page.width) * 100,
          positionY: (topLeftY / page.height) * 100,
          width: widthPercent,
          height: heightPercent,
        };
      });
    }

    return {
      type: field.type,
      fieldMeta: field.fieldMeta,
      recipientId: field.recipientId,
      envelopeItemId,
      recipientEmail: recipient.email,
      page: field.page,
      positionX: field.positionX,
      positionY: field.positionY,
      width: field.width,
      height: field.height,
    };
  });

  await assertFieldLogicAllowed({
    envelope,
    fields: toFieldLogicDefinitions([...envelope.fields, ...validatedFields]),
    existingFields: envelope.fields,
  });

  const createdFields = await prisma.$transaction(async (tx) => {
    await assertEnvelopeMutable(envelope, tx);

    const newlyCreatedFields = await tx.field.createManyAndReturn({
      data: validatedFields.map((field) => ({
        type: field.type,
        page: field.page,
        positionX: field.positionX,
        positionY: field.positionY,
        width: field.width,
        height: field.height,
        customText: '',
        inserted: false,
        fieldMeta: field.fieldMeta,
        envelopeId: envelope.id,
        envelopeItemId: field.envelopeItemId,
        recipientId: field.recipientId,
      })),
    });

    // Handle field created audit log.
    if (envelope.type === EnvelopeType.DOCUMENT) {
      await tx.documentAuditLog.createMany({
        data: newlyCreatedFields.map((createdField) => {
          const recipient = validatedFields.find((field) => field.recipientId === createdField.recipientId);

          return createDocumentAuditLogData({
            type: DOCUMENT_AUDIT_LOG_TYPE.FIELD_CREATED,
            envelopeId: envelope.id,
            metadata: requestMetadata,
            data: {
              fieldId: createdField.secondaryId,
              fieldRecipientEmail: recipient?.recipientEmail || '',
              fieldRecipientId: createdField.recipientId,
              fieldType: createdField.type,
            },
          });
        }),
      });
    }

    return newlyCreatedFields;
  });

  /*
    Draw white rectangles over each resolved placeholder in the PDF to hide the
    placeholder text, then persist the modified PDFs back to document storage.
  */
  for (const [envelopeItemId, whiteouts] of placeholderWhiteouts) {
    const pdfDoc = pdfCache.get(envelopeItemId);

    if (!pdfDoc) {
      continue;
    }

    const modifiedPdfBytes = await whiteoutRegionsIsolated(pdfDoc.bytes, whiteouts);

    const envelopeItem = envelope.envelopeItems.find((item) => item.id === envelopeItemId);

    if (!envelopeItem) {
      continue;
    }

    const { documentData: newDocumentData } = await putPdfFileServerSide({
      name: 'document.pdf',
      type: 'application/pdf',
      arrayBuffer: async () => Promise.resolve(Buffer.from(modifiedPdfBytes)),
    });

    await prisma.envelopeItem.update({
      where: { id: envelopeItemId },
      data: { documentDataId: newDocumentData.id },
    });
  }

  return {
    fields: createdFields.map((field) => mapFieldToLegacyField(field, envelope)),
  };
};
