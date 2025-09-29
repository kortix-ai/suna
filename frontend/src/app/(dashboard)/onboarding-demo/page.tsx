'use client';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useOnboarding } from '@/hooks/use-onboarding';
import { onboardingSteps } from '@/components/onboarding/onboarding-config';
import { PageHeader } from '@/components/ui/page-header';
import { RotateCcw, Play, Eye, Sparkles } from 'lucide-react';

export default function OnboardingDemoPage() {
  const { 
    isOpen, 
    hasCompletedOnboarding, 
    hasTriggeredPostSubscription,
    userTypeData,
    startOnboarding, 
    resetOnboarding,
    setTriggeredPostSubscription
  } = useOnboarding();

  const handleStartDemo = () => {
    startOnboarding(onboardingSteps);
  };

  const handleResetAll = () => {
    resetOnboarding();
  };

  const handleTriggerPostSubscription = () => {
    setTriggeredPostSubscription(false);
    // Simulate subscription success by adding query param
    const url = new URL(window.location.href);
    url.searchParams.set('trial', 'started');
    window.history.pushState({}, '', url.toString());
    // Refresh the page to trigger the effect
    window.location.reload();
  };

  return (
    <div className="container mx-auto max-w-7xl px-4 py-8">
      <div className="space-y-8">
        <PageHeader icon={Sparkles}>
          <span className="text-primary">Onboarding Demo</span>
        </PageHeader>

        <div className="grid gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Current Onboarding State</CardTitle>
            <CardDescription>
              View the current state of the onboarding system
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className="p-4 rounded-lg border">
                <div className="text-sm font-medium text-muted-foreground">Onboarding Open</div>
                <div className="text-lg font-semibold">
                  {isOpen ? '✅ Yes' : '❌ No'}
                </div>
              </div>
              <div className="p-4 rounded-lg border">
                <div className="text-sm font-medium text-muted-foreground">Completed</div>
                <div className="text-lg font-semibold">
                  {hasCompletedOnboarding ? '✅ Yes' : '❌ No'}
                </div>
              </div>
              <div className="p-4 rounded-lg border">
                <div className="text-sm font-medium text-muted-foreground">Post-Subscription Triggered</div>
                <div className="text-lg font-semibold">
                  {hasTriggeredPostSubscription ? '✅ Yes' : '❌ No'}
                </div>
              </div>
              <div className="p-4 rounded-lg border">
                <div className="text-sm font-medium text-muted-foreground">User Type</div>
                <div className="text-lg font-semibold">
                  {userTypeData.userType ? `${userTypeData.userType}` : '❌ Not Set'}
                </div>
                {userTypeData.role && (
                  <div className="text-xs text-muted-foreground mt-1">
                    Role: {userTypeData.role}
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Actions</CardTitle>
            <CardDescription>
              Test different onboarding scenarios
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-3">
              <Button 
                onClick={handleStartDemo}
                className="flex items-center gap-2"
                disabled={isOpen}
              >
                <Play className="h-4 w-4" />
                Start Demo Onboarding
              </Button>
              
              <Button 
                onClick={handleTriggerPostSubscription}
                variant="outline"
                className="flex items-center gap-2"
              >
                <Eye className="h-4 w-4" />
                Simulate Post-Subscription Flow
              </Button>
              
              <Button 
                onClick={handleResetAll}
                variant="destructive"
                className="flex items-center gap-2"
              >
                <RotateCcw className="h-4 w-4" />
                Reset All State
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>How It Works</CardTitle>
            <CardDescription>
              Understanding the onboarding flow
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="prose prose-sm max-w-none dark:prose-invert">
              <h4>Post-Subscription Trigger</h4>
              <p>
                The onboarding automatically triggers when a user successfully subscribes or starts a trial. 
                It detects URL parameters like <code>?trial=started</code> or <code>?subscription=success</code>.
              </p>
              
              <h4>Full-Screen Experience</h4>
              <p>
                The onboarding takes over the entire screen, providing an immersive introduction to the platform.
                It includes:
              </p>
              <ul>
                <li>Welcome message with platform overview</li>
                <li>Feature highlights and capabilities</li>
                <li>Quick start guide with actionable steps</li>
                <li>Completion screen with next steps</li>
              </ul>
              
              <h4>Persistent State</h4>
              <p>
                The onboarding state is persisted in localStorage, so users won't see it again once completed.
                You can reset it using the "Reset All State" button above.
              </p>
            </div>
          </CardContent>
        </Card>
        </div>
      </div>
    </div>
  );
}
