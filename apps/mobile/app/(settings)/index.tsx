import { SettingsPage } from '@/components/settings';
import { useRouter } from 'expo-router';
import { useAuthContext } from '@/contexts';

export default function SettingsScreen() {
  const router = useRouter();
  const { user } = useAuthContext();

  const handleNavigate = (page: string) => {
    router.push(`/(settings)/${page}` as any);
  };

  const handleClose = () => {
    router.back();
  };

  const profile = {
    name: user?.user_metadata?.full_name || user?.email?.split('@')[0] || 'User',
    email: user?.email || '',
    avatar: user?.user_metadata?.avatar_url,
    tier: 'free' as const,
  };

  return (
    <SettingsPage
      visible={true}
      profile={profile}
      onClose={handleClose}
      isDrawer={true}
      onNavigate={handleNavigate}
    />
  );
}
