import { isMode, type Mode } from "./state"

export type Control =
	| { type: "set"; mode: Mode; rest: string }
	| { type: "clear"; rest: string }
	| { type: "compress"; path: string }
	| { type: "none" }

function trimLead(text: string) {
	return text.replace(/^[\s,:;.!-]+/, "").trim()
}

function splitArgs(args: string) {
	const text = args.trim()
	if (!text) return { head: "", rest: "" }
	const match = text.match(/^(\S+)(?:\s+([\s\S]*))?$/)
	return {
		head: match?.[1]?.trim().toLowerCase() ?? "",
		rest: match?.[2]?.trim() ?? "",
	}
}

export function parseSlash(text: string): Control {
	const trimmed = text.trim()
	const caveman = trimmed.match(/^\/caveman(?::caveman)?(?:\s+([\s\S]*))?$/i)
	if (caveman) {
		const { head, rest } = splitArgs(caveman[1] ?? "")
		if (!head) return { type: "set", mode: "full", rest: "" }
		if (["off", "stop", "normal", "normal-mode"].includes(head)) return { type: "clear", rest }
		if (head === "wenyan-full") return { type: "set", mode: "wenyan", rest }
		if (isMode(head)) return { type: "set", mode: head, rest }
		return { type: "set", mode: "full", rest: caveman[1]?.trim() ?? "" }
	}

	const compress = trimmed.match(/^\/caveman(?::compress|-compress)(?:\s+(.+))?$/i)
	if (compress?.[1]?.trim()) return { type: "compress", path: compress[1].trim() }
	return { type: "none" }
}

export function parseNatural(text: string): Control {
	const trimmed = text.trim()
	if (!trimmed) return { type: "none" }

	const stop = trimmed.match(/^(?:stop caveman|normal mode|talk normal(?:ly)?)([\s\S]*)$/i)
	if (stop) return { type: "clear", rest: trimLead(stop[1] ?? "") }

	const activate = trimmed.match(
		/^(?:talk like caveman|use caveman|caveman mode|less tokens(?: please)?|be brief)(?:\s+(lite|full|ultra|wenyan-lite|wenyan|wenyan-full|wenyan-ultra))?([\s\S]*)$/i,
	)
	if (activate) {
		const raw = (activate[1] ?? "full").toLowerCase()
		const mode = raw === "wenyan-full" ? "wenyan" : raw
		return { type: "set", mode: isMode(mode) ? mode : "full", rest: trimLead(activate[2] ?? "") }
	}

	return parseSlash(trimmed)
}
