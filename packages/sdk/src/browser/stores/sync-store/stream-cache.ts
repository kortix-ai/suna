export function writeStreamCache(
	sessionID: string,
	messageID: string,
	partID: string,
	text: string,
	parentID?: string,
) {
	if (typeof window === "undefined") return;
	if (!sessionID || !messageID || !partID || !text) return;
	const key = `runtime_stream_cache:${sessionID}`;
	try {
		const raw = sessionStorage.getItem(key);
		const prev = raw ? (JSON.parse(raw) as { messageID?: string; partID?: string; text?: string } | null) : null;
		if (
			prev &&
			prev.messageID === messageID &&
			prev.partID === partID &&
			typeof prev.text === "string" &&
			prev.text.length >= text.length
		) {
			return;
		}
		sessionStorage.setItem(
			key,
			JSON.stringify({
				messageID,
				parentID,
				partID,
				text,
				updatedAt: Date.now(),
			}),
		);
	} catch {
		// ignore storage issues
	}
}
