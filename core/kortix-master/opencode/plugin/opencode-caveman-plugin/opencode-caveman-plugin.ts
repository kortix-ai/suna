import { type Plugin, tool } from "@opencode-ai/plugin"
import { compressFile } from "./compress"
import { clearMode, clearSession, getMode, getSessionState, isMode, MODES, rememberAgent, setMode, type Mode } from "./state"

type CavemanOptions = {
	default_mode?: Mode
	agent_modes?: Record<string, Mode>
}

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

function resolveOptions(options?: CavemanOptions) {
	const defaultMode = options?.default_mode && isMode(options.default_mode) ? options.default_mode : null
	const agentModes = Object.fromEntries(
		Object.entries(options?.agent_modes ?? {}).filter(([, mode]) => isMode(mode)),
	) as Record<string, Mode>
	return { defaultMode, agentModes }
}

function defaultModeFor(agent: string | null | undefined, settings: ReturnType<typeof resolveOptions>) {
	if (agent && settings.agentModes[agent]) return settings.agentModes[agent]
	return settings.defaultMode
}

function ensureDefaultMode(sessionID: string, agent: string | null | undefined, settings: ReturnType<typeof resolveOptions>) {
	const state = agent ? rememberAgent(sessionID, agent) : getSessionState(sessionID)
	if (state.disabled || state.mode) return state.mode
	const mode = defaultModeFor(agent ?? state.agent, settings)
	if (!mode) return null
	setMode(sessionID, mode)
	return mode
}

const CavemanPlugin: Plugin = async (_input, options?: CavemanOptions) => {
	const settings = resolveOptions(options)
	return {
		tool: {
			caveman_mode: tool({
				description: "Get or change persistent caveman response mode for the current session.",
				args: {
					action: tool.schema.string().describe("get, set, or clear"),
					mode: tool.schema.string().optional().describe(`Mode: ${MODES.join(", ")}`),
				},
				async execute(args, ctx) {
					const state = rememberAgent(ctx.sessionID, ctx.agent)
					if (args.action === "get") {
						const effectiveMode = state.disabled ? null : state.mode ?? defaultModeFor(state.agent ?? ctx.agent, settings)
						return JSON.stringify({
							session_id: ctx.sessionID,
							agent: state.agent ?? ctx.agent,
							mode: state.mode,
							effective_mode: effectiveMode,
							disabled: state.disabled,
						}, null, 2)
					}
					if (args.action === "clear") {
						clearMode(ctx.sessionID)
						return JSON.stringify({ session_id: ctx.sessionID, mode: null, effective_mode: null, disabled: true }, null, 2)
					}
					if (args.action === "set") {
						if (!args.mode || !isMode(args.mode)) throw new Error(`Invalid mode. Use one of: ${MODES.join(", ")}`)
						return JSON.stringify({ session_id: ctx.sessionID, mode: setMode(ctx.sessionID, args.mode), effective_mode: args.mode, disabled: false }, null, 2)
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

		"chat.message": async (input: { sessionID: string; agent?: string }, _output: { parts: Array<any> }) => {
			if (input.agent) rememberAgent(input.sessionID, input.agent)
			ensureDefaultMode(input.sessionID, input.agent, settings)
		},

		"experimental.chat.system.transform": async (input: any, output: { system: string[] }) => {
			const sessionID = input?.sessionID
			if (!sessionID) return
			const state = getSessionState(sessionID)
			const mode = state.disabled ? null : getMode(sessionID) ?? defaultModeFor(state.agent, settings)
			if (!mode) return
			output.system.push(`${prompts[mode]}\n${guard}`)
		},

		event: async ({ event }: { event: any }) => {
			if (event?.type === "session.deleted") {
				const sessionID = event?.properties?.sessionID ?? event?.properties?.info?.id
				if (sessionID) clearSession(sessionID)
			}
		},
	}
}

export default CavemanPlugin
