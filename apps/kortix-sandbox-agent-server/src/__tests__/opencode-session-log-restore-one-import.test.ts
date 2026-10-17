// The OpenCode session-log restore against the oracle: see helpers/opencode-restore.ts.
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type SessionLog } from '@kortix/api-contract/session-log'
import { Database } from 'bun:sqlite'
import { restoreOpenCodeSessionLog, type OpenCodeRestoreTarget } from '@/harness/open-code/session-log-restore'
import { OPENCODE_VERSION } from './helpers/opencode-box'
import { useRestoreHarness, NAMES, blobs, bin, box, restoreAndCheck, load, prompts } from './helpers/opencode-restore'

useRestoreHarness()

describe('one import for every thread: the store equals one import per thread', () => {
  /** The restore's write before the single import: one `opencode import` per session file. */
  const importEach = async (target: OpenCodeRestoreTarget, files: Array<Record<string, any>>, dir: string) => {
    for (const [i, f] of files.entries()) {
      const path = join(dir, `each-${i}.json`)
      writeFileSync(path, JSON.stringify(f))
      const proc = Bun.spawn([target.bin, '--pure', 'import', path], { cwd: target.cwd, env: { ...target.env, OPENCODE_DB: target.dbPath }, stdout: 'pipe', stderr: 'pipe' })
      expect(await new Response(proc.stdout).text()).toContain(`Imported session: ${f.info.id}`)
    }
  }
  /** Every session, message and part row; write-time columns (`time_updated`, a part's `time_created`) left out, JSON parsed. */
  const rows = (dbPath: string) => {
    const db = new Database(dbPath, { readonly: true })
    try {
      const read = (sql: string, drop: string[]) =>
        (db.query(sql).all() as Array<Record<string, unknown>>).map((r) =>
          Object.fromEntries(Object.entries(r).filter(([k]) => !drop.includes(k)).map(([k, v]) => [k, typeof v === 'string' && /^[[{]/.test(v) ? JSON.parse(v) : v])),
        )
      return {
        sessions: read('SELECT * FROM session ORDER BY id', []),
        messages: read('SELECT * FROM message ORDER BY session_id, time_created, id', ['time_updated']),
        parts: read('SELECT * FROM part ORDER BY session_id, message_id, id', ['time_updated', 'time_created']),
        // Every other table keyed by session: its row count per session.
        keyed: Object.fromEntries(
          (db.query("SELECT m.name FROM sqlite_master m WHERE m.type = 'table' AND m.name NOT IN ('session', 'message', 'part') AND EXISTS (SELECT 1 FROM pragma_table_info(m.name) WHERE name = 'session_id')").all() as Array<{ name: string }>)
            .map(({ name }) => [name, db.query(`SELECT session_id, count(*) AS n FROM "${name}" GROUP BY session_id ORDER BY session_id`).all()]),
        ),
      }
    } finally {
      db.close()
    }
  }
  /** pi's log plus two clones of its sub-agent, each spawned by a clone of the spawning reply at the root's end: 4 threads. */
  const fourThreads = () => {
    const log = load('pi')
    const [root, child] = log.threads as [SessionLog['threads'][number], SessionLog['threads'][number]]
    const spawn = root.messages.find((m) => m.message_id === child.spawned_by!.message_id)!
    const ids = [child.thread_id, spawn.message_id, child.spawned_by!.call_id, ...child.messages.flatMap((m) => [m.message_id, ...m.blocks.flatMap((b) => ('call_id' in b && b.call_id ? [b.call_id] : []))])]
    const renamed = <T,>(v: T, k: number): T => {
      let json = JSON.stringify(v)
      for (const id of ids) json = json.replaceAll(`"${id}"`, `"${id}x${k}"`)
      return JSON.parse(json) as T
    }
    const top = Math.max(...root.messages.map((m) => m.seq))
    for (const k of [1, 2]) {
      root.messages.push({ ...renamed(spawn, k), seq: top + k })
      log.threads.push(renamed(child, k))
    }
    return log
  }
  async function compare(log: SessionLog, url?: string) {
    const b = box(log.session_id)
    const target = { bin, cwd: b.workspace, env: b.env, dbPath: b.dbPath, sessionId: log.session_id, statePath: b.statePath, readAttachment: async (ref: string) => blobs.get(ref) ?? null }
    if (url === 'serve') url = (await b.serve()).url
    const one = await restoreOpenCodeSessionLog(log, { ...target, url })
    const single = rows(b.dbPath)
    const other = await restoreOpenCodeSessionLog(log, target, {}, importEach)
    return { b, single, each: rows(b.dbPath), one, other }
  }

  for (const name of NAMES) {
    test(`${name}: the same session, message and part rows, and the same cursors`, async () => {
      const { single, each, one, other } = await compare(load(name))
      expect(single.sessions).toHaveLength(load(name).threads.length)
      expect(single).toEqual(each)
      // A native hash digests the part rows' write times: the cursors match up to the hash values.
      const shape = (r: typeof one) => ({ dropped: r.dropped, cursors: r.cursors.map((c) => ({ ...c, native_hashes: Object.keys(c.native_hashes) })) })
      expect(shape(one)).toEqual(shape(other))
    }, 60_000)
  }

  test('4 threads (three sub-agents) restored while OpenCode serves, its version from its health: equal rows; a moved or dropped thread fails the comparison', async () => {
    const log = fourThreads()
    const { b, single, each, one } = await compare(log, 'serve')
    expect(single.sessions).toHaveLength(4)
    expect(single.sessions.filter((s) => s.parent_id === null)).toHaveLength(1)
    expect(new Set(single.sessions.map((s) => s.version))).toEqual(new Set([OPENCODE_VERSION]))
    expect(single).toEqual(each)
    expect(one.cursors.map((c) => c.thread_id)).toEqual(log.threads.map((t) => t.thread_id))
    for (const t of log.threads) expect(single.messages.filter((m) => m.session_id === b.native(t.thread_id)).length, t.thread_id).toBeGreaterThan(0)
    // Negative controls: one message under another thread, or a thread gone, is a different store.
    const db = new Database(b.dbPath)
    const [root, , second] = log.threads.map((t) => b.native(t.thread_id))
    const moved = db.query('SELECT id FROM message WHERE session_id = ? LIMIT 1').get(second!) as { id: string }
    db.run('UPDATE message SET session_id = ? WHERE id = ?', [root!, moved.id])
    expect(rows(b.dbPath)).not.toEqual(each)
    db.run('UPDATE message SET session_id = ? WHERE id = ?', [second!, moved.id])
    expect(rows(b.dbPath)).toEqual(each)
    db.run('PRAGMA foreign_keys = ON')
    db.run('DELETE FROM session WHERE id = ?', [second!])
    db.close()
    expect(rows(b.dbPath)).not.toEqual(each)
  }, 90_000)

  test('a row left on the holding session fails the restore before the delete could cascade it; the store keeps no root', async () => {
    const log = load('opencode')
    const b = box(log.session_id)
    const target = { bin, cwd: b.workspace, env: b.env, dbPath: b.dbPath, sessionId: log.session_id, statePath: b.statePath }
    await restoreOpenCodeSessionLog(log, target)
    // The holding session's id (see importSessions); a trigger gives it a todo, a row the move does not know.
    const hold = `ses_${createHash('sha256').update(`hold\0${b.native(log.threads[0]!.thread_id)}`).digest('hex').slice(0, 26)}`
    const db = new Database(b.dbPath)
    db.run(`CREATE TRIGGER leftover AFTER INSERT ON session WHEN NEW.id = '${hold}' BEGIN INSERT INTO todo (session_id, content, status, priority, position, time_created, time_updated) VALUES (NEW.id, 'x', 'pending', 'low', 0, 0, 0); END`)
    db.close()
    await expect(restoreOpenCodeSessionLog(log, target)).rejects.toThrow('the restore left 1 row(s) of todo on the holding session')
    const after = rows(b.dbPath)
    expect(after.sessions.map((s) => s.id)).toEqual([hold])
    expect(new Set(after.messages.map((m) => m.session_id))).toEqual(new Set([hold]))
    expect(after.keyed.todo).toEqual([{ session_id: hold, n: 1 }])
  }, 60_000)

  test('4 threads: the next request of every thread equals modelView', async () => {
    const log = fourThreads()
    const base = prompts('pi')
    const texts = Object.fromEntries(log.threads.map((t, i) => [t.thread_id, base[t.thread_id] ?? `continue thread ${i}`]))
    const { out } = await restoreAndCheck(log, texts)
    expect(Object.keys(out).sort()).toEqual(log.threads.map((t) => t.thread_id).sort())
    for (const [thread, check] of Object.entries(out)) expect(check.diffs, thread).toEqual([])
  }, 120_000)
})
