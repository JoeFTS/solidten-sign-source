import { Button } from '@documenso/ui/primitives/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@documenso/ui/primitives/dialog';
import { Plural, Trans } from '@lingui/react/macro';
import { createCallable } from 'react-call';

export type FieldLogicClearConfirmDialogProps = {
  answerCount: number;
  fileCount: number;
};

/**
 * Solid Ten: ask before a change hides fields the signer already filled. The server clears
 * their answers and deletes their files when they are hidden.
 */
export const FieldLogicClearConfirmDialog = createCallable<FieldLogicClearConfirmDialogProps, boolean>(
  ({ call, answerCount, fileCount }) => (
    <Dialog open={true} onOpenChange={(value) => (!value ? call.end(false) : null)}>
      <DialogContent position="center" data-testid="field-logic-clear-confirm">
        <DialogHeader>
          <DialogTitle>
            <Trans>Remove what you filled in?</Trans>
          </DialogTitle>
          <DialogDescription>
            {fileCount > 0 && answerCount > 0 && (
              <Trans>
                This removes <Plural value={fileCount} one="# file" other="# files" /> and{' '}
                <Plural value={answerCount} one="# answer" other="# answers" />.
              </Trans>
            )}
            {fileCount > 0 && answerCount === 0 && (
              <Trans>
                This removes <Plural value={fileCount} one="# file" other="# files" />.
              </Trans>
            )}
            {fileCount === 0 && (
              <Trans>
                This removes <Plural value={answerCount} one="# answer" other="# answers" />.
              </Trans>
            )}{' '}
            <Trans>The fields that depend on this choice will be hidden and emptied.</Trans>
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => call.end(false)}>
            <Trans>Keep</Trans>
          </Button>
          <Button type="button" variant="destructive" onClick={() => call.end(true)}>
            <Trans>Remove</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ),
);
