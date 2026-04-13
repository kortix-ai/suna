import { type Plugin, tool } from "@opencode-ai/plugin"
import { compressFile } from "./compress"
import { parseNatural } from "./parse"
import { clearMode, clearSession, getMode, isMode, MODES, setMode, type Mode } from "./state"

const prompts: Record<Mode, string> = {
	lite: [
		"CAVEMAN LITE ACTIVE.",
		"Be concise and professional.",
		"Drop filler, hedging, pleasantries.",
		"Keep full sentences when clarity helps.",
		"Keep technical accuracy exact.",
	].join("\n"),
	full: [
		"CAVEMAN FULL ACTIVE.",
		"Respond terse like smart caveman.",
		"Drop articles, filler, pleasantries, hedging.",
		"Fragments OK. Short synonyms. Technical terms exact.",
		"Pattern: [thing] [action] [reason]. [next step].",
	].join("\n"),
	ultra: [
		"CAVEMAN ULTRA ACTIVE.",
		"Maximum compression.",
		"Use fragments, abbreviations, arrows, one word when enough.",
		"Keep correctness. Never omit key technical detail.",
	].join("\n"),
	"wenyan-lite": [
		"WENYAN LITE ACTIVE.",
		"Use semi-classical Chinese register with clear grammar.",
		"Be terse, technical, exact.",
	].join("\n"),
	wenyan: [
		"WENYAN FULL ACTIVE.",
		"Use concise 文言文 style.",
		"Maximize terseness without losing technical meaning.",
	].join("\n"),
	"wenyan-ultra": [
		"WENYAN ULTRA ACTIVE.",
		"Extreme classical compression.",
		"Keep only essential technical content.",
	].join("\n"),
}

const guard = [
	"Drop caveman style for destructive confirmations, security warnings, or multi-step instructions where clarity matters more than brevity.",
	"Code blocks, commands, paths, URLs, quoted errors, and commit hashes stay exact.",
].join("\n")

function confirm(mode: Mode) {
	return `Caveman mode set to ${mode}. Confirm briefly.`
}

function disabled() {
	return "Caveman mode disabled. Reply normal. Confirm briefly."
}

function buildCompressPrompt(args: string) {
	const path = args.trim()
	if (!path) return "Use caveman_compress with file_path. Then report backup path and savings briefly."
	return [
		`Use caveman_compress on ${path}.`,
		"Then report backup path and savings in <=4 bullets.",
	].join(" ")
}

function maybeRewrite(text: string, sessionID: string) {
	const ctl = parseNatural(text)
	if (ctl.type === "none") return null
	if (ctl.type === "compress") return buildCompressPrompt(ctl.path)
	if (ctl.type === "clear") {
		clearMode(sessionID)
		return ctl.rest || disabled()
	}
	setMode(sessionID, ctl.mode)
	return ctl.rest || confirm(ctl.mode)
}

const CavemanPlugin: Plugin = async () => {
	return {
		tool: {
			caveman_mode: tool({
				description: "Get or change persistent caveman response mode for the current session.",
				args: {
					action: tool.schema.string().describe("get, set, or clear"),
					mode: tool.schema.string().optional().describe(`Mode: ${MODES.join(", ")}`),
				},
				async execute(args, ctx) {
					if (args.action === "get") return JSON.stringify({ session_id: ctx.sessionID, mode: getMode(ctx.sessionID) }, null, 2)
					if (args.action === "clear") {
						clearMode(ctx.sessionID)
						return JSON.stringify({ session_id: ctx.sessionID, mode: null }, null, 2)
					}
					if (args.action === "set") {
						if (!args.mode || !isMode(args.mode)) throw new Error(`Invalid mode. Use one of: ${MODES.join(", ")}`)
						return JSON.stringify({ session_id: ctx.sessionID, mode: setMode(ctx.sessionID, args.mode) }, null, 2)
					}
					throw new Error("Invalid action. Use get, set, or clear")
				},
			}),
			caveman_compress: tool({
				description: "Compress prose-heavy memory files into caveman style, backing up the original first.",
				args: {
					file_path: tool.schema.string().describe("Absolute or session-relative path to a .md, .txt, or extensionless prose file"),
				},
				async execute(args, ctx) {
					const result = await compressFile(args.file_path, ctx.directory)
					return JSON.stringify(result, null, 2)
				},
			}),
		},

		"chat.message": async (input: { sessionID: string }, output: { parts: Array<any> }) => {
			if (!Array.isArray(output.parts)) return
			if (output.parts.length !== 1) return
			const part = output.parts[0]
			if (part?.type !== "text" || typeof part.text !== "string") return
			const next = maybeRewrite(part.text, input.sessionID)
			if (!next) return
			part.text = next
		},

		"experimental.chat.system.transform": async (_input: any, output: { system: string[] }) => {
			const sessionID = _input?.sessionID
			if (!sessionID) return
			const mode = getMode(sessionID)
			if (!mode) return
			output.system.push(`${prompts[mode]}\n${guard}`)
		},

		event: async ({ event }: { event: any }) => {
			if (event?.type === "session.deleted") {
				const sessionID = event?.properties?.sessionID
				if (sessionID) clearSession(sessionID)
			}
		},
	}
}

export default CavemanPlugin
