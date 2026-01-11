'use client';

import React, { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class NotificationErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[NotificationErrorBoundary] Caught error:', error, errorInfo);
    
    // Check if it's the Novu openSettings error
    if (error.message && error.message.includes('openSettings')) {
      console.warn('[NotificationErrorBoundary] Novu Inbox initialization error - this is usually safe to ignore');
    }
  }

  componentDidUpdate(prevProps: Props, prevState: State) {
    // Reset error state when children change
    if (prevState.hasError && this.props.children !== prevProps.children) {
      this.setState({ hasError: false, error: null });
    }
  }

  render() {
    if (this.state.hasError) {
      // Return fallback UI or null to hide the component
      return this.props.fallback || null;
    }

    return this.props.children;
  }
}

