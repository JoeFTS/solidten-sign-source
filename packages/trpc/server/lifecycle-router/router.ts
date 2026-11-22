import { router } from '../trpc';
import { findScheduledSendsRoute } from './find-scheduled-sends';
import { getSignerReassignOptionsRoute } from './get-signer-reassign-options';
import { getSigningLinkStatusRoute } from './get-signing-link-status';
import { getLifecycleSettingsRoute, previewRetentionRoute, updateLifecycleSettingsRoute } from './lifecycle-settings';
import { reassignRecipientRoute } from './reassign-recipient';
import { reassignRecipientWithTokenRoute } from './reassign-recipient-with-token';
import { resendSignedCopyRoute } from './resend-signed-copy';
import { scheduleSendRoute } from './schedule-send';
import { unscheduleSendRoute } from './unschedule-send';

/**
 * Solid Ten Sign document lifecycle routes: scheduled sending, signer
 * reassignment and retention.
 */
export const lifecycleRouter = router({
  scheduleSend: scheduleSendRoute,
  unscheduleSend: unscheduleSendRoute,
  findScheduledSends: findScheduledSendsRoute,
  reassignRecipient: reassignRecipientRoute,
  reassignRecipientWithToken: reassignRecipientWithTokenRoute,
  getSignerReassignOptions: getSignerReassignOptionsRoute,
  getSigningLinkStatus: getSigningLinkStatusRoute,
  getSettings: getLifecycleSettingsRoute,
  updateSettings: updateLifecycleSettingsRoute,
  previewRetention: previewRetentionRoute,
  resendSignedCopy: resendSignedCopyRoute,
});
