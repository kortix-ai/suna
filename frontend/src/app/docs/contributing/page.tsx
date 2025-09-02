'use client';

import * as React from 'react';
import { 
  DocsHeader,
  DocsCard,
  DocsBody,
  DocsBullets,
  DocsBulletItem,
} from '@/components/ui/docs-index';
import { CodeBlock, CodeBlockBody, CodeBlockContent, CodeBlockHeader, CodeBlockFiles, CodeBlockFilename, CodeBlockCopyButton } from '@/components/ui/shadcn-io/code-block';

const breadcrumbs = [
  { title: 'Docs', onClick: () => window.location.href = '/docs' },
  { title: 'Contributing' }
];

export default function ContributingPage() {
  return (
    <>
      <DocsHeader
        title="Contributing to Suna"
        description="Help make Suna better for everyone! We welcome contributions from the community"
        breadcrumbs={breadcrumbs}
        lastUpdated="August 2025"
        showSeparator
        size="lg"
        className="mb-8 sm:mb-12"
      />

      <section className="mb-12">
        <DocsBody className="mb-8">
          <h2 id="getting-started">Getting Started</h2>
          <p className="text-lg mb-6">
            Ready to contribute? Here's how to get your development environment set up:
          </p>
        </DocsBody>
        <DocsBullets variant="check" spacing="default" className="mb-8">
          <DocsBulletItem
            title="Fork the Repository"
            description="Create your own fork of the Kortix repository on GitHub"
          />
          <DocsBulletItem
            title="Clone Locally"
            description="Clone your fork and set up the upstream remote for easy syncing"
          />
          <DocsBulletItem
            title="Install Dependencies"
            description="Follow the self-hosting guide to set up your local development environment"
          />
          <DocsBulletItem
            title="Create a Branch"
            description="Create a feature branch for your changes: git checkout -b feature/amazing-feature"
          />
        </DocsBullets>
      </section>

      <section className="mb-12">
        <DocsBody className="mb-8">
          <h2 id="ways-to-contribute">Ways to Contribute</h2>
          <p className="text-lg mb-6">
            There are many ways to help improve Kortix:
          </p>
        </DocsBody>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
          <DocsCard
            title="Bug Reports"
            description="Report issues, provide detailed reproduction steps, and help us fix problems"
            className="bg-accent/50 border-border"
          />
          <DocsCard
            title="Feature Requests"
            description="Suggest new features, improvements, or enhancements to existing functionality"
            className="bg-accent/50 border-border"
          />
          <DocsCard
            title="Code Contributions"
            description="Submit bug fixes, implement new features, improve performance, or refactor code"
            className="bg-accent/50 border-border"
          />
          <DocsCard
            title="Documentation"
            description="Improve docs, write tutorials, create examples, or translate content"
            className="bg-accent/50 border-border"
          />
          <DocsCard
            title="Design & UX"
            description="Improve user interfaces, create designs, or enhance user experience"
            className="bg-accent/50 border-border"
          />
        </div>
      </section>

      <section className="mb-12">
        <DocsBody className="mb-8">
          <h2 id="development-setup">Development Setup</h2>
          <p className="text-lg mb-6">
            To set up your local development environment, follow our comprehensive self-hosting guide:
          </p>
        </DocsBody>
        <DocsCard
          title="Self-Hosting Guide"
          description="Complete setup instructions including prerequisites, API keys, and step-by-step installation"
          className="mb-6"
          clickable
          actions={[
            { 
              label: 'View Setup Guide', 
              variant: 'default',
              onClick: () => window.location.href = '/docs/self-hosting'
            }
          ]}
        />
        <DocsBody className="mb-8">
          <p className="text-muted-foreground">
            The self-hosting guide covers all prerequisites, dependencies, and configuration needed for development. 
            Once you've completed the setup, you can start contributing to the project.
          </p>
        </DocsBody>
      </section>

      <section className="mb-12">
        <DocsBody className="mb-8">
          <h2 id="code-guidelines">Code Guidelines</h2>
          <p className="text-lg mb-6">
            Follow these guidelines to maintain code quality and consistency:
          </p>
        </DocsBody>
        
        <div className="space-y-6">
          <div>
            <h3 id="frontend-guidelines" className="text-lg font-semibold mb-4">Frontend (TypeScript/React)</h3>
            <DocsBullets variant="default" spacing="default" className="mb-4">
              <DocsBulletItem
                title="TypeScript Strict Mode"
                description="Use strict TypeScript, avoid 'any' types, define proper interfaces"
              />
              <DocsBulletItem
                title="Component Structure"
                description="Use functional components with hooks, follow naming conventions"
              />
              <DocsBulletItem
                title="shadcn/ui Components"
                description="Use shadcn/ui components for consistency, avoid custom CSS when possible"
              />
            </DocsBullets>
          </div>

          <div>
            <h3 id="backend-guidelines" className="text-lg font-semibold mb-4">Backend (Python)</h3>
            <DocsBullets variant="default" spacing="default" className="mb-4">
              <DocsBulletItem
                title="Type Hints"
                description="Use comprehensive type hints, follow PEP 484 standards"
              />
              <DocsBulletItem
                title="FastAPI Patterns"
                description="Follow FastAPI best practices for endpoints, dependencies, and models"
              />
              <DocsBulletItem
                title="Error Handling"
                description="Implement proper exception handling with structured error responses"
              />
            </DocsBullets>
          </div>
        </div>
      </section>

      <section className="mb-12">
        <DocsBody className="mb-8">
          <h2 id="pull-request-process">Pull Request Process</h2>
          <p className="text-lg mb-6">
            Follow these steps when submitting a pull request:
          </p>
        </DocsBody>
        <DocsBullets spacing="default" className="mb-8">
          <DocsBulletItem
            title="Create a Feature Branch"
            description="Branch from main: git checkout -b feature/your-feature-name"
          />
          <DocsBulletItem
            title="Make Your Changes"
            description="Implement your feature or fix, following our code guidelines"
          />
          <DocsBulletItem
            title="Test Thoroughly"
            description="Run tests, check functionality, ensure no regressions"
          />
          <DocsBulletItem
            title="Commit with Clear Messages"
            description="Write descriptive commit messages following conventional commits"
          />
          <DocsBulletItem
            title="Push and Create PR"
            description="Push to your fork and create a pull request with a clear description"
          />
          <DocsBulletItem
            title="Respond to Feedback"
            description="Address reviewer comments and make necessary adjustments"
          />
        </DocsBullets>
      </section>

      <section className="mb-12">
        <DocsBody className="mb-8">
          <h2 id="community">Join the Community</h2>
          <p className="text-lg mb-6">
            Connect with other contributors and get help with your contributions:
          </p>
        </DocsBody>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
          <DocsCard
            title="Discord Community"
            description="Join our Discord server for real-time discussions and support"
            clickable
            actions={[
              { 
                label: 'Join Discord', 
                variant: 'default',
                onClick: () => window.open('https://discord.gg/Py6pCBUUPw', '_blank')
              }
            ]}
          />
          <DocsCard
            title="GitHub Issues"
            description="Report bugs, request features, and other issues"
            clickable
            actions={[
              { 
                label: 'View Discussions', 
                variant: 'default',
                onClick: () => window.open('https://github.com/kortix-ai/suna/issues', '_blank')
              }
            ]}
          />
        </div>
      </section>
    </>
  );
} 