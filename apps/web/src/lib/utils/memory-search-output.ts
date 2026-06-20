export type MemorySearchHitSource = 'ltm' | 'obs' | 'unknown';

export interface ParsedMemorySearchHit {
  id: string;
  type: string;
  source: MemorySearchHitSource;
  confidence: number | null;
  content: string;
  files: string[];
}

export interface ParsedMemorySearchOutput {
  matched: boolean;
  label: string;
  query: string;
  declaredResults: number | null;
  hits: ParsedMemorySearchHit[];
}

const EMPTY_RESULT: ParsedMemorySearchOutput = {
  matched: false,
  label: 'Memory Search',
  query: '',
  declaredResults: null,
  hits: [],
};

function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return String(value);
}

function parseSource(value: unknown): MemorySearchHitSource {
  const raw = asString(value).trim().toLowerCase();
  if (raw === 'ltm' || raw.includes('long') || raw.includes('semantic')) return 'ltm';
  if (raw === 'obs' || raw.includes('observation')) return 'obs';
  return 'unknown';
}

function parseArrayOutput(parsed: Record<string, unknown>): ParsedMemorySearchOutput | null {
  const listLike = (parsed.results ?? parsed.hits ?? parsed.memories) as unknown;
  if (!Array.isArray(listLike)) return null;

  const hits: ParsedMemorySearchHit[] = [];
  for (const item of listLike) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const idValue = row.id ?? row.memory_id ?? row.memoryId ?? row.key;
    const contentValue = row.content ?? row.text ?? row.caption ?? row.summary;
    const id = asString(idValue).trim();
    const content = asString(contentValue).trim();
    if (!id || !content) continue;

    const filesRaw = row.files ?? row.file_paths ?? row.filePaths;
    const files = Array.isArray(filesRaw)
      ? filesRaw.map((file) => asString(file).trim()).filter(Boolean)
      : [];

    const confidenceValue = row.confidence;
    const confidence =
      typeof confidenceValue === 'number'
        ? confidenceValue
        : typeof confidenceValue === 'string' && confidenceValue.trim()
          ? Number(confidenceValue)
          : null;

    hits.push({
      id,
      type: asString(row.type ?? row.kind ?? 'memory').trim() || 'memory',
      source: parseSource(row.source),
      confidence: Number.isFinite(confidence) ? confidence : null,
      content,
      files,
    });
  }

  const labelRaw = asString(parsed.label ?? parsed.title ?? '').trim();
  const sourceHint = parseSource(parsed.source);
  const label =
    labelRaw || (sourceHint === 'ltm' ? 'LTM Search' : sourceHint === 'obs' ? 'Observation Search' : 'Memory Search');
  const query = asString(parsed.query ?? parsed.search_query ?? parsed.searchQuery).trim();
  const declared = parsed.total ?? parsed.count ?? parsed.results_count;
  const declaredResults =
    typeof declared === 'number'
      ? declared
      : typeof declared === 'string' && declared.trim()
        ? Number(declared)
        : null;

  return {
    matched: true,
    label,
    query,
    declaredResults: Number.isFinite(declaredResults) ? declaredResults : null,
    hits,
  };
}

export function parseMemorySearchOutput(rawOutput: unknown): ParsedMemorySearchOutput {
  if (rawOutput && typeof rawOutput === 'object') {
    const parsedObject = parseArrayOutput(rawOutput as Record<string, unknown>);
    if (parsedObject) return parsedObject;
  }

  const output = asString(rawOutput);
  if (!output.trim()) return EMPTY_RESULT;

  let parsedJson: unknown = null;
  try {
    parsedJson = JSON.parse(output);
  } catch {
    parsedJson = null;
  }

  if (parsedJson && typeof parsedJson === 'object') {
    const parsedObject = parseArrayOutput(parsedJson as Record<string, unknown>);
    if (parsedObject) return parsedObject;
  }

  const normalized = output.replace(/\r\n?/g, '\n').trim();
  let label = 'Memory Search';
  let query = '';
  let declaredResults: number | null = null;
  let body = normalized;
  let matched = false;

  const headerMatch = normalized.match(
    /^===\s*([^:]+?Search):\s*"?([^"\n]*)"?\s*\((\d+)\s*results?\)\s*===\s*\n?/im,
  );
  if (headerMatch) {
    matched = true;
    label = headerMatch[1].trim();
    query = headerMatch[2].trim();
    declaredResults = Number(headerMatch[3]);
    body = normalized.slice((headerMatch.index ?? 0) + headerMatch[0].length).trim();
  }

  const hits: ParsedMemorySearchHit[] = [];

  const detailedBlockRe = /\[(LTM|obs)\/(\w+)\]\s*#([^\s]+)(?:\s*\(confidence:\s*([\d.]+)\))?\s*\n\s{2,}(.+?)(?:\n\s{2,}Files:\s*(.+?))?(?=\n\s*\[(?:LTM|obs)\/|$)/g;
  let detailMatch: RegExpExecArray | null = detailedBlockRe.exec(body);
  while (detailMatch) {
    matched = true;
    hits.push({
      source: detailMatch[1].toLowerCase() === 'ltm' ? 'ltm' : 'obs',
      type: detailMatch[2],
      id: detailMatch[3],
      confidence: detailMatch[4] ? Number(detailMatch[4]) : null,
      content: detailMatch[5].trim().replace(/\s+/g, ' '),
      files: detailMatch[6]
        ? detailMatch[6]
            .split(',')
            .map((file) => file.trim())
            .filter(Boolean)
        : [],
    });
    detailMatch = detailedBlockRe.exec(body);
  }

  if (hits.length === 0) {
    const compactRe = /#([^\s\]]+)\s*\[([^\]]+)\]\s*[\u2014-]\s*([\s\S]*?)(?=(?:\s+#([^\s\]]+)\s*\[)|$)/g;
    let compactMatch: RegExpExecArray | null = compactRe.exec(body);
    const inferredSource = parseSource(label);
    while (compactMatch) {
      matched = true;
      hits.push({
        source: inferredSource,
        type: compactMatch[2].trim(),
        id: compactMatch[1].trim(),
        confidence: null,
        content: compactMatch[3].replace(/\s+/g, ' ').trim(),
        files: [],
      });
      compactMatch = compactRe.exec(body);
    }
  }

  return {
    matched,
    label,
    query,
    declaredResults,
    hits,
  };
}
