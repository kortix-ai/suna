import { NextRequest, NextResponse } from 'next/server';
import HTMLtoDOCX from 'html-to-docx';

export async function POST(request: NextRequest) {
  try {
    const { content, fileName } = await request.json();

    if (!content || !fileName) {
      return NextResponse.json(
        { error: 'Content and fileName are required' },
        { status: 400 }
      );
    }

    const docxContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { 
            font-family: Calibri, Arial, sans-serif;
            font-size: 11pt;
            line-height: 1.6;
          }
          h1 { font-size: 16pt; font-weight: bold; margin: 12pt 0; }
          h2 { font-size: 14pt; font-weight: bold; margin: 10pt 0; }
          h3 { font-size: 12pt; font-weight: bold; margin: 8pt 0; }
          p { margin: 6pt 0; }
          ul, ol { margin: 6pt 0; padding-left: 36pt; }
          li { margin: 3pt 0; }
          blockquote { 
            margin: 6pt 0 6pt 36pt; 
            font-style: italic; 
          }
          pre { 
            font-family: 'Courier New', monospace;
            font-size: 10pt;
            background-color: #f5f5f5;
            padding: 6pt;
            margin: 6pt 0;
          }
          code { 
            font-family: 'Courier New', monospace;
            font-size: 10pt;
            background-color: #f5f5f5;
          }
          table { 
            border-collapse: collapse; 
            width: 100%; 
            margin: 6pt 0;
          }
          th, td { 
            border: 1px solid #d0d0d0; 
            padding: 4pt 8pt; 
          }
          th { 
            background-color: #f0f0f0; 
            font-weight: bold;
          }
          strong, b { font-weight: bold; }
          em, i { font-style: italic; }
          u { text-decoration: underline; }
          strike, del { text-decoration: line-through; }
          a { color: #0066cc; text-decoration: underline; }
          hr { 
            border: none; 
            border-top: 1px solid #cccccc; 
            margin: 12pt 0; 
          }
        </style>
      </head>
      <body>
        ${content}
      </body>
      </html>
    `;

    const docxOptions = {
      orientation: 'portrait',
      margins: {
        top: 720,
        bottom: 720,
        left: 720,
        right: 720,
      },
      title: fileName,
      creator: 'Suna AI',
      description: 'Document exported from Suna AI',
      font: 'Calibri',
      fontSize: 22,
    };

    const docxBuffer = await HTMLtoDOCX(docxContent, null, docxOptions);
    return new NextResponse(docxBuffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename="${fileName}.docx"`,
      },
    });
  } catch (error) {
    console.error('DOCX export error:', error);
    return NextResponse.json(
      { error: 'Failed to generate DOCX file', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
} 