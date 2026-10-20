/// <reference types="bun" />
// Loads Bun's own types for web tests. A test that imported "bun" used to load them by accident.
declare module 'bun:test' {
  export const describe: (...args: any[]) => any;
  export const expect: (...args: any[]) => any;
  export const test: (...args: any[]) => any;
}
