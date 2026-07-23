import type {
	Message,
	Part,
	SessionStatus,
} from "@opencode-ai/sdk/v2/client";
import { useSyncStore } from "../stores/sync-store";
import { getClient } from "../../core/runtime/client";
import {
	SessionSyncController,
	loadCompleteSessionHistory,
	type SessionSyncPage,
	type SessionSyncReason,
	type SessionSyncTelemetryEvent,
} from "../../core/session-sync/session-sync-controller";

interface MessagesResponse {
	data?: Array<{ info: Message; parts: Part[] }>;
	response?: Response;
}

interface SessionMessageClient {
	session: {
		messages: (request: {
			sessionID: string;
			limit: number;
			before?: string;
		}) => Promise<MessagesResponse>;
	};
}

interface RegistryEntry {
	controller: SessionSyncController;
	consumers: number;
	lastUsedAt: number;
}

const MAX_CONTROLLERS = 20;
const controllers = new Map<string, RegistryEntry>();

export async function readSessionMessagePage(
	client: SessionMessageClient,
	sessionId: string,
	request: { limit: number; before?: string },
): Promise<SessionSyncPage> {
	const result = await client.session.messages({
		sessionID: sessionId,
		limit: request.limit,
		...(request.before ? { before: request.before } : {}),
	});
	return {
		messages: result.data ?? [],
		nextCursor:
			result.response?.headers.get("x-next-cursor") || undefined,
	};
}

function reportTelemetry(
	sessionId: string,
	event: SessionSyncTelemetryEvent,
): void {
	console.debug("[session-sync]", { sessionId, ...event });
}

function createController(sessionId: string): SessionSyncController {
	return new SessionSyncController({
		sessionId,
		loadPage: (request) =>
			readSessionMessagePage(getClient(), sessionId, request),
		loadStatus: async () => {
			const result = await getClient().session.status();
			return (
				result.data?.[sessionId] ?? ({ type: "idle" } as SessionStatus)
			);
		},
		hydrate: (messages) => {
			useSyncStore.getState().hydrate(sessionId, messages);
		},
		markLoaded: () => {
			const state = useSyncStore.getState();
			if (!(sessionId in state.messages)) state.hydrate(sessionId, []);
		},
		setStatus: (status) =>
			useSyncStore.getState().setStatus(sessionId, status),
		onTelemetry: (event) => reportTelemetry(sessionId, event),
	});
}

function evictInactiveControllers(): void {
	if (controllers.size <= MAX_CONTROLLERS) return;
	const inactive = [...controllers.entries()]
		.filter(([, entry]) => entry.consumers === 0)
		.sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
	for (const [sessionId, entry] of inactive) {
		entry.controller.destroy();
		controllers.delete(sessionId);
		if (controllers.size <= MAX_CONTROLLERS) return;
	}
}

export function getSessionSyncController(
	sessionId: string,
): SessionSyncController {
	const existing = controllers.get(sessionId);
	if (existing) {
		existing.lastUsedAt = Date.now();
		return existing.controller;
	}
	const controller = createController(sessionId);
	controllers.set(sessionId, {
		controller,
		consumers: 0,
		lastUsedAt: Date.now(),
	});
	evictInactiveControllers();
	return controller;
}

export function retainSessionSyncController(sessionId: string): () => void {
	const controller = getSessionSyncController(sessionId);
	const entry = controllers.get(sessionId);
	if (!entry) return () => {};
	entry.consumers += 1;
	return () => {
		const current = controllers.get(sessionId);
		if (!current || current.controller !== controller) return;
		current.consumers = Math.max(0, current.consumers - 1);
		current.lastUsedAt = Date.now();
		if (current.consumers === 0) controller.setBusy(false);
	};
}

export function reconcileSessionTail(
	sessionId: string,
	reason: SessionSyncReason,
): Promise<void> {
	return getSessionSyncController(sessionId).reconcile(reason);
}

export function loadSessionTranscriptMessages(
	sessionId: string,
): Promise<SessionSyncPage["messages"]> {
	return loadCompleteSessionHistory((request) =>
		readSessionMessagePage(getClient(), sessionId, request),
	);
}

export function noteSessionSyncEvent(event: { properties: unknown }): void {
	const properties = event.properties as Record<string, unknown>;
	const info = properties.info as { sessionID?: string } | undefined;
	const part = properties.part as { sessionID?: string } | undefined;
	const sessionId =
		(typeof properties.sessionID === "string" && properties.sessionID) ||
		info?.sessionID ||
		part?.sessionID;
	if (!sessionId) return;
	controllers.get(sessionId)?.controller.noteActivity();
}

export function resetSessionSyncControllers(): void {
	for (const entry of controllers.values()) entry.controller.destroy();
	controllers.clear();
}
