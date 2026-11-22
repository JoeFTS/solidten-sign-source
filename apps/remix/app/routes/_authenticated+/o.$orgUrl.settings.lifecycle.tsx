import { useCurrentOrganisation } from '@documenso/lib/client-only/providers/organisation';

import { LifecycleSettingsPage } from '~/components/general/lifecycle/lifecycle-settings-page';

export default function OrganisationSettingsLifecyclePage() {
  const organisation = useCurrentOrganisation();

  return <LifecycleSettingsPage scope={{ type: 'organisation', organisationId: organisation.id }} />;
}
