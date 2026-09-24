'use client';

import dynamic from 'next/dynamic';

/**
 * `CodeEditor` as a separate chunk (CodeMirror core, themes, lint, the
 * diagnostics layer). The file viewer is part of many routes; the editor
 * loads only when a text/code file actually renders.
 *
 * The placeholder only holds the editor's space; `CodeEditor` itself paints an
 * empty surface until its mount effect runs.
 */
export const CodeEditor = dynamic(() => import('./code-editor').then((mod) => mod.CodeEditor), {
  ssr: false,
  loading: () => <div className="min-h-full w-full flex-1" />,
});
