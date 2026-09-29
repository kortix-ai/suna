import type { Part } from "@opencode-ai/sdk/v2/client";

import { Binary } from "./binary";

function isTextLikePart(part: Part): part is Extract<Part, { type: "text" | "reasoning" }> {
	return part.type === "text" || part.type === "reasoning";
}

/** Reconcile a transcript page's parts without changing the caller's message ordering. */
export function reconcileHydratedParts(
	msgs: Array<{ info: { id: string }; parts: Part[] }>,
	parts: Record<string, Part[]>,
	tracking: {
		isOptimistic: (id: string) => boolean;
		isBridged: (id: string) => boolean;
		clearBridge: (id: string) => void;
		isDeltaActive: (id: string) => boolean;
	},
): void {
	for (const m of msgs) {
		if (!m?.info?.id) continue;
		const mid = m.info.id;
		if (tracking.isOptimistic(mid)) continue;

		const inParts = m.parts
			.filter((p) => !!p?.id)
			.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
		if (tracking.isBridged(mid) && inParts.length > 0) {
			tracking.clearBridge(mid);
			parts[mid] = inParts;
			continue;
		}
		const exParts = parts[mid];
		if (!exParts || exParts.length === 0) {
			parts[mid] = inParts;
			continue;
		}
		const exById = new Map(exParts.map((p) => [p.id, p]));
		const inIds = new Set(inParts.map((p) => p.id));
		const extras = exParts.filter((p) => !inIds.has(p.id));
		const reconciled = inParts.map((inP) => {
			const exP = exById.get(inP.id);
			if (
				exP &&
				isTextLikePart(inP) &&
				isTextLikePart(exP) &&
				exP.text.length > inP.text.length
			) return exP;
			return inP;
		});
		const survivingExtras = extras.filter((extra) => {
			if (tracking.isDeltaActive(extra.id)) return true;
			if (!isTextLikePart(extra) || extra.text.length === 0) return true;
			return !inParts.some(
				(inP) =>
					inP.type === extra.type &&
					isTextLikePart(inP) &&
					inP.text.startsWith(extra.text),
			);
		});
		for (const ep of survivingExtras) {
			const r = Binary.search(reconciled, ep.id, (p) => p.id);
			if (!r.found) reconciled.splice(r.index, 0, ep);
		}
		parts[mid] = reconciled;
	}
}
