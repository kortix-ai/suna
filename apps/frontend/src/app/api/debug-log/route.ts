import { NextRequest, NextResponse } from 'next/server';

// ANSI color codes for terminal
const colors = {
  reset: '\x1b[0m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  magenta: '\x1b[35m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
};

// Color mapping for different log tags
const tagColors: Record<string, string> = {
  'useThreadData': colors.cyan,
  'handleNewMessageFromStream': colors.yellow,
  'baseGroups': colors.green,
  'renderedMessages': colors.magenta,
  'streamingContent': colors.red,
  'reasoningSection': colors.cyan,
};

function formatValue(value: unknown, indent = 0): string {
  const pad = '  '.repeat(indent);

  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (value.length <= 5 && value.every(v => typeof v !== 'object' || v === null)) {
      return `[${value.map(v => formatValue(v)).join(', ')}]`;
    }
    const items = value.map(v => `${pad}  ${formatValue(v, indent + 1)}`).join('\n');
    return `[\n${items}\n${pad}]`;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return '{}';

    // Compact format for small objects
    if (entries.length <= 3 && entries.every(([, v]) => typeof v !== 'object' || v === null)) {
      return `{ ${entries.map(([k, v]) => `${k}: ${formatValue(v)}`).join(', ')} }`;
    }

    const items = entries.map(([k, v]) => `${pad}  ${k}: ${formatValue(v, indent + 1)}`).join('\n');
    return `{\n${items}\n${pad}}`;
  }

  return String(value);
}

export async function POST(request: NextRequest) {
  // Only allow in development
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json({ error: 'Not available in production' }, { status: 403 });
  }

  try {
    const { logs } = await request.json();

    if (!Array.isArray(logs)) {
      return NextResponse.json({ error: 'Invalid logs format' }, { status: 400 });
    }

    for (const log of logs) {
      const { tag, data, timestamp } = log;
      const time = new Date(timestamp).toISOString().split('T')[1].slice(0, -1);
      const color = tagColors[tag.split(' ')[0].replace('[', '').replace(']', '')] || colors.cyan;

      // Format the log nicely for terminal
      console.log(`${colors.dim}${time}${colors.reset} ${color}${tag}${colors.reset}`);

      if (data && Object.keys(data).length > 0) {
        console.log(`${colors.dim}${formatValue(data)}${colors.reset}`);
      }
      console.log(''); // Empty line between logs
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Debug log error:', error);
    return NextResponse.json({ error: 'Failed to process logs' }, { status: 500 });
  }
}
