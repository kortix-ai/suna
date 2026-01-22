import { BetaPage } from '@/components/settings';
import { useRouter } from 'expo-router';

export default function BetaScreen() {
  const router = useRouter();

  return <BetaPage visible={true} onClose={() => router.back()} isDrawer={true} />;
}
