/**
 * The pure HTML builders behind the WebView-based previews, moved out of
 * `FilePreviewRenderers.tsx` (KRTX-1292). They depend only on theme tokens and
 * the sanitizer, so they are trivially testable and keep the renderer file to
 * React.
 */
import { THEME, withAlpha } from '@/lib/utils/theme';
import { escapeForInlineScript, HTML_SANITIZER_SCRIPT } from '@/lib/utils/html-embed';


/**
 * Generates HTML with highlight.js for syntax-highlighted code rendering.
 */
export function generateHighlightedCodeHtml(
  code: string,
  language: string,
  isDark: boolean,
  bottomInset = 0,
): string {
  const bgColor = isDark ? THEME.dark.card : THEME.light.card;
  const theme = isDark ? 'github-dark' : 'github';
  const lineNumColor = withAlpha(isDark ? THEME.dark.foreground : THEME.light.foreground, 0.2);
  const lineNumBorder = withAlpha(isDark ? THEME.dark.foreground : THEME.light.foreground, 0.06);

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/${theme}.min.css">
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    background: ${bgColor};
    font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
    font-size: 13px;
    line-height: 20px;
    -webkit-text-size-adjust: none;
  }
  body { padding-bottom: ${bottomInset}px; }
  .code-wrapper {
    position: relative;
    display: flex;
    flex-direction: row;
    min-height: 100%;
  }
  .gutter {
    position: sticky;
    left: 0;
    z-index: 2;
    background: ${bgColor};
    flex-shrink: 0;
    padding: 12px 0;
    border-right: 1px solid ${lineNumBorder};
    user-select: none;
    -webkit-user-select: none;
  }
  .gutter-line {
    display: block;
    padding: 0 14px 0 16px;
    text-align: right;
    color: ${lineNumColor};
    font-size: 12px;
    line-height: 20px;
    min-width: 54px;
  }
  .code-area {
    flex: 1;
    padding: 12px 16px;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }
  .code-line {
    display: block;
    line-height: 20px;
    min-height: 20px;
    white-space: pre;
  }
</style>
</head>
<body>
<div class="code-wrapper">
  <div class="gutter" id="gutter"></div>
  <div class="code-area" id="code-area"></div>
