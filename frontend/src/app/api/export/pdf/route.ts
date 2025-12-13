import { NextRequest, NextResponse } from 'next/server';

/**
 * Professional PDF document styles
 * Designed to match UnifiedMarkdown rendering and DOCX export
 * Optimized for print/PDF output
 */
const PDF_STYLES = `
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
    font-size: 11pt;
    line-height: 1.6;
    color: #1a1a1a;
    padding: 0;
    margin: 0;
    background: #fff;
  }

  /* ═══════════════════════════════════════════════════════════════
     HEADINGS - Clean hierarchy matching UnifiedMarkdown
     ═══════════════════════════════════════════════════════════════ */
  h1, h2, h3, h4, h5, h6 {
    font-weight: 600;
    line-height: 1.3;
    color: #111;
    letter-spacing: -0.02em;
    page-break-after: avoid;
  }
  
  h1 { 
    font-size: 18pt; 
    margin: 24pt 0 12pt 0;
    padding-bottom: 6pt;
    border-bottom: 1pt solid #e0e0e0;
  }
  h1:first-child { margin-top: 0; }
  
  h2 { 
    font-size: 15pt; 
    margin: 20pt 0 10pt 0;
  }
  h2:first-child { margin-top: 0; }
  
  h3 { 
    font-size: 13pt; 
    margin: 16pt 0 8pt 0;
  }
  h3:first-child { margin-top: 0; }
  
  h4 { 
    font-size: 11pt; 
    margin: 14pt 0 6pt 0;
  }
  h4:first-child { margin-top: 0; }
  
  h5 { 
    font-size: 11pt; 
    margin: 12pt 0 4pt 0;
  }
  h5:first-child { margin-top: 0; }
  
  h6 { 
    font-size: 10pt; 
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
     LINKS - Professional blue styling
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
    margin: 12pt 0;
    padding: 8pt 12pt;
    border-left: 3pt solid #e0e0e0;
    background: #fafafa;
    color: #555;
    font-style: italic;
    border-radius: 0 4pt 4pt 0;
  }
  blockquote p { 
    margin: 4pt 0; 
  }
  blockquote p:first-child { margin-top: 0; }
  blockquote p:last-child { margin-bottom: 0; }
  blockquote:first-child { margin-top: 0; }

  /* ═══════════════════════════════════════════════════════════════
     CODE - Monospace with subtle background
     ═══════════════════════════════════════════════════════════════ */
  /* Inline code */
  code {
    font-family: 'Courier New', Consolas, 'Lucida Console', monospace;
    font-size: 10pt;
    background: #f4f4f5;
    padding: 2pt 4pt;
    border-radius: 2pt;
    color: #1a1a1a;
  }
  
  /* Code blocks */
  pre {
    margin: 12pt 0;
    padding: 12pt;
    background: #f4f4f5;
    border: 1pt solid #e4e4e7;
    border-radius: 4pt;
    overflow-x: auto;
    font-size: 9.5pt;
    line-height: 1.5;
    page-break-inside: avoid;
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
    margin: 14pt 0;
    border-collapse: collapse; 
    font-size: 10.5pt;
    page-break-inside: avoid;
  }
  table:first-child { margin-top: 0; }
  
  thead {
    background: #f8f9fa;
  }
  
  th { 
    padding: 8pt 10pt;
    border: 1pt solid #d0d0d0;
    text-align: left;
    font-weight: 600;
    font-size: 10pt;
    text-transform: uppercase;
    letter-spacing: 0.3pt;
    color: #333;
    background: #f8f9fa;
  }
  
  td { 
    padding: 8pt 10pt;
    border: 1pt solid #d0d0d0;
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
    border-top: 1pt solid #e0e0e0;
    margin: 20pt 0;
  }

  /* ═══════════════════════════════════════════════════════════════
     IMAGES - Responsive with spacing
     ═══════════════════════════════════════════════════════════════ */
  img {
    max-width: 100%;
    height: auto;
    display: block;
    margin: 12pt 0;
    page-break-inside: avoid;
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
    gap: 8pt;
    padding-left: 0;
  }
  
  li.task-list-item input { 
    margin-top: 4pt; 
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
  dt:first-child { margin-top: 0; }
  
  dd {
    margin-left: 24pt;
    margin-bottom: 4pt;
  }

  /* ═══════════════════════════════════════════════════════════════
     KEYBOARD SHORTCUTS
     ═══════════════════════════════════════════════════════════════ */
  kbd {
    font-family: 'Courier New', Consolas, monospace;
    font-size: 9pt;
    background: #f4f4f5;
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
    border-radius: 1pt;
  }

  /* ═══════════════════════════════════════════════════════════════
     FIGURE & FIGCAPTION
     ═══════════════════════════════════════════════════════════════ */
  figure {
    margin: 14pt 0;
    page-break-inside: avoid;
  }
  
  figcaption {
    font-size: 10pt;
    color: #666;
    text-align: center;
    margin-top: 6pt;
    font-style: italic;
  }

  /* ═══════════════════════════════════════════════════════════════
     PRINT STYLES - Optimize for PDF export
     ═══════════════════════════════════════════════════════════════ */
  @media print {
    body { 
      font-size: 11pt;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
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
    tr {
      page-break-inside: avoid;
    }
  }

  @page {
    size: A4;
    margin: 20mm;
  }
`;

