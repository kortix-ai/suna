import { LanguagePage } from '@/components/settings';
import { useRouter } from 'expo-router';

export default function LanguageScreen() {
  const router = useRouter();

  return <LanguagePage visible={true} onClose={() => router.back()} isDrawer={true} />;
}
