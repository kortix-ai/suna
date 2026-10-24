/**
 * Memory search (`GET /memory/search`) over files: the layers a person reads
 * (Company, every live channel, their own Memory folder), or the one layer
 * `layer` names. The newest 300 page files are read (cached by path and
 * mtime) and matched case-insensitively on title and body; title hits rank first.
 */
import type { MemoryPageType, MemorySearchHit, MemorySearchResult } from '@kortix/api-contract';
import { projectSpaces } from '@kortix/db';
import { spaceDriveFolders } from '@kortix/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { pathWithinFolder } from '../drives/folders';
import { db } from '../shared/db';
import { mapWithConcurrency } from '../shared/map-with-concurrency';
import { layerFiles, type PageFile, pageIdOf, parsePage, volumeOps } from './files';
import { type Layer, newestDmKey, type Project, resolveLayer, type Viewer } from './layers';

const SNIPPET_CHARS = 160;
const SNIPPET_LEAD = 40;
const READ_MAX = 300;
const CACHE_MAX = 1000;

/** About 160 characters of `body` around the first match of `q` (the whole query, else one of its words). */
export function snippetOf(body: string, q: string): string {
  const text = body.replace(/\s+/g, ' ').trim();
  const lower = text.toLowerCase();
  const terms = [q, ...q.split(/\s+/)]
    .map((term) => term.replace(/^[-"]+|"+$/g, '').trim().toLowerCase())
    .filter((term) => term.length >= 2 && term !== 'or');
  const at = terms.map((term) => lower.indexOf(term)).find((i) => i >= 0) ?? 0;
  const start = Math.max(0, at - SNIPPET_LEAD);
  const end = start + SNIPPET_CHARS;
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}

// replica-local: file texts by (drive, path, mtime, size); a changed file has a new key.
const texts = new Map<string, string>();

async function textOf(layer: Layer, file: PageFile): Promise<string> {
  const key = `${layer.drive.driveId}\n${file.path}\n${file.mtime}\n${file.size}`;
  const hit = texts.get(key);
  if (hit !== undefined) return hit;
  const text = (await volumeOps().read(layer.drive, file.path))?.text ?? '';
  texts.set(key, text);
  if (texts.size > CACHE_MAX) texts.delete(texts.keys().next().value!);
  return text;
}

/** Company, every live channel, and the viewer's Memory folder (as their newest DM, or the DM whose agent folder holds a file). */
async function peopleLayers(project: Project, viewer: Viewer): Promise<Layer[]> {
  const channels = await db
    .select({ spaceId: projectSpaces.spaceId })
    .from(projectSpaces)
    .where(and(eq(projectSpaces.projectId, project.projectId), eq(projectSpaces.kind, 'channel'), isNull(projectSpaces.archivedAt)));
  const dmKey = await newestDmKey(project.projectId, viewer.userId);
  const keys = ['company', ...channels.map((c) => c.spaceId), ...(dmKey ? [dmKey] : [])];
  const layers = await Promise.all(keys.map((key) => resolveLayer(project, key, viewer).catch(() => null)));
  return layers.filter((layer): layer is Layer => layer !== null);
}

export async function searchMemory(
  project: Project,
  viewer: Viewer,
  input: { q: string; layer?: string; type?: MemoryPageType; limit: number },
): Promise<MemorySearchResult> {
  const layers = input.layer ? [await resolveLayer(project, input.layer, viewer)] : await peopleLayers(project, viewer);
  // A DM layer here stands for the whole Memory folder: its files are read once, without the other agents' skip.
  const scoped = layers.map((layer) => (input.layer || layer.scope !== 'dm' ? layer : { ...layer, skip: [] }));
  const listed = await Promise.all(scoped.map(async (layer) => (await layerFiles(layer)).pages.map((file) => ({ layer, file }))));
  const files = listed.flat().sort((a, b) => b.file.mtime - a.file.mtime).slice(0, READ_MAX);
  const dmAgents = input.layer ? [] : await dmFolders(project.projectId, viewer.userId, scoped);
  const q = input.q.toLowerCase();
  const hits = (
    await mapWithConcurrency(files, 8, async ({ layer, file }) => {
      const agentLayer = layer.scope === 'dm' ? dmAgents.find((dm) => pathWithinFolder(file.path, dm.folder)) : undefined;
      const key = agentLayer?.key ?? layer.key;
      const rel = file.path.slice(layer.root.length + 1);
      const page = parsePage(await textOf(layer, file), rel, agentLayer ? agentLayer.folder.slice(layer.root.length + 1) : null);
      if (input.type && page.type !== input.type) return null;
      const inTitle = page.title.toLowerCase().includes(q);
      if (!inTitle && !page.body.toLowerCase().includes(q)) return null;
      const hit: MemorySearchHit = {
        page_id: pageIdOf(key, rel),
        layer_key: key,
        layer_name: agentLayer?.name ?? layer.name,
        scope: layer.scope,
        type: page.type,
        title: page.title,
        summary: page.summary,
        snippet: snippetOf(page.body, input.q),
        status: 'confirmed',
      };
      return { hit, inTitle };
    })
  ).filter((hit): hit is NonNullable<typeof hit> => hit !== null);
  hits.sort((a, b) => Number(b.inTitle) - Number(a.inTitle));
  return { hits: hits.slice(0, input.limit).map(({ hit }) => hit) };
}

/** The viewer's DM agent folders inside their Memory folder, as the DM layer key and name each belongs to. */
async function dmFolders(projectId: string, userId: string, layers: Layer[]): Promise<{ key: string; name: string; folder: string }[]> {
  const dm = layers.find((layer) => layer.scope === 'dm');
  if (!dm) return [];
  const personal = dm.root.slice(0, dm.root.lastIndexOf('/'));
  const rows = await db
    .select({ spaceId: projectSpaces.spaceId, agent: projectSpaces.dmAgentName })
    .from(projectSpaces)
    .where(and(eq(projectSpaces.projectId, projectId), eq(projectSpaces.kind, 'dm'), eq(projectSpaces.dmUserId, userId)));
  return rows.flatMap((row) => {
    const folder = row.agent ? spaceDriveFolders('dm', row.agent, personal)?.memory : null;
    return folder ? [{ key: row.spaceId, name: row.agent!, folder }] : [];
  });
}
