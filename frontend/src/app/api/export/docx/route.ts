import { NextRequest, NextResponse } from 'next/server';

/**
 * Professional Word-compatible document styles
 * Designed to match UnifiedMarkdown rendering as closely as possible
 * 
 * Typography: Calibri 11pt base, proper heading hierarchy
 * Colors: Dark gray text (#1a1a1a), subtle borders (#e0e0e0)
 * Spacing: Consistent margins matching web rendering
 */
const WORD_STYLES = `
  /* ═══════════════════════════════════════════════════════════════
     BASE DOCUMENT STYLES
     ═══════════════════════════════════════════════════════════════ */
  body { 
    font-family: Calibri, 'Segoe UI', Arial, sans-serif;
    font-size: 11pt;
    line-height: 1.6;
    color: #1a1a1a;
    margin: 0;
    padding: 0;
  }

  /* ═══════════════════════════════════════════════════════════════
     HEADINGS - Clean hierarchy matching UnifiedMarkdown
     H1: 18pt with bottom border (like web version)
     H2-H6: Decreasing sizes with proper margins
     ═══════════════════════════════════════════════════════════════ */
  h1 { 
    font-size: 18pt; 
    font-weight: 600; 
    margin: 24pt 0 12pt 0; 
    padding-bottom: 6pt;
    border-bottom: 1pt solid #e0e0e0;
    color: #111; 
    letter-spacing: -0.5pt;
  }
  h1:first-child { margin-top: 0; }
  
  h2 { 
    font-size: 15pt; 
    font-weight: 600; 
    margin: 20pt 0 10pt 0; 
    color: #111; 
    letter-spacing: -0.3pt;
  }
  h2:first-child { margin-top: 0; }
  
  h3 { 
    font-size: 13pt; 
    font-weight: 600; 
    margin: 16pt 0 8pt 0; 
    color: #111; 
  }
  h3:first-child { margin-top: 0; }
  
  h4 { 
    font-size: 11pt; 
    font-weight: 600; 
    margin: 14pt 0 6pt 0; 
    color: #111;
  }
  h4:first-child { margin-top: 0; }
  
  h5 { 
    font-size: 11pt; 
    font-weight: 600; 
    margin: 12pt 0 4pt 0; 
    color: #222;
  }
  h5:first-child { margin-top: 0; }
  
  h6 { 
    font-size: 10pt; 
    font-weight: 600; 
    margin: 12pt 0 4pt 0; 
    color: #555;
    text-transform: uppercase;
    letter-spacing: 0.5pt;
  }
  h6:first-child { margin-top: 0; }

  /* ═══════════════════════════════════════════════════════════════
     PARAGRAPHS & TEXT
     ═══════════════════════════════════════════════════════════════ */
  p { 
    margin: 8pt 0; 
    line-height: 1.65;
  }
  p:first-child { margin-top: 0; }
  p:last-child { margin-bottom: 0; }
  
  /* Text formatting */
  strong, b { font-weight: 600; }
  em, i { font-style: italic; }
  u { text-decoration: underline; }
  s, strike, del { 
    text-decoration: line-through; 
    color: #666;
  }

  /* ═══════════════════════════════════════════════════════════════
     LINKS - Professional blue with underline
     ═══════════════════════════════════════════════════════════════ */
  a { 
    color: #0066cc; 
    text-decoration: underline;
  }

  /* ═══════════════════════════════════════════════════════════════
     LISTS - Proper indentation and spacing
     ═══════════════════════════════════════════════════════════════ */
  ul, ol { 
    margin: 10pt 0; 
    padding-left: 28pt; 
  }
  ul:first-child, ol:first-child { margin-top: 0; }
  ul:last-child, ol:last-child { margin-bottom: 0; }
  
  li { 
    margin: 4pt 0; 
    line-height: 1.5;
    padding-left: 4pt;
  }
  
  /* Nested lists */
  li > ul, li > ol { 
    margin: 4pt 0; 
  }

  /* ═══════════════════════════════════════════════════════════════
     BLOCKQUOTES - Left border with muted styling
     ═══════════════════════════════════════════════════════════════ */
  blockquote { 
    margin: 12pt 0 12pt 0; 
    padding: 8pt 0 8pt 12pt;
    border-left: 3pt solid #d0d0d0;
    color: #555;
    font-style: italic;
    background-color: #fafafa;
  }
  blockquote p { 
    margin: 4pt 0; 
  }
  blockquote:first-child { margin-top: 0; }

  /* ═══════════════════════════════════════════════════════════════
     CODE - Monospace with subtle background
     ═══════════════════════════════════════════════════════════════ */
  /* Inline code */
  code { 
    font-family: 'Courier New', Consolas, 'Lucida Console', monospace;
    font-size: 10pt;
    background-color: #f4f4f5;
    padding: 2pt 4pt;
    border-radius: 2pt;
    color: #1a1a1a;
  }
  
  /* Code blocks */
  pre { 
    font-family: 'Courier New', Consolas, 'Lucida Console', monospace;
    font-size: 9.5pt;
    line-height: 1.5;
    background-color: #f4f4f5;
    padding: 12pt;
    margin: 12pt 0;
    border: 1pt solid #e4e4e7;
    border-radius: 4pt;
    white-space: pre-wrap;
    word-wrap: break-word;
    overflow-x: auto;
  }
  pre:first-child { margin-top: 0; }
  
  pre code {
    font-size: inherit;
    background: none;
    padding: 0;
    border-radius: 0;
    color: inherit;
  }

  /* ═══════════════════════════════════════════════════════════════
     TABLES - Clean borders with header styling
     ═══════════════════════════════════════════════════════════════ */
  table { 
    border-collapse: collapse; 
    width: 100%; 
    margin: 14pt 0;
    font-size: 10.5pt;
  }
  table:first-child { margin-top: 0; }
  
  thead {
    background-color: #f8f9fa;
  }
  
  th { 
    border: 1pt solid #d0d0d0; 
    padding: 8pt 10pt;
    text-align: left;
    font-weight: 600;
    font-size: 10pt;
    text-transform: uppercase;
    letter-spacing: 0.3pt;
    color: #333;
    background-color: #f8f9fa;
  }
  
  td { 
    border: 1pt solid #d0d0d0; 
    padding: 8pt 10pt;
    text-align: left;
    vertical-align: top;
  }
  
  tr:nth-child(even) td {
    background-color: #fafafa;
  }

  /* ═══════════════════════════════════════════════════════════════
     HORIZONTAL RULE - Subtle divider
     ═══════════════════════════════════════════════════════════════ */
  hr { 
    border: none; 
    border-top: 1pt solid #e0e0e0; 
    margin: 20pt 0; 
  }

  /* ═══════════════════════════════════════════════════════════════
     IMAGES - Responsive with spacing
     ═══════════════════════════════════════════════════════════════ */
  img { 
    max-width: 100%; 
    height: auto;
    margin: 12pt 0;
    display: block;
  }

  /* ═══════════════════════════════════════════════════════════════
     TASK LISTS (checkboxes)
     ═══════════════════════════════════════════════════════════════ */
  ul.task-list,
  ul.contains-task-list { 
    list-style: none; 
    padding-left: 0; 
  }
  
  li.task-list-item {
    padding-left: 24pt;
    position: relative;
  }
  
  input[type="checkbox"] {
    margin-right: 8pt;
  }

  /* ═══════════════════════════════════════════════════════════════
     DEFINITION LISTS
     ═══════════════════════════════════════════════════════════════ */
  dl {
    margin: 10pt 0;
  }
  
  dt {
    font-weight: 600;
    margin-top: 8pt;
  }
  
  dd {
    margin-left: 24pt;
    margin-bottom: 4pt;
  }

  /* ═══════════════════════════════════════════════════════════════
     SUBSCRIPT & SUPERSCRIPT
     ═══════════════════════════════════════════════════════════════ */
  sub { 
    font-size: 8pt; 
    vertical-align: sub; 
  }
  
  sup { 
    font-size: 8pt; 
    vertical-align: super; 
  }

  /* ═══════════════════════════════════════════════════════════════
     KEYBOARD SHORTCUTS
     ═══════════════════════════════════════════════════════════════ */
  kbd {
    font-family: 'Courier New', Consolas, monospace;
    font-size: 9pt;
    background-color: #f4f4f5;
    border: 1pt solid #d0d0d0;
    border-radius: 2pt;
    padding: 1pt 4pt;
  }

  /* ═══════════════════════════════════════════════════════════════
     MARK / HIGHLIGHT
     ═══════════════════════════════════════════════════════════════ */
  mark {
    background-color: #fef08a;
    padding: 0 2pt;
  }

  /* ═══════════════════════════════════════════════════════════════
     ABBREVIATIONS
     ═══════════════════════════════════════════════════════════════ */
  abbr {
    text-decoration: underline dotted;
    cursor: help;
  }

  /* ═══════════════════════════════════════════════════════════════
     FIGURE & FIGCAPTION
     ═══════════════════════════════════════════════════════════════ */
  figure {
    margin: 14pt 0;
  }
  
  figcaption {
    font-size: 10pt;
    color: #666;
    text-align: center;
    margin-top: 6pt;
    font-style: italic;
  }
`;

