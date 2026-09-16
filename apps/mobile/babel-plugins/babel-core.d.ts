// '@babel/core' ships no type declarations, and there is no '@types/babel__core'
// package installed in this repo (adding one needs a package.json edit, out of
// scope for babel-plugins/). This is a minimal ambient declaration covering only
// what deep-icon-imports.test.ts uses (transformSync). AST/result shapes are
// typed loosely (`any`) on purpose: the test already narrows them itself
// (`out?.ast?.program?.body ?? []`, per-node `.type` checks), and this file's
// job is only to resolve TS7016, not to re-type Babel's AST.
declare module '@babel/core' {
  export interface TransformOptions {
    babelrc?: boolean;
    configFile?: boolean | string;
    filename?: string;
    ast?: boolean;
    parserOpts?: { plugins?: string[] };
    plugins?: unknown[];
    caller?: { name: string; platform?: string };
    [key: string]: unknown;
  }

  export interface BabelFileResult {
    code?: string | null;
    ast?: any;
    [key: string]: unknown;
  }

  export function transformSync(code: string, options?: TransformOptions): BabelFileResult | null;
  export function parseSync(code: string, options?: TransformOptions): any;
}
