import { readFileSync } from "node:fs"
import type { Message, Part, Session, ToolPart, ToolStateCompleted, ToolStateError } from "@opencode-ai/sdk"
import { Database } from "bun:sqlite"
import { getOpencodeDbPath, getOpencodeStorageBase } from "./opencode-storage-paths"

const S6_ENV_DIR = process.env.S6_ENV_DIR || "/run/s6/container_environment"

export function getEnv(key: string): string | undefined {
	const cached = process.env[key]
	if (cached) return cached
	try {
		const val = readFileSync(`${S6_ENV_DIR}/${key}`, "utf-8").trim()
		if (val) {
			process.env[key] = val
			return val
		}
	} catch {
		// not set
	}
	return undefined
}

export const STORAGE_BASE = getOpencodeStorageBase()
export const DB_PATH = getOpencodeDbPath()
const TTC_API_URL = "https://api.thetokencompany.com/v1/compress"
const TTC_MODEL = "bear-1.2"
const TOOL_INPUT_TRUNC = 200
const TOOL_OUTPUT_TRUNC = 2000

export function truncate(str: string, maxLen: number): string {
	if (str.length <= maxLen) return str
	const head = Math.floor(maxLen * 0.4)
	const tail = Math.floor(maxLen * 0.4)
	const omitted = str.length - head - tail
	return `${str.slice(0, head)}...[${omitted} chars omitted]...${str.slice(-tail)}`
}

export function shortTs(epochMs: number): string {
	return new Date(epochMs).toISOString().slice(0, 16).replace("T", " ")
}

export function changeSummary(s: Session): string {
	if (!s.summary) return "no file changes"
	return `${s.summary.files} files (+${s.summary.additions}, -${s.summary.deletions})`
}

export function formatMessages(messages: Array<{ info: Message; parts: Part[] }>): string {
	const lines: string[] = []
	for (const msg of messages) {
		const role = msg.info.role === "user" ? "USER" : "ASSISTANT"
		for (const part of msg.parts) {
			switch (part.type) {
				case "text": {
					if (part.synthetic || part.ignored) break
					lines.push(`${role}: ${part.text}`)
					break
				}
				case "tool": {
					const tp = part as ToolPart
					if (tp.state.status === "completed") {
						const st = tp.state as ToolStateCompleted
						const inp = truncate(JSON.stringify(st.input), TOOL_INPUT_TRUNC)
						const out = truncate(st.output, TOOL_OUTPUT_TRUNC)
						lines.push(`TOOL [${tp.tool}]: ${inp} → ${out}`)
					} else if (tp.state.status === "error") {
						const st = tp.state as ToolStateError
						lines.push(`TOOL [${tp.tool}] ERROR: ${truncate(st.error, 300)}`)
					}
					break
				}
			}
		}
	}
	return lines.join("\n\n")
}

export interface TtcResult {
	output: string
	originalTokens: number
	compressedTokens: number
}

export async function ttcCompress(text: string, aggressiveness: number, apiKey: string): Promise<TtcResult> {
	try {
		const res = await fetch(TTC_API_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({ model: TTC_MODEL, input: text, compression_settings: { aggressiveness } }),
		})
		if (!res.ok) {
			const body = await res.text().catch(() => "")
			console.error(`[session] TTC API error ${res.status}: ${body}`)
			return { output: text, originalTokens: 0, compressedTokens: 0 }
		}
		const data = (await res.json()) as { output: string; original_input_tokens: number; output_tokens: number }
		return { output: data.output, originalTokens: data.original_input_tokens, compressedTokens: data.output_tokens }
	} catch (err) {
		console.error(`[session] TTC compression failed: ${err}`)
		return { output: text, originalTokens: 0, compressedTokens: 0 }
	}
}

export interface SessionSearchResult {
	id: string
	title: string
	parentID: string | null
	timeCreated: number
	timeUpdated: number
	score: number
	reason: string
	snippet: string
}