/**
 * Preprocess HTML for better Word compatibility
 * Cleans up and normalizes HTML before conversion
 */
function preprocessHtmlForWord(html: string): string {
  if (!html || typeof html !== 'string') {
    return '<p></p>';
  }

  let processed = html;

  // 1. Remove any script/style tags that might have slipped through
  processed = processed.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  processed = processed.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');

  // 2. Convert common HTML entities to their Unicode equivalents
  processed = processed
    .replace(/&nbsp;/g, ' ')
    .replace(/&mdash;/g, String.fromCharCode(0x2014))  // em dash
    .replace(/&ndash;/g, String.fromCharCode(0x2013))  // en dash
    .replace(/&hellip;/g, String.fromCharCode(0x2026)) // ellipsis
    .replace(/&lsquo;/g, String.fromCharCode(0x2018))  // left single quote
    .replace(/&rsquo;/g, String.fromCharCode(0x2019))  // right single quote
    .replace(/&ldquo;/g, String.fromCharCode(0x201C))  // left double quote
    .replace(/&rdquo;/g, String.fromCharCode(0x201D)); // right double quote

  // 3. Clean up empty paragraphs (keep one if content is empty)
  processed = processed.replace(/<p>\s*<\/p>/g, '');
  
  // 4. Ensure tables have proper structure
  // Wrap table rows in tbody if they're not in thead/tbody
  processed = processed.replace(
    /<table([^>]*)>((?:(?!<tbody|<thead)[\s\S])*?)(<tr[\s\S]*?<\/tr>)([\s\S]*?)<\/table>/gi,
    (match, tableAttrs, before, rows, after) => {
      // Check if there's already a tbody
      if (match.includes('<tbody') || match.includes('<thead')) {
        return match;
      }
      return `<table${tableAttrs}>${before}<tbody>${rows}${after}</tbody></table>`;
    }
  );

  // 5. Clean up whitespace in pre/code blocks while preserving content
  processed = processed.replace(/<pre([^>]*)>([\s\S]*?)<\/pre>/gi, (match, attrs, content) => {
    // Normalize line endings
    const cleanContent = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    return `<pre${attrs}>${cleanContent}</pre>`;
  });

  // 6. Convert data-* attributes for task lists to something Word can understand
  processed = processed.replace(/<li[^>]*data-checked="true"[^>]*>/gi, '<li class="task-list-item checked">');
  processed = processed.replace(/<li[^>]*data-checked="false"[^>]*>/gi, '<li class="task-list-item">');

  // 7. Handle TipTap-specific classes
  processed = processed.replace(/class="[^"]*task-list[^"]*"/gi, 'class="task-list"');

  // 8. Remove empty divs and spans that might cause issues
  processed = processed.replace(/<div>\s*<\/div>/g, '');
  processed = processed.replace(/<span>\s*<\/span>/g, '');

  // 9. Convert br tags to proper format
  processed = processed.replace(/<br\s*\/?>/gi, '<br/>');

  // 10. Ensure proper paragraph wrapping for loose text
  // This is a simple heuristic - wrap text that's directly in the body
  processed = processed.replace(/^([^<]+)$/gm, (match) => {
    const trimmed = match.trim();
    if (trimmed && !trimmed.startsWith('<')) {
      return `<p>${trimmed}</p>`;
    }
    return match;
  });

  // 11. Clean up multiple consecutive line breaks
  processed = processed.replace(/(<br\s*\/?>\s*){3,}/gi, '<br/><br/>');

  // 12. Remove any remaining Tailwind/utility classes that won't work in Word
  // But keep structural classes like 'task-list'
  processed = processed.replace(/class="([^"]*)"/gi, (match, classes) => {
    const keepClasses = ['task-list', 'task-list-item', 'checked', 'contains-task-list'];
    const filteredClasses = classes
      .split(/\s+/)
      .filter((cls: string) => keepClasses.some(keep => cls.includes(keep)))
      .join(' ');
    return filteredClasses ? `class="${filteredClasses}"` : '';
  });

  return processed.trim();
}

