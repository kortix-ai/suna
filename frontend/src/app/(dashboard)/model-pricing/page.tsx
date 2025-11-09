'use client';

import { Zap, Server, Globe, Clock, Sparkles, ShoppingCart, Info } from 'lucide-react';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useRouter } from 'next/navigation';
import { cn } from '@/lib/utils';

// Usage examples data
const usageExamples = [
  {
    name: 'NBA player scoring efficiency quadrant chart',
    complexity: 'Standard',
    complexityVariant: 'secondary' as const,
    taskTypes: ['Data analysis', 'Visualization research'],
    duration: '15 minutes',
    creditsUsed: 200,
  },
  {
    name: 'Elegant Simple Luxurious Wedding Invitation Webpage',
    complexity: 'Standard',
    complexityVariant: 'secondary' as const,
    taskTypes: ['Website design', 'Code development', 'Website deployment'],
    duration: '25 minutes',
    creditsUsed: 360,
  },
  {
    name: 'Daily sky events web app with location-based reports',
    complexity: 'Complex',
    complexityVariant: 'destructive' as const,
    taskTypes: ['App development', 'Data integration', 'Interactive website deployment'],
    duration: '80 minutes',
    creditsUsed: 900,
  },
];

export default function CreditsPage() {
  const router = useRouter();

  return (
    <div className="container mx-auto max-w-4xl px-4 py-8 md:py-12">
      {/* Header Section */}
      <div className="space-y-4 mb-12">
        <h1 className="text-3xl md:text-4xl font-medium tracking-tight text-foreground">
          Credits Explained
        </h1>
        <p className="text-lg text-muted-foreground max-w-3xl">
          Understand how credits work, what they're used for, and how to get more.
        </p>
      </div>

      <div className="space-y-8">
        {/* What are Credits Section */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-xl">
              <Sparkles className="w-5 h-5 text-primary" />
              What are credits?
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground leading-relaxed">
              Credits are our standard unit of measurement for Manus usage - the more complex or lengthy the task, the more credits it requires.
            </p>
          </CardContent>
        </Card>

        {/* How Credits Work Section */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-xl">
              <Zap className="w-5 h-5 text-primary" />
              How do credits work?
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-muted-foreground leading-relaxed">
              Credits are primarily consumed based on:
            </p>
            <ul className="space-y-3 text-muted-foreground">
              <li className="flex items-start gap-3">
                <div className="w-1.5 h-1.5 rounded-full bg-primary mt-2 flex-shrink-0" />
                <div>
                  <span className="font-medium text-foreground">LLM tokens:</span> Used for task planning, decision making, and output generation.
                </div>
              </li>
              <li className="flex items-start gap-3">
                <div className="w-1.5 h-1.5 rounded-full bg-primary mt-2 flex-shrink-0" />
                <div>
                  <span className="font-medium text-foreground">Virtual machines:</span> Used for cloud environments that support file operations, browser automation, and code execution.
                </div>
              </li>
              <li className="flex items-start gap-3">
                <div className="w-1.5 h-1.5 rounded-full bg-primary mt-2 flex-shrink-0" />
                <div>
                  <span className="font-medium text-foreground">Third-party APIs:</span> Used for accessing integrated external services, such as financial data and professional databases.
                </div>
              </li>
            </ul>
            <div className="mt-6 pt-6 border-t border-border">
              <p className="text-muted-foreground leading-relaxed">
                The specific credits consumption for a task is determined by its complexity and duration. Credits are only consumed during active task processing - completed tasks and the storage or deployment of their outputs do not consume any credits, so there's no need to delete completed tasks.
              </p>
            </div>
            <Alert className="mt-4">
              <Info className="h-4 w-4" />
              <AlertDescription>
                We provide a full refund of consumed credits for tasks that fail due to technical issues on our end. We will continuously optimize system efficiency and reduce the number of credits consumed per task.
              </AlertDescription>
            </Alert>
          </CardContent>
        </Card>

        {/* Usage Examples Section */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-xl">
              <Globe className="w-5 h-5 text-primary" />
              Usage examples
            </CardTitle>
            <CardDescription>
              Here are some examples demonstrating credits consumption across different task types and complexity levels.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 md:grid-cols-1">
              {usageExamples.map((example, index) => (
                <div
                  key={index}
                  className="p-5 border border-border rounded-lg hover:bg-muted/30 transition-colors"
                >
                  <div className="space-y-4">
                    <div className="flex items-start justify-between gap-4">
                      <h4 className="font-semibold text-foreground text-base leading-tight">
                        {example.name}
                      </h4>
                      <Badge variant={example.complexityVariant} className="flex-shrink-0">
                        {example.complexity}
                      </Badge>
                    </div>
                    
                    <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                      <span className="font-medium text-foreground">Task type:</span>
                      {example.taskTypes.map((type, i) => (
                        <span key={i}>
                          {type}
                          {i < example.taskTypes.length - 1 && <span className="mx-1">·</span>}
                        </span>
                      ))}
                    </div>

                    <div className="grid grid-cols-2 gap-4 pt-2">
                      <div className="flex items-center gap-2 text-sm">
                        <Clock className="w-4 h-4 text-muted-foreground" />
                        <span className="text-muted-foreground">Duration:</span>
                        <span className="font-medium text-foreground">{example.duration}</span>
                      </div>
                      <div className="flex items-center gap-2 text-sm">
                        <Zap className="w-4 h-4 text-primary" />
                        <span className="text-muted-foreground">Credits used:</span>
                        <span className="font-semibold text-primary">{example.creditsUsed.toLocaleString()}</span>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* How to Get More Credits Section */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-xl">
              <ShoppingCart className="w-5 h-5 text-primary" />
              How to get more credits?
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div>
              <p className="text-muted-foreground mb-4 leading-relaxed">
                For Free users, you can upgrade to a membership for more credits:
              </p>
              <div className="space-y-3">
                <div className="flex items-center justify-between p-3 bg-muted/30 rounded-lg border border-border">
                  <span className="font-medium text-foreground">Basic plan:</span>
                  <span className="text-muted-foreground">1,900 credits per month</span>
                </div>
                <div className="flex items-center justify-between p-3 bg-muted/30 rounded-lg border border-border">
                  <span className="font-medium text-foreground">Plus plan:</span>
                  <span className="text-muted-foreground">3,900 credits per month</span>
                </div>
                <div className="flex items-center justify-between p-3 bg-muted/30 rounded-lg border border-border">
                  <span className="font-medium text-foreground">Pro plan:</span>
                  <span className="text-muted-foreground">19,900 credits per month</span>
                </div>
              </div>
            </div>

            <div className="pt-4 border-t border-border">
              <p className="text-muted-foreground mb-4 leading-relaxed">
                If you're already a member but need more credits, you can purchase add-on credits, currently available in three tiers:
              </p>
              <div className="grid gap-3 md:grid-cols-3">
                <div className="p-4 bg-muted/30 rounded-lg border border-border text-center">
                  <div className="font-semibold text-foreground text-lg mb-1">1,900 credits</div>
                  <div className="text-sm text-muted-foreground">package</div>
                </div>
                <div className="p-4 bg-muted/30 rounded-lg border border-border text-center">
                  <div className="font-semibold text-foreground text-lg mb-1">9,900 credits</div>
                  <div className="text-sm text-muted-foreground">package</div>
                </div>
                <div className="p-4 bg-muted/30 rounded-lg border border-border text-center">
                  <div className="font-semibold text-foreground text-lg mb-1">19,900 credits</div>
                  <div className="text-sm text-muted-foreground">package</div>
                </div>
              </div>
            </div>

            <div className="pt-4">
              <Button
                onClick={() => router.push('/dashboard')}
                className="w-full md:w-auto"
              >
                View Plans & Upgrade
              </Button>
            </div>

            <Alert className="mt-4">
              <Info className="h-4 w-4" />
              <AlertDescription>
                Note: Only premium members may purchase and use add-on credits.
              </AlertDescription>
            </Alert>
          </CardContent>
        </Card>

        {/* Credits Expiration Section */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-xl">
              <Clock className="w-5 h-5 text-primary" />
              Will credits expire?
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-muted-foreground leading-relaxed">
              Credits are consumed in the following order: event credits, daily credits, monthly credits, add-on credits, and free credits.
            </p>
            
            <div className="space-y-3 pt-2">
              <div className="flex items-start gap-3">
                <div className="w-1.5 h-1.5 rounded-full bg-primary mt-2 flex-shrink-0" />
                <div>
                  <span className="font-medium text-foreground">Monthly credits</span>
                  <span className="text-muted-foreground"> are obtained through subscription and automatically refresh on the same date each month based on your subscription date.</span>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="w-1.5 h-1.5 rounded-full bg-primary mt-2 flex-shrink-0" />
                <div>
                  <span className="font-medium text-foreground">Free credits and add-on credits</span>
                  <span className="text-muted-foreground"> never expire.</span>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="w-1.5 h-1.5 rounded-full bg-primary mt-2 flex-shrink-0" />
                <div>
                  <span className="font-medium text-foreground">Event credits</span>
                  <span className="text-muted-foreground"> can be earned by participating in events and expire when the event ends.</span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
