import { DropdownMenuItem } from '@documenso/ui/primitives/dropdown-menu';
import { forwardRef, useEffect, useRef } from 'react';

/**
 * Solid Ten: a row-menu item that opens a dialog living inside the menu
 * (`<DialogTrigger asChild>{trigger}</DialogTrigger>`).
 *
 * The dialog's trigger passes `data-state` ("open" / "closed") to this item. When the dialog
 * goes from open to closed (confirmed or dismissed), `onDialogClose` runs so the row menu can
 * close too; the same happens when the item unmounts while its dialog is open. Without it the menu, which stays open behind the dialog, comes back over the page
 * and swallows the next click.
 */
export type RowMenuDialogItemProps = React.ComponentPropsWithoutRef<typeof DropdownMenuItem> & {
  onDialogClose: () => void;
  'data-state'?: string;
};

export const RowMenuDialogItem = forwardRef<React.ElementRef<typeof DropdownMenuItem>, RowMenuDialogItemProps>(
  ({ onDialogClose, ...props }, ref) => {
    const dialogState = props['data-state'];

    const wasOpenRef = useRef(false);
    const onDialogCloseRef = useRef(onDialogClose);
    onDialogCloseRef.current = onDialogClose;

    useEffect(() => {
      if (dialogState === 'open') {
        wasOpenRef.current = true;
        return;
      }

      if (dialogState === 'closed' && wasOpenRef.current) {
        wasOpenRef.current = false;
        onDialogCloseRef.current();
      }
    }, [dialogState]);

    // The item can go away while its dialog is open: after "Cancel document" the refetched row
    // is no longer pending, so the Cancel item and its dialog unmount instead of closing.
    useEffect(
      () => () => {
        if (wasOpenRef.current) {
          wasOpenRef.current = false;
          onDialogCloseRef.current();
        }
      },
      [],
    );

    return <DropdownMenuItem ref={ref} {...props} />;
  },
);

RowMenuDialogItem.displayName = 'RowMenuDialogItem';
