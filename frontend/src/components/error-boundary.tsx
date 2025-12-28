'use client';

import React, { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      error,
      errorInfo: null,
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // Enhanced error logging
    console.error('=== REACT ERROR BOUNDARY ===');
    console.error('Error:', error);
    console.error('Error name:', error.name);
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    
    // Log React error info
    console.error('Component stack:', errorInfo.componentStack);
    
    // Try to extract React error code if it's a minified error
    const errorMessage = error.message || '';
    const errorCodeMatch = errorMessage.match(/Minified React error #(\d+)/);
    if (errorCodeMatch) {
      const errorCode = errorCodeMatch[1];
      console.error(`React error code: #${errorCode}`);
      console.error(`Full error details: https://react.dev/errors/${errorCode}`);
    }
    
    // Log full error object
    try {
      console.error('Full error object:', JSON.stringify(error, Object.getOwnPropertyNames(error), 2));
    } catch (e) {
      console.error('Could not stringify error:', e);
    }
    
    console.error('===========================');

    this.setState({
      error,
      errorInfo,
    });

    // Call custom error handler if provided
    if (this.props.onError) {
      this.props.onError(error, errorInfo);
    }
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      // Default error UI with full details
      return (
        <div className="p-8 max-w-4xl mx-auto">
          <div className="bg-destructive/10 border border-destructive rounded-lg p-6">
            <h2 className="text-2xl font-bold text-destructive mb-4">
              Something went wrong
            </h2>
            {this.state.error && (
              <div className="space-y-2 mb-4">
                <div>
                  <strong>Error:</strong> {this.state.error.name}
                </div>
                <div>
                  <strong>Message:</strong> {this.state.error.message}
                </div>
                {this.state.error.stack && (
                  <details className="mt-4">
                    <summary className="cursor-pointer font-medium">Stack trace</summary>
                    <pre className="mt-2 text-xs bg-muted p-4 rounded overflow-auto">
                      {this.state.error.stack}
                    </pre>
                  </details>
                )}
                {this.state.errorInfo?.componentStack && (
                  <details className="mt-4">
                    <summary className="cursor-pointer font-medium">Component stack</summary>
                    <pre className="mt-2 text-xs bg-muted p-4 rounded overflow-auto">
                      {this.state.errorInfo.componentStack}
                    </pre>
                  </details>
                )}
              </div>
            )}
            <button
              onClick={() => {
                this.setState({ hasError: false, error: null, errorInfo: null });
                window.location.reload();
              }}
              className="mt-4 px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
            >
              Reload page
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

