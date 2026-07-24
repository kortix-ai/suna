export interface ParsedObservationMemory {
  kind: 'observation';
  id: string;
  type: string;
  title: string;
  narrative: string;
  tool: string | null;
  prompt: string | null;
  session: string | null;
  created: string | null;
  facts: string[];
  concepts: string[];
  filesRead: string[];
}

export interface ParsedLtmMemory {
  kind: 'ltm';
  id: string;
  type: string;
  caption: string;
  content: string;
  session: string | null;
  created: string | null;
  updated: string | null;
  tags: string[];
}

export type ParsedMemoryEntry = ParsedObservationMemory | ParsedLtmMemory;

function parseObservationReport(text: string): ParsedObservationMemory | null {
  if (!text.includes('Observation #')) return null;

  const normalized = text.replace(/\r\n?/g, '\n').trim();
  const header = normalized.match(/===\s*Observation\s*#(\d+)\s*\[([^\]]+)\]\s*===\s*([\s\S]*)$/i);
  if (!header) return null;

  const [, id, type, remainderRaw] = header;
  const remainder = remainderRaw.trim();

  const compactField = (label: string): string => {
    const allLabels = [
      'Title:',
      'Narrative:',
      'Tool:',
      'Prompt #',
      'Session:',
      'Created:',
      'Facts:',
      'Concepts:',
      'Files read:',
    ].join('|');
    const re = new RegExp(`${label}\\s*([\\s\\S]*?)(?=\\s+(?:${allLabels})|$)`, 'i');
    return remainder.replace(/\n+/g, ' ').match(re)?.[1]?.trim() ?? '';
  };

  const title = compactField('Title:');
  const narrativeAndMeta = compactField('Narrative:');
  const factsAndMore = compactField('Facts:');
  const lines = narrativeAndMeta
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  let narrative = '';
  let tool: string | null = null;
  let prompt: string | null = null;
  let session: string | null = null;
  let created: string | null = null;

  for (const line of lines) {
    if (line.startsWith('Tool:')) {
      const inlineMeta = line
        .replace(/^Tool:\s*/i, '')
        .match(/^([^|]+?)\s*\|\s*Prompt\s*#([^\s]+)$/i);
      if (inlineMeta) {
        tool = inlineMeta[1].trim();
        prompt = inlineMeta[2].trim();
      } else {
        tool = line.replace(/^Tool:\s*/i, '').trim() || null;
      }
      continue;
    }
    if (line.startsWith('Prompt #')) {
      prompt = line.replace(/^Prompt\s*#/i, '').trim() || null;
      continue;
    }
    if (line.startsWith('Session:')) {
      session = line.replace(/^Session:\s*/i, '').trim() || null;
      continue;
    }
    if (line.startsWith('Created:')) {
      created = line.replace(/^Created:\s*/i, '').trim() || null;
      continue;
    }
    narrative = narrative ? `${narrative} ${line}` : line;
  }

  const facts: string[] = [];
  let concepts: string[] = [];
  let filesRead: string[] = [];

  for (const rawLine of factsAndMore.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('- ') || line.startsWith('• ')) {
      facts.push(line.slice(2).trim());
      continue;
    }
    if (line.startsWith('Concepts:')) {
      concepts = line
        .replace(/^Concepts:\s*/i, '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      continue;
    }
    if (line.startsWith('Files read:')) {
      filesRead = line
        .replace(/^Files read:\s*/i, '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    }
  }

  if (facts.length === 0 && factsAndMore.trim()) {
    facts.push(
      ...factsAndMore
        .split(/\s*[•-]\s+/)
        .map((item) => item.trim())
        .filter(Boolean),
    );
  }

  if (!tool) {
    const tokenTool = remainder.match(/Tool:\s*([A-Za-z0-9_./:-]+)/i)?.[1]?.trim();
    if (tokenTool) {
      tool = tokenTool;
    } else {
      const toolMatch = remainder.match(/Tool:\s*([\s\S]*?)(?=\s+\|\s*Prompt\s*#|\s+Prompt\s*#|\s+Session:|\s+Created:|\s+Concepts:|\s+Files read:|$)/i);
      tool = toolMatch?.[1]?.replace(/\bTool:\s*/gi, ' ').replace(/\s+/g, ' ').trim() || null;
    }
  }

  if (!prompt) {
    prompt = remainder.match(/Prompt\s*#([^\s|]+)/i)?.[1]?.trim() || null;
  }

  if (!session) {
    const sessionMatch = remainder.match(/Session:\s*([\s\S]*?)(?=\s+Created:|\s+Concepts:|\s+Files read:|$)/i);
    session = sessionMatch?.[1]?.trim() || null;
  }

  if (!created) {
    const createdMatch = remainder.match(/Created:\s*([\s\S]*?)(?=\s+Concepts:|\s+Files read:|$)/i);
    created = createdMatch?.[1]?.trim() || null;
  }

  if (concepts.length === 0) {
    const compactConcepts = remainder.match(/Concepts:\s*([\s\S]*?)(?=\s+Files read:|$)/i)?.[1] ?? '';
    concepts = compactConcepts
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  if (filesRead.length === 0) {
    const compactFiles = remainder.match(/Files read:\s*([\s\S]*?)$/i)?.[1] ?? '';
    filesRead = compactFiles
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  const hasUsefulBody =
    !!narrative ||
    !!tool ||
    !!prompt ||
    !!session ||
    !!created ||
    facts.length > 0 ||
    concepts.length > 0 ||
    filesRead.length > 0;

  if (!title.trim() || !hasUsefulBody) return null;

  return {
    kind: 'observation',
    id,
    type,
    title: title.trim(),
    narrative,
    tool,
    prompt,
    session,
    created,
    facts,
    concepts,
    filesRead,
  };
}

function parseLtmFields(body: string): Map<string, string> {
  const labels = ['Caption:', 'Content:', 'Session:', 'Created:', 'Tags:'];
  const lower = body.toLowerCase();
  const positions = labels
    .map((label) => ({ label, index: lower.indexOf(label.toLowerCase()) }))
    .filter((entry) => entry.index >= 0)
    .sort((a, b) => a.index - b.index);
  const fields = new Map<string, string>();
  for (let index = 0; index < positions.length; index += 1) {
    const current = positions[index]!;
    const next = positions[index + 1];
    const start = current.index + current.label.length;
    fields.set(current.label, body.slice(start, next?.index ?? body.length).trim());
  }
  return fields;
}

function parseLtmEntry(text: string): ParsedLtmMemory | null {
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  if (!normalized.includes('===') || !normalized.includes('LTM #')) return null;

  const upper = normalized.toUpperCase();
  const prefixIndex = upper.indexOf('LTM #');
  const typeStart = normalized.indexOf('[', prefixIndex + 5);
  const typeEnd = typeStart >= 0 ? normalized.indexOf(']', typeStart + 1) : -1;
  const headerEnd = typeEnd >= 0 ? normalized.indexOf('===', typeEnd + 1) : -1;
  if (prefixIndex < 0 || typeStart < 0 || typeEnd < 0 || headerEnd < 0) return null;
  const id = normalized.slice(prefixIndex + 5, typeStart).trim();
  const type = normalized.slice(typeStart + 1, typeEnd).trim();
  const body = normalized.slice(headerEnd + 3);
  const compactBody = body.replace(/\s+/g, ' ').trim();
  const fields = parseLtmFields(compactBody);
  const caption = fields.get('Caption:') ?? '';
  const content = fields.get('Content:') ?? '';
  const session = fields.get('Session:') || null;
  const createdAndUpdated = fields.get('Created:') ?? '';
  const created = createdAndUpdated.split('|')[0]?.trim() || null;
  let updated = createdAndUpdated.includes('|') ? createdAndUpdated.split('|')[1]?.trim() || null : null;
  while (updated?.toLowerCase().startsWith('updated:')) {
    updated = updated.slice('updated:'.length).trim() || null;
  }
  const tagsRaw = fields.get('Tags:') ?? '';
  const tags = tagsRaw
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);

  if (!id.trim() || !type.trim() || (!caption && !content)) return null;

  return {
    kind: 'ltm',
    id: id.trim(),
    type: type.trim(),
    caption,
    content,
    session,
    created,
    updated,
    tags,
  };
}

export function parseMemoryEntryOutput(text: string): ParsedMemoryEntry | null {
  return parseObservationReport(text) || parseLtmEntry(text);
}
