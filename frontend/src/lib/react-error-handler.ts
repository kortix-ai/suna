/**
 * Global React error handler
 * Catches and logs React errors with full details
 * This module should be imported early in the app lifecycle
 */

// Initialize immediately when module loads (client-side only)
if (typeof window !== 'undefined') {
  // Handle unhandled React errors
  const originalError = console.error;
  console.error = (...args: any[]) => {
    // Check if it's a React error
    const errorString = args.join(' ');
    if (errorString.includes('Minified React error') || errorString.includes('React error')) {
      console.group('🚨 REACT ERROR DETECTED');
      console.error('Full error details:', ...args);
      
      // Try to extract error code
      const errorCodeMatch = errorString.match(/error #(\d+)/);
      if (errorCodeMatch) {
        const errorCode = errorCodeMatch[1];
        console.error(`Error code: #${errorCode}`);
        console.error(`Documentation: https://react.dev/errors/${errorCode}`);
      }
      
      // Log all arguments
      args.forEach((arg, index) => {
        if (arg instanceof Error) {
          console.error(`Error ${index}:`, {
            name: arg.name,
            message: arg.message,
            stack: arg.stack,
            ...arg,
          });
        } else if (typeof arg === 'object' && arg !== null) {
          try {
            console.error(`Object ${index}:`, JSON.stringify(arg, null, 2));
          } catch (e) {
            console.error(`Object ${index}:`, arg);
          }
        } else {
          console.error(`Arg ${index}:`, arg);
        }
      });
      
      console.groupEnd();
    }
    
    // Call original console.error
    originalError.apply(console, args);
  };

  // Handle unhandled promise rejections that might be React-related
  window.addEventListener('unhandledrejection', (event) => {
    const error = event.reason;
    if (error && (error.message?.includes('React') || error.message?.includes('Minified'))) {
      console.group('🚨 UNHANDLED REACT PROMISE REJECTION');
      console.error('Error:', error);
      console.error('Error message:', error.message);
      console.error('Error stack:', error.stack);
      console.groupEnd();
    }
  });

  // Handle general errors
  window.addEventListener('error', (event) => {
    const error = event.error;
    if (error && (error.message?.includes('React') || error.message?.includes('Minified'))) {
      console.group('🚨 UNHANDLED REACT ERROR');
      console.error('Error:', error);
      console.error('Error message:', error.message);
      console.error('Error stack:', error.stack);
      console.error('Error filename:', event.filename);
      console.error('Error lineno:', event.lineno);
      console.error('Error colno:', event.colno);
      console.groupEnd();
    }
  });
}

