'use client';

import * as React from 'react';

import { captureException } from '../../lib/telemetry';

export type ErrorBoundaryFallback = (props: { error: Error; reset: () => void }) => React.ReactNode;

interface State {
  error: Error | null;
}

/**
 * Contains a render crash to its subtree and renders `fallback` instead.
 * Reports the error through `captureException` (`@kortix/ui/lib/telemetry`)
 * with the component stack as `extra.componentStack`.
 */
export class ErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback: ErrorBoundaryFallback },
  State
> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    captureException(error, { extra: { componentStack: info.componentStack } });
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (error) return <>{this.props.fallback({ error, reset: this.reset })}</>;
    return <>{this.props.children}</>;
  }
}