</div>
<script>
  var codeStr = ${escapeForInlineScript(JSON.stringify(code))};
  var lang = ${escapeForInlineScript(JSON.stringify(language))};
  var highlighted;
  try {
    var result = hljs.highlight(codeStr, { language: lang, ignoreIllegals: true });
    highlighted = result.value;
  } catch(e) {
    highlighted = codeStr
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  var lines = highlighted.split('\\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();

  var gutter = document.getElementById('gutter');
  var codeArea = document.getElementById('code-area');

  for (var i = 0; i < lines.length; i++) {
    var num = document.createElement('span');
    num.className = 'gutter-line';
    num.textContent = String(i + 1);
    gutter.appendChild(num);

    var line = document.createElement('span');
    line.className = 'code-line';
    line.innerHTML = lines[i] || ' ';
    codeArea.appendChild(line);
  }
</script>
</body>
</html>`;
}


/**
 * Generates HTML with embedded pdf.js for rendering PDFs on Android
 * Android WebView doesn't support native PDF rendering, so we use pdf.js
 */
export function generatePdfJsHtml(base64Data: string, isDark: boolean): string {
  const bgColor = isDark ? THEME.dark.background : THEME.light.background;
  const textColor = isDark ? THEME.dark.foreground : THEME.light.foreground;
  const destructiveColor = isDark ? THEME.dark.destructive : THEME.light.destructive;
  
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=3.0, user-scalable=yes">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { 
      width: 100%; 
      height: 100%; 
      background: ${bgColor};
      overflow-x: hidden;
    }
    #container {
      width: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 8px;
      gap: 8px;
    }
    canvas {
      max-width: 100%;
      height: auto;
      box-shadow: 0 2px 8px rgba(0,0,0,0.15); /* hex-allowlist: fixed black drop-shadow, theme-independent (matches app's shadowColor:'#000' convention) */
      background: white; /* hex-allowlist: rendered PDF page is always paper-white, independent of app theme */
    }
    #loading, #error {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      text-align: center;
      color: ${textColor};
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
    }
    #error { color: ${destructiveColor}; display: none; }
    .page-num {
      color: ${isDark ? withAlpha(THEME.dark.foreground, 0.5) : withAlpha(THEME.light.foreground, 0.5)};
      font-size: 12px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      margin-top: 4px;
      margin-bottom: 12px;
    }
  </style>
</head>
<body>
  <div id="loading">Loading PDF...</div>
  <div id="error">Failed to load PDF</div>
  <div id="container"></div>
  <script>
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    
    async function renderPDF() {
      try {
        const base64 = '${base64Data}';
        const binaryData = atob(base64);
        const bytes = new Uint8Array(binaryData.length);
        for (let i = 0; i < binaryData.length; i++) {
          bytes[i] = binaryData.charCodeAt(i);
        }
        
        // isEvalSupported: false stops font data from compiling to JS (CVE-2024-4367).
        const pdf = await pdfjsLib.getDocument({ data: bytes, isEvalSupported: false }).promise;
        document.getElementById('loading').style.display = 'none';
        
        const container = document.getElementById('container');
        const containerWidth = window.innerWidth - 16;
        
        for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
          const page = await pdf.getPage(pageNum);
          const viewport = page.getViewport({ scale: 1 });
          const scale = Math.min(containerWidth / viewport.width, 2.5);
          const scaledViewport = page.getViewport({ scale });
          
          const canvas = document.createElement('canvas');
          const context = canvas.getContext('2d');
          canvas.width = scaledViewport.width;
          canvas.height = scaledViewport.height;
          
          await page.render({ canvasContext: context, viewport: scaledViewport }).promise;
          container.appendChild(canvas);
          
          const pageLabel = document.createElement('div');
          pageLabel.className = 'page-num';
          pageLabel.textContent = 'Page ' + pageNum + ' of ' + pdf.numPages;
          container.appendChild(pageLabel);
        }
      } catch (err) {
        console.error('PDF render error:', err);
        document.getElementById('loading').style.display = 'none';
        document.getElementById('error').style.display = 'block';
      }
    }
    
    renderPDF();
  </script>
</body>
</html>`;
}


/**
 * Generates HTML with embedded mammoth.js for rendering DOCX files
 * mammoth.js works reliably in WebView and converts DOCX to clean HTML
 */
export function generateDocxHtml(base64Data: string, isDark: boolean): string {
  const bgColor = isDark ? THEME.dark.background : THEME.light.background;
  const textColor = isDark ? THEME.dark.foreground : THEME.light.foreground;
  const destructiveColor = isDark ? THEME.dark.destructive : THEME.light.destructive;
  const borderColor = isDark ? THEME.dark.border : THEME.light.border;
  const mutedBgColor = isDark ? THEME.dark.muted : THEME.light.muted;
  const mutedForegroundColor = isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground;
  const zebraStripeColor = withAlpha(isDark ? THEME.dark.foreground : THEME.light.foreground, isDark ? 0.03 : 0.02);

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=3.0, user-scalable=yes">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body {
      width: 100%;
      min-height: 100%;
      background: ${bgColor};
      color: ${textColor};
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      font-size: 15px;
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
    }
    #loading {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      text-align: center;
      font-size: 14px;
    }
    #error {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      text-align: center;
      color: ${destructiveColor};
      display: none;
      padding: 20px;
    }
    #container {
      padding: 20px;
      max-width: 100%;
    }
    /* Document styling to match Word appearance */
    #container h1 {
      font-size: 2em;
      font-weight: bold;
      margin: 0.67em 0;
      color: ${textColor};
    }
    #container h2 {
      font-size: 1.5em;
      font-weight: bold;
      margin: 0.83em 0;
      color: ${textColor};
    }
    #container h3 {
      font-size: 1.17em;
      font-weight: bold;
      margin: 1em 0;
      color: ${textColor};
    }
    #container h4 {
      font-size: 1em;
      font-weight: bold;
      margin: 1.33em 0;
      color: ${textColor};
    }
    #container p {
      margin: 1em 0;
    }
    #container ul, #container ol {
      margin: 1em 0;
      padding-left: 2em;
    }
    #container li {
      margin: 0.5em 0;
    }
    #container table {
      border-collapse: collapse;
      margin: 1em 0;
      width: 100%;
      font-size: 14px;
    }
    #container th, #container td {
      border: 1px solid ${borderColor};
      padding: 10px 12px;
      text-align: left;
      vertical-align: top;
    }
    #container th {
      background: ${mutedBgColor};
      font-weight: 600;
    }
    #container tr:nth-child(even) {
      background: ${zebraStripeColor};
    }
    #container img {
      max-width: 100%;
      height: auto;
      margin: 1em 0;
    }
    #container a {
      color: ${THEME.accent.blue};
      text-decoration: underline;
    }
    #container blockquote {
      border-left: 4px solid ${borderColor};
      padding-left: 1em;
      margin: 1em 0;
      color: ${mutedForegroundColor};
      font-style: italic;
    }
    #container strong, #container b {
      font-weight: 600;
    }
    #container em, #container i {
      font-style: italic;
    }
    #container u {
      text-decoration: underline;
    }
    #container code {
      background: ${mutedBgColor};
      padding: 2px 6px;
      border-radius: 4px;
      font-family: ui-monospace, monospace;
      font-size: 0.9em;
    }
    #container pre {
      background: ${mutedBgColor};
      padding: 12px;
      border-radius: 6px;
      overflow-x: auto;
      margin: 1em 0;
    }
    #container hr {
      border: none;
      border-top: 1px solid ${borderColor};
      margin: 2em 0;
    }
  </style>