/**
 * Preprocess HTML for better PDF compatibility
 */
function preprocessHtmlForPdf(html: string): string {
  if (!html || typeof html !== 'string') {
    return '<p></p>';
  }

  let processed = html;

  // Remove script/style tags
  processed = processed.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  processed = processed.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');

  // Convert HTML entities to Unicode
  processed = processed
    .replace(/&nbsp;/g, ' ')
    .replace(/&mdash;/g, String.fromCharCode(0x2014))
    .replace(/&ndash;/g, String.fromCharCode(0x2013))
    .replace(/&hellip;/g, String.fromCharCode(0x2026))
    .replace(/&lsquo;/g, String.fromCharCode(0x2018))
    .replace(/&rsquo;/g, String.fromCharCode(0x2019))
    .replace(/&ldquo;/g, String.fromCharCode(0x201C))
    .replace(/&rdquo;/g, String.fromCharCode(0x201D));

  // Clean up empty paragraphs
  processed = processed.replace(/<p>\s*<\/p>/g, '');

  // Convert br tags to proper format
  processed = processed.replace(/<br\s*\/?>/gi, '<br/>');

  // Clean up multiple consecutive line breaks
  processed = processed.replace(/(<br\s*\/?>\s*){3,}/gi, '<br/><br/>');

  return processed.trim();
}

export async function POST(request: NextRequest) {
  try {
    const { content, fileName } = await request.json();

    console.log('[PDF Export] Input HTML length:', content?.length || 0);
    console.log('[PDF Export] File name:', fileName);

    if (!content || !fileName) {
      return NextResponse.json(
        { error: 'Content and fileName are required' },
        { status: 400 }
      );
    }

    // Preprocess HTML
    const preprocessedHtml = preprocessHtmlForPdf(content);

    const pdfHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${fileName}</title>
  <style>${PDF_STYLES}</style>
</head>
<body>
${preprocessedHtml}
</body>
</html>`;

    // Use puppeteer for PDF generation
    const puppeteer = await import('puppeteer');
    
    console.log('[PDF Export] Launching puppeteer...');
    
    const browser = await puppeteer.default.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    try {
      const page = await browser.newPage();
      
      // Set content and wait for fonts/images to load
      await page.setContent(pdfHtml, {
        waitUntil: ['networkidle0', 'load'],
      });

      // Generate PDF with proper settings
      const pdfBuffer = await page.pdf({
        format: 'A4',
        margin: {
          top: '20mm',
          bottom: '20mm',
          left: '20mm',
          right: '20mm',
        },
        printBackground: true,
        preferCSSPageSize: true,
      });

      console.log('[PDF Export] Generated PDF size:', pdfBuffer.length, 'bytes');

      return new NextResponse(pdfBuffer, {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="${fileName}.pdf"`,
        },
      });
    } finally {
      await browser.close();
    }
  } catch (error) {
    console.error('[PDF Export] Error:', error);
    return NextResponse.json(
      { 
        error: 'Failed to generate PDF document', 
        details: error instanceof Error ? error.message : 'Unknown error' 
      },
      { status: 500 }
    );
  }
}
