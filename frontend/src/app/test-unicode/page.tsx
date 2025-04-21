'use client';

import React, { useEffect, useState } from 'react';
import { MarkdownRenderer } from '@/components/file-renderers/markdown-renderer';

export default function TestUnicodePage() {
  const [markdownContent, setMarkdownContent] = useState('');
  const [escapedContent, setEscapedContent] = useState('');

  useEffect(() => {
    // Fetch the test markdown file
    fetch('/test-japanese.md')
      .then(response => response.text())
      .then(text => {
        setMarkdownContent(text);
        
        // Create a test string with Unicode escape sequences
        const japaneseWithEscapes = "\\u3053\\u3093\\u306b\\u3061\\u306f (Hello)\\n\\u3042\\u308a\\u304c\\u3068\\u3046 (Thank you)";
        setEscapedContent(japaneseWithEscapes);
      })
      .catch(error => console.error('Error loading markdown file:', error));
  }, []);

  return (
    <div className="container mx-auto py-8">
      <h1 className="text-2xl font-bold mb-6">Unicode/Japanese Text Testing</h1>
      
      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        <div className="border rounded-md shadow-sm">
          <div className="p-4 border-b bg-slate-50 dark:bg-slate-800">
            <h2 className="font-medium">Direct Japanese Characters</h2>
          </div>
          <div className="p-4">
            <p className="mb-4 cjk-text">
              こんにちは - Hello<br />
              おはようございます - Good morning<br />
              ありがとうございます - Thank you<br />
              日本語を表示するテスト - Test displaying Japanese
            </p>
          </div>
        </div>
        
        <div className="border rounded-md shadow-sm">
          <div className="p-4 border-b bg-slate-50 dark:bg-slate-800">
            <h2 className="font-medium">Unicode Escape Sequence Test</h2>
          </div>
          <div className="p-4">
            <p className="mb-2">Raw escaped content:</p>
            <pre className="bg-slate-100 dark:bg-slate-900 p-2 rounded mb-4 overflow-x-auto">
              {escapedContent}
            </pre>
            <p className="mb-2">Processed content:</p>
            <div className="bg-slate-100 dark:bg-slate-900 p-2 rounded">
              <MarkdownRenderer content={escapedContent} />
            </div>
          </div>
        </div>
      </div>
      
      <div className="mt-8 border rounded-md shadow-sm">
        <div className="p-4 border-b bg-slate-50 dark:bg-slate-800">
          <h2 className="font-medium">Markdown File with Japanese Characters</h2>
        </div>
        <div className="p-4">
          {markdownContent ? (
            <MarkdownRenderer content={markdownContent} />
          ) : (
            <p>Loading markdown content...</p>
          )}
        </div>
      </div>
    </div>
  );
} 