'use client';

import { FileText, Sparkles } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';

export default function KnowledgeRoute() {
  const router = useRouter();

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="container mx-auto max-w-2xl px-4 py-8">
        <div className="space-y-6">
          <div className="flex items-center gap-3 justify-center">
            <div className="p-3 rounded-xl bg-primary/10">
              <FileText className="h-6 w-6 text-primary" />
            </div>
            <h1 className="text-2xl font-semibold">Knowledge Base</h1>
          </div>

          <Alert className="border-primary/20 bg-primary/5">
            <Sparkles className="h-4 w-4 text-primary" />
            <AlertDescription className="text-sm">
              <strong className="text-foreground">Coming Soon</strong>
              <p className="text-muted-foreground mt-1">
                Knowledge Base is currently under development. This feature will allow you to upload documents and files that your agents can reference to provide more accurate and context-aware responses.
              </p>
            </AlertDescription>
          </Alert>

          <div className="flex justify-center">
            <Button
              variant="outline"
              onClick={() => router.push('/settings?tab=knowledge-base')}
            >
              Go to Settings
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}