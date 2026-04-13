import { dirname, extname, isAbsolute, join, parse, resolve } from "node:path"

const ALLOW = new Set(["", ".md", ".txt"])

function est(text: string) {
	return Math.max(1, Math.ceil(text.length / 4))
}

function guard(path: string) {
	const ext = extname(path).toLowerCase()
	if (!ALLOW.has(ext)) throw new Error(`Unsupported file type: ${ext || "(extensionless)"}`)
	if (path.endsWith(".original.md") || path.endsWith(".original.txt") || path.endsWith(".original")) {
		throw new Error("Refusing to compress backup file")
	}
}

function backup(path: string) {
	const info = parse(path)
	if (!info.ext) return join(info.dir, `${info.base}.original`)
	return join(info.dir, `${info.name}.original${info.ext}`)
}

function protect(input: string) {
	const parts: string[] = []
	const save = (value: string) => `__CAVEMAN_${parts.push(value) - 1}__`
	let text = input

	text = text.replace(/^---\n[\s\S]*?\n---\n?/, (value) => save(value))
	text = text.replace(/```[\s\S]*?```/g, (value) => save(value))
	text = text.replace(/`[^`\n]+`/g, (value) => save(value))
	text = text.replace(/\[[^\]]+\]\([^\)]+\)/g, (value) => save(value))
	text = text.replace(/https?:\/\/[^\s)]+/g, (value) => save(value))

	return {
		text,
		restore(value: string) {
			return value.replace(/__CAVEMAN_(\d+)__/g, (_, id) => parts[Number(id)] ?? _)
		},
	}
}

function crush(text: string) {
	let out = ` ${text} `
	const pairs: Array<[RegExp, string]> = [
		[/\bin order to\b/gi, "to"],
		[/\bmake sure to\b/gi, "ensure"],
		[/\bthe reason is because\b/gi, "because"],
		[/\bis responsible for\b/gi, "handles"],
		[/\byou should\b/gi, ""],
		[/\bplease\b/gi, ""],
		[/\bremember to\b/gi, ""],
		[/\bit is important to\b/gi, ""],
		[/\bit might be worth\b/gi, "consider"],
		[/\byou could consider\b/gi, "consider"],
		[/\bit would be good to\b/gi, ""],
	]
	for (const [pattern, next] of pairs) out = out.replace(pattern, next)
	out = out.replace(/\b(?:just|really|basically|actually|simply|essentially|generally|certainly|obviously|clearly|overall|very)\b/gi, "")
	out = out.replace(/\b(?:a|an|the)\b/g, "")
	out = out.replace(/\s+([,.;:!?])/g, "$1")
	out = out.replace(/\s{2,}/g, " ")
	return out.trim()
}

function line(text: string) {
	if (!text.trim()) return text
	if (/^\s*#{1,6}\s+/.test(text)) return text
	if (/^\s*[-:| ]+\s*$/.test(text)) return text

	const bullet = text.match(/^(\s*(?:[-*+] |\d+\. ))([\s\S]*)$/)
	if (bullet) return `${bullet[1]}${crush(bullet[2])}`

	if (text.includes("|") && !/^\s*\|?[-: ]+\|[-|: ]*\s*$/.test(text)) {
		return text
			.split("|")
			.map((part, idx, all) => (idx === 0 || idx === all.length - 1 ? part : ` ${crush(part)} `))
			.join("|")
	}

	return crush(text)
}

export async function compressFile(filePath: string, cwd: string) {
	const full = isAbsolute(filePath) ? filePath : resolve(cwd, filePath)
	guard(full)
	const original = await Bun.file(full).text()
	const frozen = protect(original)
	const next = frozen.restore(
		frozen.text
			.split("\n")
			.map(line)
			.join("\n")
			.replace(/\n{3,}/g, "\n\n"),
	)
	const bak = backup(full)
	await Bun.write(bak, original)
	await Bun.write(full, next)
	return {
		path: full,
		backup: bak,
		chars_before: original.length,
		chars_after: next.length,
		tokens_before: est(original),
		tokens_after: est(next),
		saved_percent: Math.max(0, Math.round((1 - next.length / Math.max(original.length, 1)) * 1000) / 10),
	}
}
