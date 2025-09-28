import { useQuery } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';

export function useAccountBySlug(slug: string) {
  const supabaseClient = createClient();
  
  return useQuery({
    queryKey: ['account', 'by-slug', slug],
    queryFn: async () => {
      const { data, error } = await supabaseClient.rpc('get_account_by_slug', {
        slug,
      });

      if (error) {
        throw new Error(error.message);
      }

      return data;
    },
    enabled: !!slug && !!supabaseClient,
  });
}