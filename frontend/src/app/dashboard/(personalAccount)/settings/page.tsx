"use client";

import { createClient } from "@/lib/supabase/client";
import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { UserIcon } from "lucide-react";

export default function PersonalAccountSettingsPage() {
  const [user, setUser] = useState<any>(null);
  const [personalAccount, setPersonalAccount] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function loadData() {
      const supabase = createClient();
      
      // Get user
      const { data: { user } } = await supabase.auth.getUser();
      setUser(user);
      
      // Get personal account
      const { data: account } = await supabase.rpc('get_personal_account');
      setPersonalAccount(account);
      
      setIsLoading(false);
    }
    
    loadData();
  }, []);

  if (isLoading) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto py-8">
      <h1 className="text-3xl font-bold mb-8">Personal Account</h1>
      
      <Card className="mb-8">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UserIcon size={20} />
            <span>User Profile</span>
          </CardTitle>
          <CardDescription>
            Manage your personal information
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm font-medium text-muted-foreground mb-1">Name</p>
                <p>{user?.user_metadata?.name || "Not set"}</p>
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground mb-1">Email</p>
                <p>{user?.email}</p>
              </div>
            </div>
            <Button variant="outline" className="w-fit">
              Edit Profile
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}