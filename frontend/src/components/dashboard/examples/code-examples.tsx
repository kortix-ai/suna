'use client';

import React from 'react';
import { BaseExamples, type ExamplePrompt } from './base-examples';
import {
  Code2,
  Bug,
  GitBranch,
  Terminal,
  Braces,
  Database,
  Cpu,
  Package,
  FileCode,
  Zap,
  Shield,
  Layers,
  Workflow,
  TestTube,
  Wrench,
} from 'lucide-react';

const codeExamples: ExamplePrompt[] = [
  {
    title: 'Debug this error',
    query: 'Debug this error in my code: {{error_message}}. Analyze the stack trace, identify the root cause, and provide a fix with explanation',
    icon: <Bug className="text-red-700 dark:text-red-400" />,
  },
  {
    title: 'Refactor for performance',
    query: 'Analyze and refactor my code for better performance. Identify bottlenecks, optimize algorithms, reduce time complexity, and implement caching where appropriate',
    icon: <Zap className="text-yellow-700 dark:text-yellow-400" />,
  },
  {
    title: 'Write unit tests',
    query: 'Generate comprehensive unit tests for my code with high coverage, edge cases, mocking, and clear test descriptions using {{testing_framework}}',
    icon: <TestTube className="text-green-700 dark:text-green-400" />,
  },
  {
    title: 'Implement feature',
    query: 'Implement {{feature_description}} with clean architecture, proper error handling, type safety, and following SOLID principles',
    icon: <Code2 className="text-blue-700 dark:text-blue-400" />,
  },
  {
    title: 'Code review',
    query: 'Review my code for best practices, security vulnerabilities, performance issues, and suggest improvements with detailed explanations',
    icon: <Shield className="text-purple-700 dark:text-purple-400" />,
  },
  {
    title: 'Convert to TypeScript',
    query: 'Convert my JavaScript code to TypeScript with proper type definitions, interfaces, generics, and strict type checking',
    icon: <Braces className="text-indigo-700 dark:text-indigo-400" />,
  },
  {
    title: 'Build REST API',
    query: 'Build a REST API for {{resource}} with CRUD operations, authentication, validation, error handling, and OpenAPI documentation',
    icon: <Layers className="text-teal-700 dark:text-teal-400" />,
  },
  {
    title: 'Database optimization',
    query: 'Optimize my database queries, add proper indexes, fix N+1 problems, implement connection pooling, and improve query performance',
    icon: <Database className="text-orange-700 dark:text-orange-400" />,
  },
  {
    title: 'Setup CI/CD pipeline',
    query: 'Create CI/CD pipeline with automated testing, linting, building, deployment stages, and rollback mechanisms for {{platform}}',
    icon: <Workflow className="text-pink-700 dark:text-pink-400" />,
  },
  {
    title: 'Dockerize application',
    query: 'Create Docker configuration with multi-stage builds, optimization for size, security best practices, and docker-compose for local development',
    icon: <Package className="text-cyan-700 dark:text-cyan-400" />,
  },
  {
    title: 'Fix memory leaks',
    query: 'Identify and fix memory leaks in my application, analyze heap dumps, optimize garbage collection, and implement proper cleanup',
    icon: <Cpu className="text-gray-700 dark:text-gray-400" />,
  },
  {
    title: 'Implement authentication',
    query: 'Implement secure authentication with JWT/OAuth, session management, refresh tokens, role-based access control, and security headers',
    icon: <Shield className="text-red-600 dark:text-red-300" />,
  },
  {
    title: 'Create CLI tool',
    query: 'Build a CLI tool for {{purpose}} with argument parsing, interactive prompts, progress bars, error handling, and help documentation',
    icon: <Terminal className="text-green-600 dark:text-green-300" />,
  },
  {
    title: 'Migrate to new version',
    query: 'Migrate my codebase from {{old_version}} to {{new_version}}, handle breaking changes, update dependencies, and refactor deprecated code',
    icon: <GitBranch className="text-purple-600 dark:text-purple-300" />,
  },
  {
    title: 'Setup monorepo',
    query: 'Configure monorepo with {{tool}}, shared dependencies, build optimization, workspace management, and deployment strategies',
    icon: <Wrench className="text-blue-600 dark:text-blue-300" />,
  },
];

interface CodeExamplesProps {
  onSelectPrompt?: (query: string) => void;
  count?: number;
}

export function CodeExamples({ onSelectPrompt, count = 4 }: CodeExamplesProps) {
  return (
    <BaseExamples
      examples={codeExamples}
      onSelectPrompt={onSelectPrompt}
      count={count}
      title="Code Assistant Examples"
      description="Advanced coding help, debugging, and development tasks"
    />
  );
}
