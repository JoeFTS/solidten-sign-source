import {
  DEFAULT_FIELD_FONT_SIZE,
  FIELD_DEFAULT_GENERIC_ALIGN,
  FIELD_DEFAULT_GENERIC_VERTICAL_ALIGN,
  FIELD_DEFAULT_LETTER_SPACING,
  FIELD_DEFAULT_LINE_HEIGHT,
  type TTextFieldMeta as TextFieldMeta,
  ZTextFieldMeta,
} from '@documenso/lib/types/field-meta';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@documenso/ui/primitives/form/form';
import { Input } from '@documenso/ui/primitives/input';
import { Textarea } from '@documenso/ui/primitives/textarea';
import { zodResolver } from '@hookform/resolvers/zod';
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import type { z } from 'zod';

import {
  EditorGenericFontSizeField,
  EditorGenericLetterSpacingField,
  EditorGenericLineHeightField,
  EditorGenericReadOnlyField,
  EditorGenericRequiredField,
  EditorGenericTextAlignField,
  EditorGenericVerticalAlignField,
} from './editor-field-generic-field-forms';

const ZTextFieldFormSchema = ZTextFieldMeta.pick({
  label: true,
  placeholder: true,
  text: true,
  characterLimit: true,
  fontSize: true,
  textAlign: true,
  lineHeight: true,
  letterSpacing: true,
  verticalAlign: true,
  required: true,
  readOnly: true,
})
  .refine(
    (data) => {
      // A read-only field must have text
      return !data.readOnly || (data.text && data.text.length > 0);
    },
    {
      message: 'A read-only field must have text',
      path: ['text'],
    },
  )
  .refine(
    // Solid Ten Sign (F-5): the text is never cut to fit a limit. A limit shorter than the text is
    // shown as an error (and not saved) until the sender changes one of them.
    (data) => !data.characterLimit || !data.text || data.text.length <= data.characterLimit,
    {
      message: 'The text is longer than the character limit. Shorten the text or raise the limit.',
      path: ['characterLimit'],
    },
  );

type TTextFieldFormSchema = z.infer<typeof ZTextFieldFormSchema>;

type EditorFieldTextFormProps = {
  value: TextFieldMeta | undefined;
  onValueChange: (value: TextFieldMeta) => void;
};

export const EditorFieldTextForm = ({
  value = {
    type: 'text',
  },
  onValueChange,
}: EditorFieldTextFormProps) => {
  const { t } = useLingui();

  const form = useForm<TTextFieldFormSchema>({
    resolver: zodResolver(ZTextFieldFormSchema),
    mode: 'onChange',
    defaultValues: {
      label: value.label || '',
      placeholder: value.placeholder || '',
      text: value.text || '',
      characterLimit: value.characterLimit || 0,
      fontSize: value.fontSize || DEFAULT_FIELD_FONT_SIZE,
      textAlign: value.textAlign ?? FIELD_DEFAULT_GENERIC_ALIGN,
      lineHeight: value.lineHeight ?? FIELD_DEFAULT_LINE_HEIGHT,
      letterSpacing: value.letterSpacing ?? FIELD_DEFAULT_LETTER_SPACING,
      verticalAlign: value.verticalAlign ?? FIELD_DEFAULT_GENERIC_VERTICAL_ALIGN,
      required: value.required || false,
      readOnly: value.readOnly || false,
    },
  });

  const { control } = form;

  const formValues = useWatch({
    control,
  });

  // Dupecode/Inefficient: Done because native isValid won't work for our usecase.
  useEffect(() => {
    const validatedFormValues = ZTextFieldFormSchema.safeParse(formValues);

    if (formValues.readOnly && !formValues.text) {
      void form.trigger('text');
    }

    if (validatedFormValues.success) {
      onValueChange({
        type: 'text',
        ...validatedFormValues.data,
      });
    }
  }, [formValues]);

  return (
    <Form {...form}>
      <form onSubmit={(e) => e.preventDefault()}>
        <fieldset className="flex flex-col gap-2">
          <EditorGenericFontSizeField className="w-full" formControl={form.control} />

          <div className="flex w-full flex-row gap-x-4">
            <EditorGenericTextAlignField className="w-full" formControl={form.control} />

            <EditorGenericVerticalAlignField className="w-full" formControl={form.control} />
          </div>

          <FormField
            control={form.control}
            name="label"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  <Trans>Label</Trans>
                </FormLabel>
                <FormControl>
                  <Input data-testid="field-form-label" placeholder={t`Field label`} {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="placeholder"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  <Trans>Placeholder</Trans>
                </FormLabel>
                <FormControl>
                  <Input data-testid="field-form-placeholder" placeholder={t`Field placeholder`} {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="text"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  <Trans>Add text</Trans>
                </FormLabel>
                <FormControl>
                  <Textarea
                    data-testid="field-form-text"
                    className="h-auto"
                    placeholder={t`Add text to the field`}
                    {...field}
                    onChange={(e) => {
                      field.onChange(e);

                      // Solid Ten Sign (F-5): re-check the limit against the new text (no cutting).
                      void form.trigger('characterLimit');
                    }}
                    rows={1}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="characterLimit"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  <Trans>Character Limit</Trans>
                </FormLabel>
                <FormControl>
                  <Input
                    data-testid="field-form-characterLimit"
                    className="bg-background"
                    placeholder={t`Character limit`}
                    {...field}
                    value={field.value || ''}
                    onChange={(e) => {
                      const characterLimit = parseInt(e.target.value, 10) || 0;

                      // Solid Ten Sign (F-5): typing "120" passes through "1" and "12". The sender's
                      // text is never cut to such a partial limit; a limit shorter than the text is
                      // an error (shown below) and is not saved.
                      field.onChange(characterLimit || '');
                    }}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <div className="flex w-full flex-row gap-x-4">
            <EditorGenericLineHeightField className="w-full" formControl={form.control} />

            <EditorGenericLetterSpacingField className="w-full" formControl={form.control} />
          </div>

          <div className="mt-1">
            <EditorGenericRequiredField formControl={form.control} />
          </div>

          <EditorGenericReadOnlyField formControl={form.control} />
        </fieldset>
      </form>
    </Form>
  );
};
