// Polyfill for Promise.withResolvers (Node.js 21+ / older browsers)
// Required by pdfjs-dist 4.x (used by the PDF renderer) on Node 20 / Safari < 17.4
if (!Promise.withResolvers) {
  Promise.withResolvers = function <T>(): {
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: any) => void;
  } {
    let resolve: (value: T | PromiseLike<T>) => void;
    let reject: (reason?: any) => void;
    
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    
    return { promise, resolve: resolve!, reject: reject! };
  };
}

// Suppress specific React warnings from third-party libraries (e.g., Syncfusion)
// These warnings are harmless but noisy - they come from libraries using deprecated patterns
if (typeof window !== 'undefined') {
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    // Filter out the "selected" on <option> warning from Syncfusion components
    if (
      typeof args[0] === 'string' &&
      args[0].includes('Use the `defaultValue` or `value` props on <select> instead of setting `selected` on <option>')
    ) {
      return; // Suppress this specific warning
    }
    originalError.apply(console, args);
  };
}

export {};
