import {
  FIELD_FILE_KIND_LABELS,
  FIELD_FILE_KINDS,
  FIELD_FILE_MAX_FILES_LIMIT,
  type TFieldFileKind,
} from '@documenso/lib/constants/field-file';
import { DEFAULT_FIELD_FONT_SIZE, type TFileFieldMeta, ZFileFieldMeta } from '@documenso/lib/types/field-meta';
import { Checkbox } from '@documenso/ui/primitives/checkbox';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@documenso/ui/primitives/form/form';
import { Input } from '@documenso/ui/primitives/input';
import { zodResolver } from '@hookform/resolvers/zod';
import { Trans } from '@lingui/react/macro';
import { useEffect, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';

import { EditorGenericLabelField, EditorGenericRequiredField } from './editor-field-generic-field-forms';

/**
 * Solid Ten: settings for an "Attach a file" field. The file-type list is collapsed by
 * default, so the panel keeps the same controls as the other fields until the sender
 * opens it.
 */
const ZFileFieldFormSchema = ZFileFieldMeta.pick({
  label: true,
  required: true,
  visibleToAllRecipients: true,
}).extend({
  maxFiles: z.coerce.number().int().min(1).max(FIELD_FILE_MAX_FILES_LIMIT),
  allowedFileTypes: z.array(z.enum(FIELD_FILE_KINDS)).min(1, { message: 'Choose at least one type of file' }),
});

type TFileFieldFormSchema = z.infer<typeof ZFileFieldFormSchema>;

type EditorFieldFileFormProps = {
  value: z.input<typeof ZFileFieldMeta> | undefined;
  onValueChange: (value: TFileFieldMeta) => void;
};

export const EditorFieldFileForm = ({ value = { type: 'file' }, onValueChange }: EditorFieldFileFormProps) => {
  const [showFileTypes, setShowFileTypes] = useState(false);

  const form = useForm<TFileFieldFormSchema>({
    resolver: zodResolver(ZFileFieldFormSchema),
    mode: 'onChange',
    defaultValues: {
      label: value.label || '',
      required: value.required || false,
      maxFiles: Number(value.maxFiles) || 1,
      allowedFileTypes: value.allowedFileTypes?.length ? value.allowedFileTypes : [...FIELD_FILE_KINDS],
      visibleToAllRecipients: value.visibleToAllRecipients || false,
    },
  });

  const formValues = useWatch({ control: form.control });

  useEffect(() => {
    const validated = ZFileFieldFormSchema.safeParse(formValues);

    if (!validated.success) {
      return;
    }

    const { allowedFileTypes, ...rest } = validated.data;

    onValueChange({
      type: 'file',
      fontSize: value.fontSize ?? DEFAULT_FIELD_FONT_SIZE,
      ...rest,
      // Every type allowed is stored as "no narrowing", so new types apply later.
      allowedFileTypes: allowedFileTypes.length === FIELD_FILE_KINDS.length ? undefined : allowedFileTypes,
    });
  }, [formValues]);

  return (
    <Form {...form}>
      <form onSubmit={(e) => e.preventDefault()}>
        <fieldset className="flex flex-col gap-2">
          <EditorGenericLabelField formControl={form.control} />

          <FormField
            control={form.control}
            name="maxFiles"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  <Trans>Number of files</Trans>
                </FormLabel>
                <FormControl>
                  <Input
                    data-testid="field-form-max-files"
                    type="number"
                    min={1}
                    max={FIELD_FILE_MAX_FILES_LIMIT}
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <EditorGenericRequiredField formControl={form.control} className="mt-2" />

          <FormField
            control={form.control}
            name="visibleToAllRecipients"
            render={({ field }) => (
              <FormItem className="flex items-center space-x-2">
                <FormControl>
                  <div className="flex items-center">
                    <Checkbox
                      data-testid="field-form-visible-to-all"
                      id="field-file-visible-to-all"
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />

                    <label className="ml-2 text-muted-foreground text-sm" htmlFor="field-file-visible-to-all">
                      <Trans>Visible to all recipients</Trans>
                    </label>
                  </div>
                </FormControl>
              </FormItem>
            )}
          />

          <button
            type="button"
            className="mt-2 self-start text-muted-foreground text-xs underline-offset-2 hover:underline"
            onClick={() => setShowFileTypes((show) => !show)}
            data-testid="field-form-file-types-toggle"
          >
            {showFileTypes ? <Trans>Hide allowed file types</Trans> : <Trans>Allowed file types</Trans>}
          </button>

          {showFileTypes && (
            <FormField
              control={form.control}
              name="allowedFileTypes"
              render={({ field }) => (
                <FormItem>
                  <div className="grid grid-cols-2 gap-1">
                    {FIELD_FILE_KINDS.map((kind: TFieldFileKind) => (
                      <div key={kind} className="flex items-center">
                        <Checkbox
                          id={`field-file-kind-${kind}`}
                          data-testid={`field-form-file-kind-${kind}`}
                          checked={field.value?.includes(kind)}
                          onCheckedChange={(checked) => {
                            const current = field.value ?? [];

                            field.onChange(
                              checked
                                ? FIELD_FILE_KINDS.filter(
                                    (candidate) => candidate === kind || current.includes(candidate),
                                  )
                                : current.filter((candidate) => candidate !== kind),
                            );
                          }}
                        />
                        <label className="ml-2 text-muted-foreground text-xs" htmlFor={`field-file-kind-${kind}`}>
                          {FIELD_FILE_KIND_LABELS[kind]}
                        </label>
                      </div>
                    ))}
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />
          )}
        </fieldset>
      </form>
    </Form>
  );
};
