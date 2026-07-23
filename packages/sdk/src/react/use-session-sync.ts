"use client";

import type {
	Message,
	Part,
	SessionStatus,
	Todo,
} from "@opencode-ai/sdk/v2/client";
import { useEffect, useSyncExternalStore } from "react";
import {
	getSessionSyncController,
	loadSessionTranscriptMessages,
	retainSessionSyncController,
} from "../browser/session-sync/session-sync-registry";
import { useSandboxConnectionStore } from "../browser/stores/sandbox-connection-store";
import {
	type MessageWithParts,
	useSyncStore,
} from "../browser/stores/sync-store";
import { canQueryOpenCodeSession } from "./use-opencode-sessions";

export { loadSessionTranscriptMessages };

type FileDiff = Omit<
	import("@opencode-ai/sdk/v2/client").SnapshotFileDiff,
	"patch"
> & {
	patch?: string;
	before?: string;
	after?: string;
};

const EMPTY_MESSAGES: MessageWithParts[] = [];
const EMPTY_DIFFS: FileDiff[] = [];
const EMPTY_TODOS: Todo[] = [];
const IDLE_STATUS = { type: "idle" } as SessionStatus;
const MESSAGE_CACHE_MAX = 20;

const messageCache = new Map<
	string,
	{
		msgs: Message[] | undefined;
		partRefs: (Part[] | undefined)[];
		result: MessageWithParts[];
	}
>();

function touchMessageCache(sessionId: string) {
	const entry = messageCache.get(sessionId);
	if (entry) {
		messageCache.delete(sessionId);
		messageCache.set(sessionId, entry);
	}
	if (messageCache.size > MESSAGE_CACHE_MAX) {
		const oldest = messageCache.keys().next().value;
		if (oldest) messageCache.delete(oldest);
	}
}

function buildMessages(
	sessionId: string,
	msgs: Message[] | undefined,
	parts: Record<string, Part[]>,
): MessageWithParts[] {
	if (!msgs || msgs.length === 0) return EMPTY_MESSAGES;
	const cached = messageCache.get(sessionId);
	if (cached && cached.msgs === msgs) {
		const same =
			cached.partRefs.length === msgs.length &&
			msgs.every((message, index) =>
				Object.is(parts[message.id], cached.partRefs[index]),
			);
		if (same) return cached.result;
	}

	const partRefs = msgs.map((message) => parts[message.id]);
	const result = msgs.map((info) => ({
		info,
		parts: parts[info.id] ?? [],
	}));
	messageCache.set(sessionId, { msgs, partRefs, result });
	touchMessageCache(sessionId);
	return result;
}

/**
 * Returns the current session tail and explicit history-loading state.
 * Network synchronization lives in the framework-free SessionSyncController.
 */
export function useSessionSync(sessionId: string) {
	const runtimeHealthy = useSandboxConnectionStore((state) =>
		state.healthy === true,
	);
	const controller = getSessionSyncController(sessionId);
	const sync = useSyncExternalStore(
		controller.subscribe,
		controller.getSnapshot,
		controller.getSnapshot,
	);

	useEffect(() => {
		if (!canQueryOpenCodeSession(sessionId) || !runtimeHealthy) return;
		const release = retainSessionSyncController(sessionId);
		void controller.start();
		return () => {
			release();
			messageCache.delete(sessionId);
		};
	}, [controller, runtimeHealthy, sessionId]);

	const messages = useSyncStore((state) =>
		buildMessages(sessionId, state.messages[sessionId], state.parts),
	);
	const status = useSyncStore(
		(state) => state.sessionStatus[sessionId] ?? IDLE_STATUS,
	) as SessionStatus;
	const diffs = useSyncStore((state) => state.diffs[sessionId]) as
		| FileDiff[]
		| undefined;
	const todos = useSyncStore((state) => state.todos[sessionId]) as
		| Todo[]
		| undefined;
	const isBusy = status.type === "busy" || status.type === "retry";
	const isLoading = !useSyncStore(
		(state) => sessionId in state.messages,
	);

	useEffect(() => {
		controller.setBusy(runtimeHealthy && isBusy);
	}, [controller, isBusy, runtimeHealthy]);

	return {
		messages,
		status,
		freshness: sync.freshness,
		isBusy,
		isLoading,
		hasOlder: sync.hasOlder,
		isLoadingOlder: sync.isLoadingOlder,
		loadOlder: controller.loadOlder,
		diffs: diffs ?? EMPTY_DIFFS,
		todos: todos ?? EMPTY_TODOS,
	};
}
