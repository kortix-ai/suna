// The workspace without a tool call: a repo map (every file, its line count, the first line of its header comment, the
// package scripts) and a BM25 index over declaration-sized chunks (a top-level declaration with the comment above it, a
// file's header comment, a markdown section). Measured on the real harness (16 workspace questions, research notes
// 2026-10-28): with the map and the best chunks injected, 0/16 turns ran tools and the first text came at 1.22 s p50,
// against 10/16 and 2.83 s with grep lines; answers as good or better. Built in ~60 ms, queried in <1 ms.
import { readdirSync, readFileSync, statSync } from 'node:fs'

type Chunk = { file: string; line: number; text: string; toks: string[]; syms: Set<string>; evaluation: boolean }
const STOP = new Set('the and you can what whats does did how who when where which that this there are was were for with about tell please could would right now just know want ask like okay hey yeah well into from out get got your our its his her their them they then than also some any much many more most very really sure think going have should only been will here show explain need actually thing things work works working handle handled handles codebase project inside exactly part kind mean able each other same make made code file files repo system real done use used using we'.split(' '))
const split = (s: string) => s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_\-./]/g, ' ').toLowerCase().match(/[a-z][a-z0-9]{1,}/g) ?? []
const stem = (w: string) => (w.length > 6 ? w.slice(0, 6) : w.length > 3 ? w.replace(/s$/, '') : w) // interrupt/interruption, backchannel(s)
const toks = (s: string) => split(s).filter((w) => !STOP.has(w)).map(stem)
const MAX_FILES = 2000
const EVALUATION_PATH = /(?:^|\/)(?:bench|tests?|__tests__|fixtures)(?:\/|$)|\.(?:test|spec)\.[^/]+$/
const EVALUATION_QUERY = /\b(?:bench\w*|tests?|testing|eval\w*|fixtures?|personas?|specs?)\b/i
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// What the project calls itself: its README's title and its root manifest's name (package.json, kortix.yaml's project,
// pyproject.toml, Cargo.toml, go.mod). Its folder's name is not that: a Kortix box's workspace is /workspace, a project
// there is agents, skills and memory, and "What is this project called?" was answered "security-tools", a sub-project
// named in a chunk. Line by line, no pattern over a whole file. '' when none says.
export function identity(root: string): string {
  const read = (f: string) => { try { return readFileSync(`${root}/${f}`, 'utf8').slice(0, 50_000) } catch { return '' } }
  const unquote = (v: string) => v.split(' #')[0]!.trim().replace(/^["']|["']$/g, '').trim()
  // The first `name` under a top-level key ("project:" in YAML, "[package]" in TOML).
  const under = (text: string, section: string, sep: string) => {
    let inside = false
    for (const l of text.split('\n')) {
      if (l.trim() === section) { inside = true; continue }
      if (inside && l && !/^\s/.test(l) && sep === ':') break
      if (inside && l.startsWith('[') && sep === '=') break
      const t = l.trim()
      if (inside && t.startsWith('name') && t.slice(4).trimStart().startsWith(sep)) return unquote(t.slice(4).trimStart().slice(1))
    }
    return ''
  }
  let name = ''
  try { const n = (JSON.parse(read('package.json') || '{}') as { name?: unknown }).name; if (typeof n === 'string') name = n } catch {}
  name ||= under(read('kortix.yaml'), 'project:', ':') || under(read('pyproject.toml'), '[project]', '=') || under(read('Cargo.toml'), '[package]', '=') ||
    (read('go.mod').split('\n').find((l) => l.startsWith('module ')) ?? '').slice(7).trim()
  const title = (read('README.md').split('\n').find((l) => l.startsWith('# ')) ?? '').slice(2).trim().slice(0, 80)
  return title && name && title.toLowerCase() !== name.toLowerCase() ? `${title} (${name})` : title || name
}

/** What the project says it is (kortix.yaml's project description, else package.json's) and the folders at its root
 * (a Kortix project's agents, skills and memory notes among them): the router's picture of what a workspace question
 * can be about, and the names of its memory notes (memory/*.md). '' for each when none. */
export function outline(root: string): { about: string; folders: string; notes: string } {
  const read = (f: string) => { try { return readFileSync(`${root}/${f}`, 'utf8').slice(0, 50_000) } catch { return '' } }
  let about = ''
  try { const d = (JSON.parse(read('package.json') || '{}') as { description?: unknown }).description; if (typeof d === 'string') about = d } catch {}
  if (!about) {
    let inside = false
    for (const l of read('kortix.yaml').split('\n')) {
      if (l.trim() === 'project:') { inside = true; continue }
      if (inside && l && !/^\s/.test(l)) break
      const t = l.trim()
      if (inside && t.startsWith('description:')) { about = t.slice(12).trim().replace(/^["']|["']$/g, ''); break }
    }
  }
  let folders = ''
  try {
    folders = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules').map((d) => d.name).sort().slice(0, 16).join(', ')
  } catch {}
  // A Kortix project's memory is notes in memory/ (team, infra, product, ...): their names tell a question on them.
  let notes = ''
  try { notes = readdirSync(`${root}/memory`).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md').map((f) => f.slice(0, -3)).sort().slice(0, 24).join(', ') } catch {}
  return { about: about.slice(0, 160), folders, notes }
}

function build(root: string) {
  const list = Bun.spawnSync(['rg', '--files', root]).stdout.toString().split('\n').filter(Boolean).map((f) => f.slice(root.length + 1)).sort().slice(0, MAX_FILES)
  const chunks: Chunk[] = []
  const lines = new Map<string, string[]>()
  for (const f of list) {
    if (!/\.(ts|tsx|js|jsx|py|go|rs|md|json|html)$/.test(f) || statSync(`${root}/${f}`).size > 400_000) continue
    const ls = readFileSync(`${root}/${f}`, 'utf8').split('\n')
    const evaluation = EVALUATION_PATH.test(f)
    lines.set(f, ls)
    // Chunk starts: the header comment on its own (the file's summary), each top-level declaration with the comment
    // above it, each markdown heading; long sections in 60-line windows.
    const starts = [0]
    if (!/\.(md|json|html)$/.test(f)) {
      let h = 0
      while (h < ls.length && /^\s*(\/\/|#)/.test(ls[h]!)) h++
      if (h > 0 && h < ls.length) starts.push(h)
      for (let i = h + 1; i < ls.length; i++)
        if (/^(export |async function|function |const |let |type |class |interface |def |func |fn |pub )/.test(ls[i]!)) {
          let s = i
          while (s > 0 && /^\s*(\/\/|#)/.test(ls[s - 1]!)) s--
          if (s > starts.at(-1)! + 2) starts.push(s)
        }
    } else if (f.endsWith('.md')) for (let i = 1; i < ls.length; i++) if (/^#{1,4} /.test(ls[i]!)) starts.push(i)
    starts.push(ls.length)
    for (let k = 0; k < starts.length - 1; k++)
      for (let a = starts[k]!; a < starts[k + 1]!; a += 60) {
        const text = ls.slice(a, Math.min(a + 60, starts[k + 1]!)).join('\n')
        if (text.trim()) chunks.push({ file: f, line: a + 1, text, toks: [...toks(f), ...toks(text)], syms: new Set([...text.matchAll(/^(?:export )?(?:async )?(?:function|const|let|type|class|interface|def|func|fn) (\w+)/gm)].flatMap((m) => toks(m[1]!))), evaluation })
      }
  }
  const N = chunks.length, avg = chunks.reduce((s, c) => s + c.toks.length, 0) / (N || 1)
  const df = new Map<string, number>()
  const tfs = chunks.map((c) => {
    const m = new Map<string, number>()
    for (const t of c.toks) m.set(t, (m.get(t) ?? 0) + 1)
    for (const t of m.keys()) df.set(t, (df.get(t) ?? 0) + 1)
    return m
  })
  const search = (q: string, k: number, boost: string[]) => {
    const qt = [...new Set(toks(q))]
    const evaluationRequested = EVALUATION_QUERY.test(q)
    const per = new Map<string, number>()
    return chunks
      .map((c, i) => {
        let s = 0
        for (const t of qt) {
          const tf = tfs[i]!.get(t) ?? 0
          if (!tf) continue
          const idf = Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5))
          s += (idf * tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (c.toks.length / avg)))
          if (c.syms.has(t)) s += 2 * idf // it declares what the question names (BACKCHANNEL for "backchannels")
        }
        if (boost.includes(c.file)) s *= 1.5
        if (c.file.endsWith('.md')) s *= 0.6 // prose about the code ranks under the code
        return { c, s }
      })
      // Caller scripts and expected answers are not evidence about the implementation.
      // Explicit file requests and questions about evaluation still search those sources.
      .filter((x) => x.s > 0 && (!x.c.evaluation || evaluationRequested || boost.includes(x.c.file)))
      .sort((a, b) => b.s - a.s)
      .filter((x) => (per.set(x.c.file, (per.get(x.c.file) ?? 0) + 1).get(x.c.file) ?? 0) <= 2)
      .slice(0, k)
      .map((x) => x.c)
  }
  // Escaped for the data envelope the map goes in: a README title cannot close it.
  const named = identity(root).replace(/"/g, "'").replace(/[<>]/g, '')
  const map = (named ? `Project: ${named}\n` : '') + list
    .slice(0, 300)
    .map((f) => {
      const t = lines.get(f)?.join('\n') ?? ''
      if (f === 'package.json') return `package.json scripts: ${Object.entries((JSON.parse(t || '{}') as { scripts?: Record<string, string> }).scripts ?? {}).map(([k, v]) => `${k} = ${v}`).join('; ')}`
      const n = lines.get(f)?.length ?? 0
      const head = (t.match(/^(?:(?:\/\/|#) ?(.*)\n?)+/)?.[0] ?? t.match(/^# (.*)$/m)?.[0] ?? '').split('\n').map((l) => l.replace(/^(\/\/|#) ?/, '')).join(' ').replace(/\s+/g, ' ').trim()
      return `${f}${n ? ` (${n} lines)` : ''}${head ? `: ${head.slice(0, 160)}` : ''}`
    })
    .join('\n')
  const stems = new Map(list.map((f) => [f.split('/').pop()!.replace(/\.\w+$/, '').toLowerCase(), f]))
  return { at: Date.now(), map, chunks, search, stems }
}

let built: ReturnType<typeof build> | undefined
// Rebuilt when 30 s old: the agent edits the workspace during a call.
const index = (root: string) => (built && Date.now() - built.at < 30_000 ? built : (built = build(root)))

/** The repo map, sent once a call (it then sits in the cached prefix; per turn only the chunks change). */
export const repoMap = (root: string) => index(root).map

// A file by its name ("cascade.ts"), or by its stem called a file ("the cascade file": the flow bench's "Read the first
// lines of it" got a chunk from the middle, the file never named the way the index knew it).
const spokenName = (q: string) => q.replace(/\bdot\s+([a-z])\s+([a-z])\b/gi, '.$1$2').replace(/\bdot\s+([a-z]{1,4})\b/gi, '.$1').replace(/\s*\.\s*/g, '.')
const filesNamed = (ix: ReturnType<typeof index>, spoken: string) => [...ix.stems.values()].filter((f) => {
  const base = f.split('/').pop()!
  const stem = base.replace(/\.\w+$/, '')
  return new RegExp(`\\b${escape(base)}\\b`, 'i').test(spoken) || (stem.length >= 3 && new RegExp(`\\b${escape(stem)}\\s+(file|module|script)\\b`, 'i').test(spoken))
})
/** The workspace's files these words name (by name, or by stem called a file), for the router to know the turn is theirs. */
export const namedFiles = (root: string, q: string) => filesNamed(index(root), spokenName(q))

/** Ranked workspace evidence; only an explicit filename, not an ordinary word, constrains the source. */
export function lookup(root: string, q: string, k = 3, budget = 3500): string {
  const ix = index(root)
  const spoken = spokenName(q)
  const named = filesNamed(ix, spoken)
  // Remove only the requested path/name; the remaining words rank its relevant declarations.
  const names = named.flatMap((f) => [escape(f), escape(f.split('/').pop()!)])
  const rest = names.length ? spoken.replace(new RegExp(`\\b(?:${names.join('|')})\\b`, 'gi'), ' ') : q
  const hits = named.length ? [...ix.chunks.filter((c) => named.includes(c.file) && c.line === 1), ...ix.search(rest, k + 2, named).filter((c) => named.includes(c.file))] : ix.search(q, k + 2, named)
  const seen = new Set<string>(), out: string[] = []
  let used = 0
  for (const c of hits) {
    if (seen.has(`${c.file}:${c.line}`) || out.length >= k) continue
    seen.add(`${c.file}:${c.line}`)
    const body = c.text.slice(0, Math.max(400, Math.min(1400, budget - used)))
    used += body.length
    out.push(`${c.file}:${c.line}\n${body}`)
  }
  return out.join('\n\n')
}
