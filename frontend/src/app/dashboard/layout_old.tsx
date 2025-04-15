import DashboardLayout from "@/components/dashboard/old/DashboardLayout";
import { createClient } from "@/lib/supabase/server";

interface DashboardRootLayoutProps {
  children: React.ReactNode;
}

export default async function DashboardRootLayout({
  children,
}: DashboardRootLayoutProps) {
  // Get the current user via Supabase
  const supabaseClient = await createClient();
  const { data: { user } } = await supabaseClient.auth.getUser();
  
  // Get the personal account details
  const { data: personalAccount } = await supabaseClient.rpc('get_personal_account');

  return (
    <DashboardLayout
      accountId={personalAccount?.account_id || user.id}
      userName={user?.user_metadata?.name || user.email?.split('@')[0] || 'User'}
      userEmail={user.email}
      rightPanelTitle="Suna's Computer"
    >
      {children}
    </DashboardLayout>
  );
} 