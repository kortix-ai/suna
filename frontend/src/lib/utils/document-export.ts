import { toast } from 'sonner';
import { saveAs } from 'file-saver';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

export type ExportFormat = 'pdf' | 'docx' | 'html' | 'markdown';

export interface DocumentExportOptions {
  content: string;
  fileName: string;
  format: ExportFormat;
}

/**
 * Professional document styles for PDF and HTML export
 * Designed to match UnifiedMarkdown rendering and sync with Word export styles
 * 
 * Typography: System fonts for web, proper heading hierarchy
 * Colors: Dark gray text (#1a1a1a), subtle borders (#e0e0e0)
 * Spacing: Consistent margins matching app rendering
 */
const DOCUMENT_STYLES = `
  /* ═══════════════════════════════════════════════════════════════
     BASE RESET & DOCUMENT STYLES
     ═══════════════════════════════════════════════════════════════ */
  * { 
    margin: 0; 
    padding: 0; 
    box-sizing: border-box; 
  }
  
  body { 
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    font-size: 16px;
    line-height: 1.65;
    color: #1a1a1a;
    max-width: 720px;
    margin: 0 auto;
    padding: 48px 24px;
    background: #fff;
  }

  /* ═══════════════════════════════════════════════════════════════
     HEADINGS - Clean hierarchy matching UnifiedMarkdown
     H1: Large with bottom border (like web version)
     H2-H6: Decreasing sizes with proper margins
     ═══════════════════════════════════════════════════════════════ */
  h1, h2, h3, h4, h5, h6 {
    font-weight: 600;
    line-height: 1.3;
    color: #111;
    letter-spacing: -0.02em;
  }
  
  h1 { 
    font-size: 2em; 
    margin: 1.5em 0 0.75em 0;
    padding-bottom: 0.4em;
    border-bottom: 1px solid #e0e0e0;
  }
  h1:first-child { margin-top: 0; }
  
  h2 { 
    font-size: 1.5em; 
    margin: 1.5em 0 0.6em 0;
  }
  h2:first-child { margin-top: 0; }
  
  h3 { 
    font-size: 1.25em; 
    margin: 1.25em 0 0.5em 0;
  }
  h3:first-child { margin-top: 0; }
  
  h4 { 
    font-size: 1.1em; 
    margin: 1.1em 0 0.4em 0;
  }
  h4:first-child { margin-top: 0; }
  
  h5 { 
    font-size: 1em; 
    margin: 1em 0 0.3em 0;
  }
  h5:first-child { margin-top: 0; }
  
  h6 { 
    font-size: 0.9em; 
    margin: 1em 0 0.3em 0;
    color: #555;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  h6:first-child { margin-top: 0; }

  /* ═══════════════════════════════════════════════════════════════
     PARAGRAPHS & TEXT
     ═══════════════════════════════════════════════════════════════ */
  p { 
    margin: 1em 0; 
    line-height: 1.7;
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
     LINKS - Professional blue styling
     ═══════════════════════════════════════════════════════════════ */
  a { 
    color: #0066cc; 
    text-decoration: underline;
    text-decoration-color: rgba(0, 102, 204, 0.4);
    text-underline-offset: 2px;
  }
  a:hover { 
    text-decoration-color: rgba(0, 102, 204, 0.8);
  }

  /* ═══════════════════════════════════════════════════════════════
     LISTS - Proper indentation and spacing
     ═══════════════════════════════════════════════════════════════ */
  ul, ol { 
    margin: 1em 0; 
    padding-left: 2em; 
  }
  ul:first-child, ol:first-child { margin-top: 0; }
  ul:last-child, ol:last-child { margin-bottom: 0; }
  
  li { 
    margin: 0.4em 0; 
    line-height: 1.6;
  }
  
  /* Nested lists */
  li > ul, li > ol { 
    margin: 0.4em 0; 
  }

  /* ═══════════════════════════════════════════════════════════════
     BLOCKQUOTES - Left border with muted styling
     ═══════════════════════════════════════════════════════════════ */
  blockquote { 
    margin: 1.5em 0;
    padding: 0.75em 1em;
    border-left: 4px solid #e0e0e0;
    background: #fafafa;
    color: #555;
    font-style: italic;
    border-radius: 0 4px 4px 0;
  }
  blockquote p { 
    margin: 0.5em 0; 
  }
  blockquote p:first-child { margin-top: 0; }
  blockquote p:last-child { margin-bottom: 0; }
  blockquote:first-child { margin-top: 0; }

  /* ═══════════════════════════════════════════════════════════════
     CODE - Monospace with subtle background
     ═══════════════════════════════════════════════════════════════ */
  /* Inline code */
  code {
    font-family: 'SF Mono', Monaco, 'Cascadia Code', Consolas, 'Courier New', monospace;
    font-size: 0.9em;
    background: #f4f4f5;
    padding: 0.15em 0.4em;
    border-radius: 4px;
    color: #1a1a1a;
  }
  
  /* Code blocks */
  pre {
    margin: 1.5em 0;
    padding: 1em;
    background: #f4f4f5;
    border: 1px solid #e4e4e7;
    border-radius: 8px;
    overflow-x: auto;
    font-size: 0.9em;
    line-height: 1.5;
  }
  pre:first-child { margin-top: 0; }
  
  pre code {
    background: none;
    padding: 0;
    border-radius: 0;
    font-size: inherit;
    color: inherit;
  }

  /* ═══════════════════════════════════════════════════════════════
     TABLES - Clean borders with header styling
     ═══════════════════════════════════════════════════════════════ */
  table { 
    width: 100%;
    margin: 1.5em 0;
    border-collapse: collapse; 
    font-size: 0.95em;
  }
  table:first-child { margin-top: 0; }
  
  thead {
    background: #f8f9fa;
  }
  
  th { 
    padding: 0.75em 1em;
    border: 1px solid #e0e0e0;
    text-align: left;
    font-weight: 600;
    font-size: 0.85em;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: #333;
    background: #f8f9fa;
  }
  
  td { 
    padding: 0.75em 1em;
    border: 1px solid #e0e0e0;
    text-align: left;
    vertical-align: top;
  }
  
  tr:nth-child(even) td { 
    background: #fafafa; 
  }

  /* ═══════════════════════════════════════════════════════════════
     HORIZONTAL RULE - Subtle divider
     ═══════════════════════════════════════════════════════════════ */
  hr {
    border: none;
    border-top: 2px solid #e0e0e0;
    margin: 2em 0;
  }

  /* ═══════════════════════════════════════════════════════════════
     IMAGES - Responsive with spacing
     ═══════════════════════════════════════════════════════════════ */
  img {
    max-width: 100%;
    height: auto;
    display: block;
    margin: 1.5em 0;
    border-radius: 4px;
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
    display: flex; 
    align-items: flex-start; 
    gap: 0.5em;
    padding-left: 0;
  }
  
  li.task-list-item input { 
    margin-top: 0.35em; 
  }

  /* ═══════════════════════════════════════════════════════════════
     DEFINITION LISTS
     ═══════════════════════════════════════════════════════════════ */
  dl {
    margin: 1em 0;
  }
  
  dt {
    font-weight: 600;
    margin-top: 1em;
  }
  dt:first-child { margin-top: 0; }
  
  dd {
    margin-left: 1.5em;
    margin-bottom: 0.5em;
  }

  /* ═══════════════════════════════════════════════════════════════
     KEYBOARD SHORTCUTS
     ═══════════════════════════════════════════════════════════════ */
  kbd {
    font-family: 'SF Mono', Monaco, Consolas, 'Courier New', monospace;
    font-size: 0.85em;
    background: #f4f4f5;
    border: 1px solid #d0d0d0;
    border-radius: 3px;
    padding: 0.1em 0.4em;
    box-shadow: 0 1px 0 #d0d0d0;
  }

  /* ═══════════════════════════════════════════════════════════════
     MARK / HIGHLIGHT
     ═══════════════════════════════════════════════════════════════ */
  mark {
    background-color: #fef08a;
    padding: 0 0.2em;
    border-radius: 2px;
  }

  /* ═══════════════════════════════════════════════════════════════
     FIGURE & FIGCAPTION
     ═══════════════════════════════════════════════════════════════ */
  figure {
    margin: 1.5em 0;
  }
  
  figcaption {
    font-size: 0.9em;
    color: #666;
    text-align: center;
    margin-top: 0.5em;
    font-style: italic;
  }

  /* ═══════════════════════════════════════════════════════════════
     PRINT STYLES - Optimize for PDF export
     ═══════════════════════════════════════════════════════════════ */
  @media print {
    body { 
      max-width: none; 
      padding: 0;
      font-size: 11pt;
    }
    pre { 
      white-space: pre-wrap; 
      word-wrap: break-word;
      page-break-inside: avoid;
    }
    h1, h2, h3, h4, h5, h6 {
      page-break-after: avoid;
    }
    table {
      page-break-inside: avoid;
    }
    img {
      page-break-inside: avoid;
    }
  }
`;

