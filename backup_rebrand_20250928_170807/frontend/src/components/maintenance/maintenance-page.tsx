'use client';

import { useEffect, useState } from 'react';
import { Loader2, Server, RefreshCw, AlertCircle, Clock, Wrench } from 'lucide-react';
import { useApiHealth } from '@/hooks/react-query';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { isLocalMode } from '@/lib/config';

export function MaintenancePage() {
  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  
  const { data: healthData, isLoading: isCheckingHealth, refetch } = useApiHealth();

  const checkHealth = async () => {
    try {
      const result = await refetch();
      if (result.data) {
        window.location.reload();
      }
    } catch (error) {
      console.error('API health check failed:', error);
    } finally {
      setLastChecked(new Date());
    }
  };

  useEffect(() => {
    setLastChecked(new Date());
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-muted/20 flex items-center justify-center p-4">
      <div className="w-full max-w-2xl">
        <Card className="border-none shadow-none backdrop-blur-sm bg-transparent">
          <CardContent className="p-8">
            <div className="text-center space-y-6">
              <div className="flex justify-center mb-4">
                <div className="relative">
                  <div className="relative p-4 rounded-full border-2 bg-primary/10">
                    <Wrench className="h-10 w-10" />
                  </div>
                </div>
              </div>
              <div className="flex justify-center">
                <Badge variant="outline" className="px-3 py-1 bg-blue-50 dark:bg-blue-900/30 border-blue-200 dark:border-blue-700 text-blue-800 dark:text-blue-200 font-medium">
                  <AlertCircle className="h-4 w-4" />
                  System Under Maintenance
                </Badge>
              </div>
              <div className="space-y-4">
                <h1 className="text-3xl font-bold tracking-tight bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text text-transparent">
                  We'll Be Right Back
                </h1>
                <p className="text-base text-muted-foreground max-w-lg mx-auto leading-relaxed">
                  {isLocalMode() ? (
                    "The backend server appears to be offline. Please ensure your backend server is running and try again."
                  ) : (
                    "We're performing scheduled maintenance to improve your experience. Our team is working diligently to restore all services."
                  )}
                </p>
              </div>
              <div className="grid grid-cols-1 gap-3 mt-6 md:px-4">
                <Card className="bg-muted-foreground/10 border-none shadow-none">
                  <CardContent className="text-center">
                    <div className="flex items-center justify-center mb-1">
                      <div className="h-3 w-3 bg-red-500 dark:bg-red-400 rounded-full mr-2 animate-pulse"></div>
                      <span className="font-medium text-red-700 dark:text-red-300">Services Offline</span>
                    </div>
                    <p className="text-sm text-red-600 dark:text-red-400">All agent executions are currently paused.</p>
                  </CardContent>
                </Card>
              </div>
              <div className="space-y-4 pt-4">
                <Button
                  onClick={checkHealth}
                  disabled={isCheckingHealth}
                  size="lg"
                  className="w-full md:w-auto px-6 py-2 bg-primary hover:bg-primary/90 text-primary-foreground font-medium transition-all duration-200"
                >
                  {isCheckingHealth ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Checking Status...
                    </>
                  ) : (
                    <>
                      <RefreshCw className="h-4 w-4" />
                      Check System Status
                    </>
                  )}
                </Button>
                {lastChecked && (
                  <div className="flex items-center justify-center text-sm text-muted-foreground">
                    <Clock className="h-4 w-4 mr-2" />
                    Last checked: {lastChecked.toLocaleTimeString()}
                  </div>
                )}
              </div>
              <div className="pt-4 border-t border-border/50">
                <p className="text-sm text-muted-foreground">
                  {isLocalMode() ? (
                    "Need help? Check the documentation for setup instructions."
                  ) : (
                    "For urgent matters, please contact our support team."
                  )}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