export async function POST(request: NextRequest) {
  try {
    // Polyfill console.warning for html-to-docx library bug
    const consoleAny = console as unknown as Record<string, unknown>;
    if (typeof consoleAny.warning === 'undefined') {
      consoleAny.warning = console.warn.bind(console);
    }

    const { default: HTMLtoDOCX } = await import('html-to-docx');
    const { content, fileName } = await request.json();

    // Debug logging
    console.log('[DOCX Export] Input HTML length:', content?.length || 0);
    console.log('[DOCX Export] File name:', fileName);

    if (!content || !fileName) {
      return NextResponse.json(
        { error: 'Content and fileName are required' },
        { status: 400 }
      );
    }

    // Preprocess HTML for better Word compatibility
    const preprocessedHtml = preprocessHtmlForWord(content);
    
    console.log('[DOCX Export] Preprocessed HTML preview:', preprocessedHtml.substring(0, 500));

    const docxHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${fileName}</title>
  <style>${WORD_STYLES}</style>
</head>
<body>
${preprocessedHtml}
</body>
</html>`;

    // Convert to DOCX with optimized settings
    const docxBuffer = await HTMLtoDOCX(docxHtml, null, {
      orientation: 'portrait' as const,
      margins: {
        top: 1440,      // 1 inch = 1440 twips
        bottom: 1440,
        left: 1440,
        right: 1440,
      },
      title: fileName,
      subject: '',
      creator: 'Kortix',
      keywords: ['document', 'export'],
      description: `Document exported from Kortix`,
      lastModifiedBy: 'Kortix',
      revision: 1,
      font: 'Calibri',
      fontSize: 22,  // 11pt in half-points
      complexScriptFontSize: 22,
      table: {
        row: {
          cantSplit: true,  // Prevent rows from splitting across pages
        },
      },
      footer: false,
      header: false,
      pageNumber: false,
    });
    
    const uint8Array = new Uint8Array(docxBuffer as ArrayBuffer);
    
    console.log('[DOCX Export] Generated DOCX size:', uint8Array.length, 'bytes');
    
    return new NextResponse(uint8Array, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename="${fileName}.docx"`,
      },
    });
  } catch (error) {
    console.error('[DOCX Export] Error:', error);
    return NextResponse.json(
      { error: 'Failed to generate Word document', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
