// ============================================================================
// Ascending ID generator — server-compatible monotonic IDs
// ============================================================================

let lastTs = 0;
let counter = 0;
const chars62 =
	"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export function ascendingId(prefix: "msg" | "prt" = "msg"): string {
	const now = Date.now();
	if (now !== lastTs) {
		lastTs = now;
		counter = 0;
	}
	counter++;
	const encoded = BigInt(now) * BigInt(0x1000) + BigInt(counter);
	const hex = encoded.toString(16).padStart(12, "0").slice(0, 12);
	let rand = "";
	for (let i = 0; i < 14; i++) rand += chars62[Math.floor(Math.random() * 62)];
	return `${prefix}_${hex}${rand}`;
}
