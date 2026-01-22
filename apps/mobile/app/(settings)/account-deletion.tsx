import { AccountDeletionPage } from '@/components/settings';
import { useRouter } from 'expo-router';

export default function AccountDeletionScreen() {
  const router = useRouter();

  return <AccountDeletionPage visible={true} onClose={() => router.back()} isDrawer={true} />;
}