/**
 * Ensure content is valid HTML
 */
function normalizeHtmlContent(content: string): string {
  if (typeof content !== 'string' || !content.trim()) return '<p></p>';
  
  // If it looks like HTML, return as-is
  if (content.includes('<')) return content;
  
  // Otherwise wrap plain text in paragraphs
  return content
    .split('\n')
    .map(line => line.trim() ? `<p>${line}</p>` : '')
    .filter(Boolean)
    .join('\n');
}

/**
 * Sanitize filename for safe file system use
 */
function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9-_. ]/g, '').trim() || 'document';
}

/**
 * Create a complete, standalone HTML document
 */
function createHtmlDocument(content: string, title: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>${DOCUMENT_STYLES}</style>
</head>
<body>
${content}
</body>
</html>`;
}

/**
 * Export document to various formats
 */
export async function exportDocument({ content, fileName, format }: DocumentExportOptions): Promise<void> {
  const htmlContent = normalizeHtmlContent(content);
  const safeFileName = sanitizeFileName(fileName);

  // Debug logging
  console.log(`[Document Export] Format: ${format}`);
  console.log(`[Document Export] File name: ${safeFileName}`);
  console.log(`[Document Export] Content length: ${content?.length || 0}`);
  console.log(`[Document Export] HTML content preview:`, htmlContent.substring(0, 300));

  try {
    switch (format) {
      case 'pdf': {
        console.log('[Document Export] Opening print dialog for PDF...');
        
        const printWindow = window.open('', '_blank', 'width=800,height=600');
        if (!printWindow) {
          toast.error('Popup blocked. Please allow popups for PDF export.');
          return;
        }

        const pdfHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${safeFileName}</title>
  <style>
    @page { size: A4; margin: 20mm; }
    @media print {
      body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    }
    ${DOCUMENT_STYLES}
  </style>
</head>
<body>
  ${htmlContent}
<script>
  window.onload = function() {
    setTimeout(function() { window.print(); }, 200);
    window.onafterprint = function() { window.close(); };
  };
</script>
</body>
</html>`;

        printWindow.document.write(pdfHtml);
        printWindow.document.close();
        toast.success('Print dialog opened — select "Save as PDF"');
        break;
      }

      case 'docx': {
        console.log('[Document Export] Sending to DOCX API...');
        
        const toastId = toast.loading('Exporting to Word...');
        
        try {
          const response = await fetch('/api/export/docx', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: htmlContent, fileName: safeFileName }),
          });

          console.log('[Document Export] DOCX API response status:', response.status);

          if (!response.ok) {
            const err = await response.json().catch(() => ({ error: 'Export failed' }));
            console.error('[Document Export] DOCX API error:', err);
            throw new Error(err.error || `Error ${response.status}`);
          }

          const blob = await response.blob();
          console.log('[Document Export] DOCX blob size:', blob.size, 'bytes');
          
          saveAs(blob, `${safeFileName}.docx`);
          toast.success('Word document exported', { id: toastId });
        } catch (error) {
          console.error('[Document Export] DOCX export error:', error);
          toast.error(`Word export failed: ${error instanceof Error ? error.message : 'Unknown error'}`, { id: toastId });
        }
        break;
      }

      case 'html': {
        console.log('[Document Export] Creating HTML file...');
        
        const fullHtml = createHtmlDocument(htmlContent, safeFileName);
        const blob = new Blob([fullHtml], { type: 'text/html;charset=utf-8' });
        
        console.log('[Document Export] HTML blob size:', blob.size, 'bytes');
        
        saveAs(blob, `${safeFileName}.html`);
        toast.success('HTML exported');
        break;
      }

      case 'markdown': {
        console.log('[Document Export] Converting to Markdown...');
        
        const turndown = new TurndownService({
          headingStyle: 'atx',
          hr: '---',
          bulletListMarker: '-',
          codeBlockStyle: 'fenced',
          fence: '```',
          emDelimiter: '*',
          strongDelimiter: '**',
          linkStyle: 'inlined',
        });
        
        turndown.use(gfm);
        
        // Preserve code block languages
        turndown.addRule('fencedCodeBlock', {
          filter: (node) => 
            node.nodeName === 'PRE' && 
            node.firstChild?.nodeName === 'CODE',
          replacement: (_content, node) => {
            const codeEl = node.firstChild as HTMLElement;
            const langMatch = (codeEl.getAttribute('class') || '').match(/language-(\w+)/);
            const lang = langMatch ? langMatch[1] : '';
            const code = codeEl.textContent || '';
            return `\n\`\`\`${lang}\n${code}\n\`\`\`\n`;
          },
        });
        
        let md = turndown.turndown(htmlContent);
        md = md.replace(/\n{3,}/g, '\n\n').trim();
        
        console.log('[Document Export] Markdown length:', md.length);
        
        const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
        saveAs(blob, `${safeFileName}.md`);
        toast.success('Markdown exported');
        break;
      }

      default:
        console.error('[Document Export] Unknown format:', format);
        toast.error(`Unknown format: ${format}`);
    }
  } catch (error) {
    console.error(`[Document Export] Error (${format}):`, error);
    toast.error(`Export failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}
