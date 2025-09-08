'use client';

import * as React from 'react';
import { 
  DocsHeader,
  DocsCard,
  DocsBody,
} from '@/components/ui/docs-index';
import type { BundledLanguage } from '@/components/ui/shadcn-io/code-block';
import {
  CodeBlock,
  CodeBlockBody,
  CodeBlockContent,
  CodeBlockItem,
} from '@/components/ui/shadcn-io/code-block';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { CheckCircle2, AlertCircle, Info, Zap, Lightbulb, ArrowRight, Bot } from 'lucide-react';
import { Separator } from '@/components/ui/separator';
import { Card } from '@/components/ui/card';

const breadcrumbs = [
  { title: 'Documentation', onClick: () => window.location.href = '/docs' },
  { title: 'Quick Start' }
];

export default function QuickStartPage() {
  return (
    <>
      <DocsHeader
        title="Self Hosting Guide"
        subtitle="Get the platform running in minutes with our automated setup wizard"
        breadcrumbs={breadcrumbs}
        lastUpdated="August 2025"
        showSeparator
        size="lg"
        className="mb-8 sm:mb-12"
      />
      <DocsBody className="mb-8">
        <h2 id="prerequisites">What You Need First</h2>
        <p className="mb-4">Before we start, make sure you have these installed:</p>
        <ul className="list-disc pl-6 mb-6 space-y-2">
          <li><strong>Python 3.11+</strong> - The setup wizard is written in Python</li>
          <li><strong>Docker</strong> - For running Redis and the full platform</li>
          <li><strong>Git</strong> - To clone the repository</li>
          <li><strong>Node.js 18+</strong> - Only needed if you choose manual setup</li>
        </ul>
        
        <Alert className="mb-6">
          <Info className="h-4 w-4" />
          <AlertDescription>
            <strong>Recommended:</strong> Use Docker setup for the smoothest experience. It handles all dependencies automatically.
          </AlertDescription>
        </Alert>
      </DocsBody>

      <DocsBody className="mb-8">
        <h2 id="step-1-clone">Step 1: Clone and Enter</h2>
        <p className="mb-4">Get the code and navigate to the project directory:</p>
        <div className="mb-6">
          <CodeBlock 
            data={[{
              language: "bash",
              filename: "terminal",
              code: `git clone https://github.com/kortix-ai/suna.git
cd suna`
            }]}
            defaultValue="bash"
          >
            <CodeBlockBody>
              {(item) => (
                <CodeBlockItem key={item.language} value={item.language}>
                  <CodeBlockContent language={item.language as BundledLanguage}>
                    {item.code}
                  </CodeBlockContent>
                </CodeBlockItem>
              )}
            </CodeBlockBody>
          </CodeBlock>
        </div>
      </DocsBody>

      <DocsBody className="mb-8">
        <h2 id="step-2-run-wizard">Step 2: Run the Setup Wizard</h2>
        <p className="mb-4">Start the interactive setup wizard:</p>
        <div className="mb-6">
          <CodeBlock 
            data={[{
              language: "bash",
              filename: "terminal", 
              code: "python setup.py"
            }]}
            defaultValue="bash"
          >
            <CodeBlockBody>
              {(item) => (
                <CodeBlockItem key={item.language} value={item.language}>
                  <CodeBlockContent language={item.language as BundledLanguage}>
                    {item.code}
                  </CodeBlockContent>
                </CodeBlockItem>
              )}
            </CodeBlockBody>
          </CodeBlock>
        </div>
        
        <p className="mb-4">The wizard will ask you to choose between two setup methods:</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
          <DocsCard
            title="Docker Compose (Recommended)"
            description="Automatically manages all services and dependencies. Just run and go."
          />
          <DocsCard
            title="Manual"
            description="Requires installing dependencies and running services manually."
          />
        </div>
      </DocsBody>

      <DocsBody className="mb-8">
        <h2 id="step-3-provide-credentials">Step 3: Provide Your Credentials</h2>
        <p className="mb-4">The wizard will walk you through configuring these services in 17 steps. Don't worry - it saves your progress!</p>
        <h3 id="required-services" className="mb-4">Required Services</h3>
        <div className="space-y-4 mb-6">
          <div className="border rounded-lg p-4">
            <div className="flex items-center gap-2 mb-2">
              <CheckCircle2 className="h-5 w-5 text-green-500" />
              <strong>Supabase (Database & Auth)</strong>
            </div>
            <p className="text-sm text-muted-foreground mb-2">Self-hosted option available. Handles user data, conversations, and agent configs.</p>
            <p className="text-sm">Get it at: <a href="https://supabase.com/dashboard/projects" className="text-blue-500 hover:underline">supabase.com</a></p>
          </div>
          <div className="border rounded-lg p-4">
            <div className="flex items-center gap-2 mb-2">
              <CheckCircle2 className="h-5 w-5 text-green-500" />
              <strong>Daytona (Sandboxing)</strong>
            </div>
            <p className="text-sm text-muted-foreground mb-2">Provides secure environments for agents to run code safely.</p>
            <p className="text-sm">Get it at: <a href="https://app.daytona.io/" className="text-blue-500 hover:underline">daytona.io</a></p>
          </div>
          <div className="border rounded-lg p-4">
            <div className="flex items-center gap-2 mb-2">
              <CheckCircle2 className="h-5 w-5 text-green-500" />
              <strong>LLM Provider (At least one)</strong>
            </div>
            <p className="text-sm text-muted-foreground mb-2">Choose from OpenAI, Anthropic, Google Gemini, or OpenRouter.</p>
            <p className="text-sm">Use Sonnet for the best results.</p>
          </div>

          <div className="border rounded-lg p-4">
            <div className="flex items-center gap-2 mb-2">
              <CheckCircle2 className="h-5 w-5 text-green-500" />
              <strong>Search APIs</strong>
            </div>
            <p className="text-sm text-muted-foreground mb-2">Tavily for search, Firecrawl for web scraping.</p>
            <p className="text-sm">Get Tavily at: <a href="https://tavily.com" className="text-blue-500 hover:underline">tavily.com</a></p>
            <p className="text-sm">Get Firecrawl at: <a href="https://firecrawl.dev" className="text-blue-500 hover:underline">firecrawl.dev</a></p>
          </div>
        </div>

        <h3 id="optional-services" className="mb-4">Optional Services</h3>
        <div className="space-y-4 mb-6">
          <div className="border rounded-lg p-4 opacity-75">
            <div className="flex items-center gap-2 mb-2">
              <AlertCircle className="h-5 w-5 text-blue-500" />
              <strong>Morph (AI Code Editing)</strong>
            </div>
            <p className="text-sm text-muted-foreground">Makes code editing much better. Highly recommended but not required.</p>
          </div>

          <div className="border rounded-lg p-4 opacity-75">
            <div className="flex items-center gap-2 mb-2">
              <AlertCircle className="h-5 w-5 text-blue-500" />
              <strong>RapidAPI</strong>
            </div>
            <p className="text-sm text-muted-foreground">Enables extra tools like LinkedIn scraping. Skip for now if you want.</p>
          </div>

          <div className="border rounded-lg p-4 opacity-75">
            <div className="flex items-center gap-2 mb-2">
              <AlertCircle className="h-5 w-5 text-blue-500" />
              <strong>Composio</strong>
            </div>
            <p className="text-sm text-muted-foreground">Tool integrations and workflows.</p>
          </div>
        </div>
      </DocsBody>

      <DocsBody className="mb-8">
        <h2 id="step-4-database-setup">Step 4: Database Setup</h2>
        <p className="mb-4">The wizard will offer to set up your Supabase database automatically. This requires the Supabase CLI:</p>
        
        <Alert className="mb-4">
          <Info className="h-4 w-4" />
          <AlertDescription>
            If you don't have the Supabase CLI, the wizard will let you skip this step. You can set up the database manually later using the migration files.
          </AlertDescription>
        </Alert>

        <p className="mb-4">If you let the wizard handle it, it will:</p>
        <ul className="list-disc pl-6 mb-6 space-y-1">
          <li>Link your project to your Supabase instance</li>
          <li>Push all necessary database migrations</li>
          <li>Set up tables, functions, and security rules</li>
        </ul>

        <p className="mb-4"><strong>Important:</strong> After the migrations, you'll need to manually expose the 'basejump' schema in your Supabase dashboard:</p>
        <ol className="list-decimal pl-6 mb-6 space-y-1">
          <li>Go to Project Settings → Data API → Exposed schemas</li>
          <li>Check the 'basejump' box</li>
          <li>Save</li>
        </ol>
      </DocsBody>

      <DocsBody className="mb-8">
        <h2 id="step-5-start">Step 5: Start Kortix</h2>
        
        <h3 className="mb-4">If you chose Docker setup:</h3>
        <p className="mb-4">The wizard automatically starts everything for you! After setup completes:</p>
        <div className="mb-6">
          <CodeBlock 
            data={[{
              language: "bash",
              filename: "docker-commands",
              code: `# Check if everything is running
docker compose ps

# Follow the logs to see what's happening
docker compose logs -f

# Stop everything when you're done
docker compose down`
            }]}
            defaultValue="bash"
          >
            <CodeBlockBody>
              {(item) => (
                <CodeBlockItem key={item.language} value={item.language}>
                  <CodeBlockContent language={item.language as BundledLanguage}>
                    {item.code}
                  </CodeBlockContent>
                </CodeBlockItem>
              )}
            </CodeBlockBody>
          </CodeBlock>
        </div>

        <h3 className="mb-4">If you chose manual setup:</h3>
        <p className="mb-4">You'll need to start each service in separate terminals:</p>
        
        <div className="space-y-4 mb-6">
          <div>
            <h4 className="font-medium mb-2">Terminal 1 - Infrastructure:</h4>
            <CodeBlock 
              data={[{
                language: "bash",
                filename: "terminal-1",
                code: "docker compose up redis -d"
              }]}
              defaultValue="bash"
            >
              <CodeBlockBody>
                {(item) => (
                  <CodeBlockItem key={item.language} value={item.language}>
                    <CodeBlockContent language={item.language as BundledLanguage}>
                      {item.code}
                    </CodeBlockContent>
                  </CodeBlockItem>
                )}
              </CodeBlockBody>
            </CodeBlock>
          </div>
          <div>
            <h4 className="font-medium mb-2">Terminal 2 - Frontend:</h4>
            <CodeBlock 
              data={[{
                language: "bash", 
                filename: "terminal-2",
                code: "cd frontend && npm run dev"
              }]}
              defaultValue="bash"
            >
              <CodeBlockBody>
                {(item) => (
                  <CodeBlockItem key={item.language} value={item.language}>
                    <CodeBlockContent language={item.language as BundledLanguage}>
                      {item.code}
                    </CodeBlockContent>
                  </CodeBlockItem>
                )}
              </CodeBlockBody>
            </CodeBlock>
          </div>

          <div>
            <h4 className="font-medium mb-2">Terminal 3 - Backend API:</h4>
            <CodeBlock 
              data={[{
                language: "bash",
                filename: "terminal-3", 
                code: "cd backend && uv run api.py"
              }]}
              defaultValue="bash"
            >
              <CodeBlockBody>
                {(item) => (
                  <CodeBlockItem key={item.language} value={item.language}>
                    <CodeBlockContent language={item.language as BundledLanguage}>
                      {item.code}
                    </CodeBlockContent>
                  </CodeBlockItem>
                )}
              </CodeBlockBody>
            </CodeBlock>
          </div>

          <div>
            <h4 className="font-medium mb-2">Terminal 4 - Background Worker:</h4>
            <CodeBlock 
              data={[{
                language: "bash",
                filename: "terminal-4",
                code: "cd backend && uv run dramatiq run_agent_background" 
              }]}
              defaultValue="bash"
            >
              <CodeBlockBody>
                {(item) => (
                  <CodeBlockItem key={item.language} value={item.language}>
                    <CodeBlockContent language={item.language as BundledLanguage}>
                      {item.code}
                    </CodeBlockContent>
                  </CodeBlockItem>
                )}
              </CodeBlockBody>
            </CodeBlock>
          </div>
        </div>
      </DocsBody>

      <DocsBody className="mb-8">
        <h2 id="youre-done">You're Done! 🎉</h2>
        <p className="text-lg mb-4">Once all services are running, open your browser and go to:</p>
        <div className="bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800 rounded-lg p-4 mb-6">
          <p className="text-center font-mono text-lg">
            <a href="http://localhost:3000" className="text-green-600 dark:text-green-400 hover:underline">
              http://localhost:3000
            </a>
          </p>
        </div>

        <p className="mb-4">You should see the Kortix dashboard where you can start chatting with Suna or create your own agents.</p>

        <Alert className="mb-6">
          <CheckCircle2 className="h-4 w-4" />
          <AlertDescription>
            <strong>Pro tip:</strong> The setup wizard saves your progress. If something goes wrong, just run <code>python setup.py</code> again and it'll pick up where you left off.
          </AlertDescription>
        </Alert>
      </DocsBody>
      <Separator className="my-6 w-full" />
      <div className='w-full items-center justify-end flex pb-8'>
        <Card onClick={() => window.location.href = '/docs/quick-start'} className="p-2 group rounded-xl w-full lg:w-[400px] hover:opacity-80 transition-opacity">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="flex items-center justify-center gap-2 bg-primary/10 w-12 h-12 rounded-xl">
                <Bot className="w-6 h-6 text-primary" />
              </div>
              <h3 className="text-lg font-semibold">Agent Examples</h3>
            </div>
            <ArrowRight className="w-4 h-4 mr-2 group-hover:translate-x-1 transition-transform" />
          </div>
        </Card>
      </div>
    </>
  );
} 