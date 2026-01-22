import { NameEditPage } from '@/components/settings';
import { useRouter } from 'expo-router';
import { useAuthContext } from '@/contexts';

export default function NameScreen() {
  const router = useRouter();
  const { user } = useAuthContext();

  const currentName = user?.user_metadata?.full_name || user?.email?.split('@')[0] || 'User';

  return (
    <NameEditPage
      visible={true}
      currentName={currentName}
      onClose={() => router.back()}
      isDrawer={true}
    />
  );
}