</head>
<body>
  <div id="loading">Loading document...</div>
  <div id="error">Failed to load document</div>
  <div id="container"></div>
  <script>
    ${HTML_SANITIZER_SCRIPT}

    async function renderDocx() {
      try {
        const base64 = '${base64Data}';
        const binaryString = atob(base64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }

        const result = await mammoth.convertToHtml(
          { arrayBuffer: bytes.buffer },
          {
            styleMap: [
              "p[style-name='Heading 1'] => h1:fresh",
              "p[style-name='Heading 2'] => h2:fresh",
              "p[style-name='Heading 3'] => h3:fresh",
              "p[style-name='Heading 4'] => h4:fresh",
              "r[style-name='Strong'] => strong",
              "r[style-name='Emphasis'] => em",
            ]
          }
        );

        // Parse into an inert document, sanitize, then move the nodes into the
        // page. Nothing from the file runs or loads before sanitizing.
        const parsed = new DOMParser().parseFromString(result.value, 'text/html');
        sanitizeUntrustedHtml(parsed.body);
        const container = document.getElementById('container');
        while (parsed.body.firstChild) {
          container.appendChild(document.adoptNode(parsed.body.firstChild));
        }
        document.getElementById('loading').style.display = 'none';
      } catch (err) {
        console.error('DOCX render error:', err);
        document.getElementById('loading').style.display = 'none';
        document.getElementById('error').style.display = 'block';
        document.getElementById('error').textContent = 'Failed to load document: ' + (err.message || err);
      }
    }

    // Wait for mammoth to load
    if (typeof mammoth !== 'undefined') {
      renderDocx();
    } else {
      document.getElementById('loading').textContent = 'Loading library...';
      window.onload = function() {
        if (typeof mammoth !== 'undefined') {
          renderDocx();
        } else {
          document.getElementById('loading').style.display = 'none';
          document.getElementById('error').style.display = 'block';
          document.getElementById('error').textContent = 'Failed to load document library';
        }
      };
    }
  </script>
</body>
</html>`;
}
