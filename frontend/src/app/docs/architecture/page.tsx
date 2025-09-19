'use client';

import * as React from 'react';
import { 
  DocsHeader,
  DocsCard,
  DocsBody,
} from '@/components/ui/docs-index';

const breadcrumbs = [
  { title: 'Documentation', onClick: () => window.location.href = '/docs' },
  { title: 'Platform Architecture' }
];

export default function ArchitecturePage() {
  return (
    <>
      <DocsHeader
        title="Platform Architecture"
        subtitle="Understanding the core components and design of the Kortix platform"
        breadcrumbs={breadcrumbs}
        badge="Technical"
        lastUpdated="December 2024"
        showSeparator
        size="lg"
        className="mb-8 sm:mb-12"
      />

      <section id="architecture" className="mb-16">
        <DocsBody className="mb-8">
          <h2>🏗️ Platform Architecture</h2>
          <p className="text-lg mb-6">
            Kortix consists of four main components that work together to provide a complete AI agent development platform:
          </p>
        </DocsBody>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
          <DocsCard
            title="🔧 Backend API"
            description="Python/FastAPI service with REST endpoints, thread management, agent orchestration, and LLM integration via LiteLLM"
            className="bg-accent/50 border-border"
          />
          <DocsCard
            title="🖥️ Frontend Dashboard"
            description="Next.js/React application with chat interfaces, agent configuration dashboards, and monitoring tools"
            className="bg-accent/50 border-border"
          />
          <DocsCard
            title="🐳 Agent Runtime"
            description="Isolated Docker execution environments with browser automation, code interpreter, and security sandboxing"
            className="bg-accent/50 border-border"
          />
          <DocsCard
            title="🗄️ Database & Storage"
            description="Supabase-powered data layer with authentication, user management, and real-time subscriptions"
            className="bg-accent/50 border-border"
          />
        </div>
      </section>

      <section id="tech-stack" className="mb-16">
        <DocsBody className="mb-8">
          <h2>🚀 Technology Stack</h2>
          <p className="text-lg mb-6">
            Modern technologies powering the Kortix platform:
          </p>
        </DocsBody>
        
        <div className="space-y-8">
          <div>
            <h3 className="text-lg font-semibold mb-4">Frontend</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <DocsCard
                title="Next.js 15+"
                description="App Router with TypeScript"
                className="bg-accent/30 border-border"
              />
              <DocsCard
                title="Tailwind CSS"
                description="Utility-first styling"
                className="bg-accent/30 border-border"
              />
              <DocsCard
                title="Radix UI"
                description="Accessible component primitives"
                className="bg-accent/30 border-border"
              />
            </div>
          </div>

          <div>
            <h3 className="text-lg font-semibold mb-4">Backend</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <DocsCard
                title="FastAPI"
                description="Modern Python web framework"
                className="bg-accent/30 border-border"
              />
              <DocsCard
                title="LiteLLM"
                description="Multi-provider LLM integration"
                className="bg-accent/30 border-border"
              />
              <DocsCard
                title="Dramatiq"
                description="Background job processing"
                className="bg-accent/30 border-border"
              />
            </div>
          </div>

          <div>
            <h3 className="text-lg font-semibold mb-4">Infrastructure</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <DocsCard
                title="Supabase"
                description="Database and authentication"
                className="bg-accent/30 border-border"
              />
              <DocsCard
                title="Redis"
                description="Caching and message broker"
                className="bg-accent/30 border-border"
              />
              <DocsCard
                title="Docker"
                description="Containerization and isolation"
                className="bg-accent/30 border-border"
              />
            </div>
          </div>
        </div>
      </section>

      <section id="data-flow" className="mb-16">
        <DocsBody className="mb-8">
          <h2>🔄 Data Flow</h2>
          <p className="text-lg mb-6">
            How information moves through the Kortix platform:
          </p>
          
          <div className="bg-muted/50 border border-border rounded-lg p-6 mb-6">
            <div className="space-y-4">
              <div className="flex items-center gap-4">
                <div className="w-8 h-8 bg-primary text-primary-foreground rounded-full flex items-center justify-center text-sm font-semibold">1</div>
                <div>
                  <h4 className="font-semibold">User Interaction</h4>
                  <p className="text-sm text-muted-foreground">User sends request through frontend interface</p>
                </div>
              </div>
              <div className="flex items-center gap-4">
                <div className="w-8 h-8 bg-primary text-primary-foreground rounded-full flex items-center justify-center text-sm font-semibold">2</div>
                <div>
                  <h4 className="font-semibold">API Processing</h4>
                  <p className="text-sm text-muted-foreground">FastAPI backend processes request and authenticates user</p>
                </div>
              </div>
              <div className="flex items-center gap-4">
                <div className="w-8 h-8 bg-primary text-primary-foreground rounded-full flex items-center justify-center text-sm font-semibold">3</div>
                <div>
                  <h4 className="font-semibold">Agent Execution</h4>
                  <p className="text-sm text-muted-foreground">Agent runs in isolated Docker environment with access to tools</p>
                </div>
              </div>
              <div className="flex items-center gap-4">
                <div className="w-8 h-8 bg-primary text-primary-foreground rounded-full flex items-center justify-center text-sm font-semibold">4</div>
                <div>
                  <h4 className="font-semibold">Real-time Updates</h4>
                  <p className="text-sm text-muted-foreground">Results streamed back to frontend via Supabase subscriptions</p>
                </div>
              </div>
            </div>
          </div>
        </DocsBody>
      </section>

      <section id="security" className="mb-16">
        <DocsBody className="mb-8">
          <h2>🔒 Security Architecture</h2>
          <p className="text-lg mb-6">
            Multi-layered security approach:
          </p>
        </DocsBody>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
          <DocsCard
            title="🛡️ Authentication"
            description="JWT-based authentication with Supabase Auth, secure session management"
            className="bg-accent/50 border-border"
          />
          <DocsCard
            title="🔐 Authorization"
            description="Row-level security policies, fine-grained access control"
            className="bg-accent/50 border-border"
          />
          <DocsCard
            title="🏗️ Isolation"
            description="Docker containers for agent execution, network segmentation"
            className="bg-accent/50 border-border"
          />
          <DocsCard
            title="🔑 Secrets Management"
            description="Encrypted storage of API keys and sensitive configuration"
            className="bg-accent/50 border-border"
          />
        </div>
      </section>

      <section id="deployment" className="mb-16">
        <DocsBody className="mb-8">
          <h2>🚀 Deployment Options</h2>
          <p className="text-lg mb-6">
            Flexible deployment strategies for different use cases:
          </p>
        </DocsBody>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          <DocsCard
            title="🐳 Docker Compose"
            description="Single-machine deployment with all services"
            className="bg-accent/50 border-border"
          />
          <DocsCard
            title="☸️ Kubernetes"
            description="Scalable orchestration for production workloads"
            className="bg-accent/50 border-border"
          />
          <DocsCard
            title="☁️ Cloud Native"
            description="Serverless functions with managed services"
            className="bg-accent/50 border-border"
          />
        </div>
      </section>
    </>
  );
} 