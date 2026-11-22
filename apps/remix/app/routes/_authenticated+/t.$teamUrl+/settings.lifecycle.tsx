import { LifecycleSettingsPage } from '~/components/general/lifecycle/lifecycle-settings-page';
import { useCurrentTeam } from '~/providers/team';

export default function TeamSettingsLifecyclePage() {
  const team = useCurrentTeam();

  return <LifecycleSettingsPage scope={{ type: 'team', teamId: team.id }} />;
}
