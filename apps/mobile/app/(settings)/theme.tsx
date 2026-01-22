import { ThemePage } from '@/components/settings';
import { useRouter } from 'expo-router';

export default function ThemeScreen() {
  const router = useRouter();

  return <ThemePage visible={true} onClose={() => router.back()} isDrawer={true} />;
}