function snippetFromJson(data: string, limit = 280): string {
	try {
		const parsed = JSON.parse(data) as Record<string, unknown>
		const pieces: string[] = []
		const walk = (prefix: string, value: unknown) => {
			if (typeof value === "string") {
				const clean = value.replace(/\s+/g, " ").trim()
				if (clean) pieces.push(prefix ? `${prefix}: ${clean}` : clean)
				return
			}
			if (typeof value === "number" || typeof value === "boolean") {
				pieces.push(prefix ? `${prefix}: ${String(value)}` : String(value))
				return
			}
			if (Array.isArray(value)) {
				for (const item of value.slice(0, 5)) walk(prefix, item)
				return
			}
			if (value && typeof value === "object") {
				for (const [k, v] of Object.entries(value).slice(0, 10)) walk(prefix ? `${prefix}.${k}` : k, v)
			}
		}
		walk("", parsed)
		const combined = pieces.join(" | ")
		return truncate(combined || data, limit)
	} catch {
		return truncate(data.replace(/\s+/g, " ").trim(), limit)
	}
}

export function searchSessions(query: string, limit = 5): SessionSearchResult[] {
	const q = query.trim()
	if (!q) return []
	const like = `%${q}%`
	const db = new Database(DB_PATH, { readonly: true })
	try {
		const hits = new Map<string, SessionSearchResult>()
		const upsert = (row: Record<string, unknown>, weight: number, reason: string, snippet: string) => {
			const id = String(row.id)
			const existing = hits.get(id)
			if (existing) {
				existing.score += weight
				const reasons = new Set(existing.reason.split(" + ").filter(Boolean))
				reasons.add(reason)
				existing.reason = [...reasons].join(" + ")
				if (!existing.snippet && snippet) existing.snippet = snippet
				return
			}
			hits.set(id, {
				id,
				title: String(row.title ?? "(untitled)"),
				parentID: row.parent_id ? String(row.parent_id) : null,
				timeCreated: Number(row.time_created ?? 0),
				timeUpdated: Number(row.time_updated ?? 0),
				score: weight,
				reason,
				snippet,
			})
		}
		const titleRows = db.query(`SELECT id, title, parent_id, time_created, time_updated FROM session WHERE title LIKE ? ORDER BY time_updated DESC LIMIT 50`).all(like) as Record<string, unknown>[]
		for (const row of titleRows) upsert(row, 5, "title", String(row.title ?? ""))
		const messageRows = db.query(`SELECT s.id, s.title, s.parent_id, s.time_created, s.time_updated, m.data AS data FROM message m JOIN session s ON s.id = m.session_id WHERE m.data LIKE ? ORDER BY m.time_created DESC LIMIT 100`).all(like) as Record<string, unknown>[]
		for (const row of messageRows) upsert(row, 3, "message", snippetFromJson(String(row.data ?? "")))
		const partRows = db.query(`SELECT s.id, s.title, s.parent_id, s.time_created, s.time_updated, p.data AS data FROM part p JOIN session s ON s.id = p.session_id WHERE p.data LIKE ? ORDER BY p.time_created DESC LIMIT 100`).all(like) as Record<string, unknown>[]
		for (const row of partRows) upsert(row, 1, "part", snippetFromJson(String(row.data ?? "")))
		return [...hits.values()].sort((a, b) => b.score - a.score || b.timeUpdated - a.timeUpdated).slice(0, limit)
	} finally {
		db.close()
	}
}

export function buildSessionLineage(sessions: Session[], targetID: string): string {
	const byId = new Map(sessions.map(s => [s.id, s]))
	const chain: Session[] = []
	let current = byId.get(targetID)
	while (current) {
		chain.unshift(current)
		current = current.parentID ? byId.get(current.parentID) : undefined
	}
	if (chain.length === 0) return `Session ${targetID} not found.`
	const lines = ["=== SESSION LINEAGE ==="]
	const root = chain[0]!
	lines.push(`Root: ${root.id} | \"${root.title}\"`)
	lines.push("")
	for (let i = 0; i < chain.length; i++) {
		const s = chain[i]!
		const indent = "  ".repeat(i)
		const marker = s.id === targetID ? " [target]" : ""
		lines.push(`${indent}${s.id} | ${shortTs(s.time.created)} | \"${s.title}\"${marker}`)
		if (i < chain.length - 1) lines.push(`${indent}  ->`)
	}
	const children = sessions.filter(s => s.parentID === targetID)
	if (children.length > 0) {
		lines.push("")
		lines.push("Children:")
		for (const child of children.sort((a, b) => a.time.created - b.time.created)) {
			lines.push(`  ${child.id} | ${shortTs(child.time.created)} | \"${child.title}\"`)
		}
	}
	return lines.join("\n")
}
