#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$ROOT/dist"
cat > "$ROOT/dist/index.html" <<'HTML'
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Kortix</title>
    <style>
      html, body { margin: 0; height: 100%; background: #0a0a0a; color: #f4f4f5;
        font: 14px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
      .wrap { display: grid; place-items: center; height: 100%; }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor;
        display: inline-block; margin: 0 2px; opacity: 0.4;
        animation: pulse 1.2s infinite ease-in-out both; }
      .dot:nth-child(2) { animation-delay: 0.2s; }
      .dot:nth-child(3) { animation-delay: 0.4s; }
      @keyframes pulse { 0%, 80%, 100% { opacity: 0.2 } 40% { opacity: 1 } }
    </style>
  </head>
  <body>
    <div class="wrap"><div><span class="dot"></span><span class="dot"></span><span class="dot"></span></div></div>
  </body>
</html>
HTML
