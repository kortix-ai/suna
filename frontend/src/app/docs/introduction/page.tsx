'use client';

import * as React from 'react';
import { 
  DocsHeader,
  DocsCard,
  DocsBody,
  DocsImage
} from '@/components/ui/docs-index';
import { useTheme } from 'next-themes';
import { Separator } from '@/components/ui/separator';
import { Card, CardHeader } from '@/components/ui/card';
import { ArrowRight, Bot, Lightbulb } from 'lucide-react';

const breadcrumbs = [
  { title: 'Documentation', onClick: () => window.location.href = '/docs' },
  { title: 'Introduction' }
];

export default function IntroductionPage() {
  const { theme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  const imageSrc = !mounted
    ? '/thumbnail-light.png'
    : resolvedTheme === 'dark'
      ? '/thumbnail-dark.png'
      : '/thumbnail-light.png';

  return (
    <>
      <DocsHeader
        title="What is Kortix?"
        subtitle="An open source platform for building AI agents that actually get things done"
        breadcrumbs={breadcrumbs}
        lastUpdated="August 2025"
        showSeparator
        size="lg"
        className="mb-8 sm:mb-12"
      />

      <DocsImage
        src={imageSrc}
        alt="Kortix Platform Interface"
        size="full"
        aspect="video"
        className="mb-12"
      />
    
      <DocsBody className="mb-8">
        <h2 id="overview">What is Kortix?</h2>
        <p className="text-lg mb-6">
          Kortix is an open source platform where you can build AI agents that handle real work. Think of it as the infrastructure and tools you need to create agents that can browse the web, manage files, analyze data, and automate workflows.
        </p>
        
        <h3 id="meet-suna">Suna - Our Flagship Agent</h3>
        <p className="mb-4">
          Suna is our showcase agent that demonstrates what's possible with Kortix. It's a generalist AI worker that can:
        </p>
        <ul className="list-disc pl-6 mb-6 space-y-1">
          <li>Research topics and gather information from across the web</li>
          <li>Analyze documents and data files</li>
          <li>Automate browser tasks and web scraping</li>
          <li>Manage files and handle document processing</li>
          <li>Execute complex multi-step workflows</li>
        </ul>
        <p className="mb-6">
          Suna is completely open source and shows you what you can build with the Kortix platform.
        </p>
  
        <h3 id="build-your-own" className="mb-4">Build Your Own Agents</h3>
        <p className="mb-6">
          The real power comes when you create agents for your specific needs. Maybe you need an agent that monitors customer support tickets, or one that processes invoices, or handles your social media posting schedule. With Kortix, you get the building blocks to create agents that work exactly how you want them to.
        </p>

        <h3 id="how-it-works" className="mb-4">How It Works</h3>
        <p className="mb-4">Kortix gives you four main pieces:</p>
        <ul className="list-disc pl-6 mb-6 space-y-2">
          <li><strong>Backend API</strong> - Handles the heavy lifting: talking to AI models, managing tasks, storing data</li>
          <li><strong>Web Dashboard</strong> - Where you build, test, and monitor your agents</li>
          <li><strong>Secure Runtime</strong> - Isolated environments where your agents run safely</li>
          <li><strong>Database</strong> - Stores your agent configs, conversation history, and results</li>
        </ul>
        
        <h3 id="why-open-source" className="mb-4">Why Open Source?</h3>
        <p className="mb-6">
          We believe you should own your agents and your data. No vendor lock-in, no usage limits based on monthly fees, no mysterious black boxes. You can see exactly how everything works, modify it for your needs, and run it wherever you want.
        </p>
      </DocsBody>
      <Separator className="my-6 w-full" />
      <div className='w-full items-center justify-end flex pb-8'>
        <Card onClick={() => window.location.href = '/docs/quick-start'} className="p-2 group rounded-xl w-full lg:w-[400px] hover:opacity-80 transition-opacity">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="flex items-center justify-center gap-2 bg-primary/10 w-12 h-12 rounded-xl">
                <Lightbulb className="w-6 h-6 text-primary" />
              </div>
              <h3 className="text-lg font-semibold">Self-Hosting Guide</h3>
            </div>
            <ArrowRight className="w-4 h-4 mr-2 group-hover:translate-x-1 transition-transform" />
          </div>
        </Card>
      </div>
    </>
  );
} 