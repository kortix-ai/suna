'use client';

import { use, useMemo, useState, useCallback } from 'react';
import { Loader2, AlertCircle, ChevronRight, History, GitFork, ArrowRightLeft } from 'lucide-react';
import { cn } from '@/lib/utils';
import { UnifiedMarkdown } from '@/components/markdown';
import { useLegacyMessages, useMigrateLegacyThread } from '@/hooks/legacy/use-legacy-threads';
import { useCreateOpenCodeSession } from '@/hooks/opencode/use-opencode-sessions';
import { openTabAndNavigate } from '@/stores/tab-store';
import { useServerStore } from '@/stores/server-store';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from '@/components/ui/collapsible';

interface LegacyMsg {
	message_id: string;
	type: string;
	content: unknown;
	created_at: string;
}

interface ParsedTurn {
	id: string;
	userText: string;
	assistantText: string;
	toolCalls: ParsedToolCall[];
}

interface ParsedToolCall {
	id: string;
	name: string;
	args: Record<string, unknown>;
	result: string;
}

const SKIPPED_TYPES = new Set(['status', 'llm_response_start', 'llm_response_end']);

function parseToolArgs(raw: string): Record<string, unknown> {
	try {
		return JSON.parse(raw);
	} catch {
		return { raw };
	}
}

function parseTurns(messages: LegacyMsg[]): ParsedTurn[] {
	const visible = messages.filter((m) => !SKIPPED_TYPES.has(m.type));
	const turns: ParsedTurn[] = [];
	const toolResults = new Map<string, string>();

	for (const msg of visible) {
		if (msg.type === 'tool') {
			const c = msg.content as any;
			if (c?.tool_call_id) {
				toolResults.set(c.tool_call_id, c.content || '');
			}
		}
	}

	let currentTurn: ParsedTurn | null = null;

	for (const msg of visible) {
		if (msg.type === 'user' || msg.type === 'image_context') {
			if (currentTurn) turns.push(currentTurn);
			currentTurn = {
				id: msg.message_id,
				userText: extractUserText(msg),
				assistantText: '',
				toolCalls: [],
			};
		}

		if (msg.type === 'assistant' && currentTurn) {
			const c = msg.content as any;
			if (c?.content) {
				currentTurn.assistantText += (currentTurn.assistantText ? '\n\n' : '') + c.content;
			}
			if (c?.tool_calls) {
				for (const tc of c.tool_calls) {
					currentTurn.toolCalls.push({
						id: tc.id,
						name: tc.function?.name || 'unknown',
						args: parseToolArgs(tc.function?.arguments || '{}'),
						result: toolResults.get(tc.id) || '',
					});
				}
			}
		}

		if (msg.type === 'reasoning' && currentTurn) {
			const c = msg.content as any;
			const reasoning = c?.reasoning_content;
			if (reasoning) {
				currentTurn.assistantText += (currentTurn.assistantText ? '\n\n' : '') + reasoning;
			}
		}
	}

	if (currentTurn) turns.push(currentTurn);
	return turns;
}

function extractUserText(msg: LegacyMsg): string {
	const content = msg.content as any;
	if (typeof content === 'string') return content;

	if (msg.type === 'image_context' && Array.isArray(content?.content)) {
		return content.content
			.filter((b: any) => b.type === 'text' && b.text)
			.map((b: any) => b.text)
			.join('\n') || '[Image]';
	}

	if (typeof content?.content === 'string') return content.content;
	return '';
}

function buildContextPrompt(turns: ParsedTurn[], upToIndex: number): string {
	const relevant = turns.slice(0, upToIndex + 1);
	const context = relevant.slice(-6);
	const lines: string[] = [
		'Continue from this previous conversation:\n',
	];

	for (const turn of context) {
		if (turn.userText) {
			lines.push(`**User:** ${turn.userText.slice(0, 500)}`);
		}
		if (turn.assistantText) {
			lines.push(`**Assistant:** ${turn.assistantText.slice(0, 500)}`);
		}
		if (turn.toolCalls.length > 0) {
			const toolNames = turn.toolCalls.map((tc) => tc.name).join(', ');
			lines.push(`*Tools used: ${toolNames}*`);
		}
		lines.push('');
	}

	lines.push('---\nPlease continue where we left off.');
	return lines.join('\n');
}

function toolIcon(name: string) {
	const iconMap: Record<string, string> = {
		computer: '🖥️',
		bash: '⌨️',
		browser: '🌐',
		edit_file: '✏️',
		create_file: '📄',
		read_file: '📖',
		list_directory: '📁',
		search: '🔍',
		grep_search: '🔍',
		find_files: '🔍',
		ask_human: '💬',
	};
	return iconMap[name] || '🔧';
}

function formatToolSubtitle(name: string, args: Record<string, unknown>): string {
	if (args.command && typeof args.command === 'string') {
		return args.command.length > 80 ? args.command.slice(0, 80) + '…' : args.command;
	}
	if (args.path && typeof args.path === 'string') {
		return args.path;
	}
	if (args.query && typeof args.query === 'string') {
		return args.query;
	}
	if (args.url && typeof args.url === 'string') {
		return args.url;
	}
	return '';
}

function LegacyToolCard({ tool }: { tool: ParsedToolCall }) {
	const subtitle = formatToolSubtitle(tool.name, tool.args);

	return (
		<Collapsible>
			<CollapsibleTrigger asChild>
				<div
					className={cn(
						'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg',
						'bg-muted/20 border border-border/40',
						'text-xs transition-colors select-none',
						'cursor-pointer hover:bg-muted/40',
						'max-w-full group',
					)}
				>
					<span className="flex-shrink-0 text-xs">{toolIcon(tool.name)}</span>
					<span className="font-medium text-xs text-foreground whitespace-nowrap">
						{tool.name}
					</span>
					{subtitle && (
						<span className="text-muted-foreground text-xs truncate font-mono">
							{subtitle}
						</span>
					)}
					<ChevronRight className="size-3 text-muted-foreground ml-auto flex-shrink-0 transition-transform group-data-[state=open]:rotate-90" />
				</div>
			</CollapsibleTrigger>
			<CollapsibleContent>
				<div className="mt-1 rounded-lg border border-border/40 bg-muted/10 overflow-hidden">
					{tool.result && (
						<div className="p-3 text-xs font-mono whitespace-pre-wrap break-all text-muted-foreground max-h-[300px] overflow-y-auto">
							{tool.result.length > 2000
								? tool.result.slice(0, 2000) + '\n… (truncated)'
								: tool.result}
						</div>
					)}
					{!tool.result && (
						<div className="p-3 text-xs text-muted-foreground/50 italic">
							No output
						</div>
					)}
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
}

function LegacyTurn({
	turn,
	onFork,
	forking,
}: {
	turn: ParsedTurn;
	onFork: () => void;
	forking: boolean;
}) {
	return (
		<div className="space-y-3 group/turn relative">
			{turn.userText && (
				<div className="flex flex-col items-end">
					<div className="flex flex-col max-w-[90%] rounded-3xl rounded-br-lg bg-card border overflow-hidden">
						<div className="px-4 py-3">
							<div className="text-sm leading-relaxed whitespace-pre-wrap break-words">
								{turn.userText}
							</div>
						</div>
					</div>
				</div>
			)}

			{(turn.assistantText || turn.toolCalls.length > 0) && (
				<>
					<div className="flex items-center gap-2 mt-3">
						{/* eslint-disable-next-line @next/next/no-img-element */}
						<img
							src="/kortix-logomark-white.svg"
							alt="Kortix"
							className="dark:invert-0 invert flex-shrink-0"
							style={{ height: '14px', width: 'auto' }}
						/>
					</div>

					{turn.toolCalls.length > 0 && (
						<div className="space-y-1.5">
							{turn.toolCalls.map((tc) => (
								<LegacyToolCard key={tc.id} tool={tc} />
							))}
						</div>
					)}

					{turn.assistantText && (
						<div className="text-sm">
							<UnifiedMarkdown content={turn.assistantText} />
						</div>
					)}

					<div className="flex justify-start mt-1 opacity-0 group-hover/turn:opacity-100 transition-opacity duration-150">
						<Tooltip>
							<TooltipTrigger asChild>
								<button
									onClick={onFork}
									disabled={forking}
									className="p-1.5 rounded-md text-muted-foreground/50 hover:text-foreground hover:bg-muted/60 transition-colors cursor-pointer disabled:opacity-30"
								>
									<GitFork className="size-3.5" />
								</button>
							</TooltipTrigger>
							<TooltipContent>Continue from here</TooltipContent>
						</Tooltip>
					</div>
				</>
			)}
		</div>
	);
}

export default function LegacyThreadPage({
	params,
}: {
	params: Promise<{ threadId: string }>;
}) {
	const { threadId } = use(params);
	const { data, isLoading, error } = useLegacyMessages(threadId);
	const createSession = useCreateOpenCodeSession();
	const migrate = useMigrateLegacyThread();
	const [forking, setForking] = useState(false);
	const [migrating, setMigrating] = useState(false);

	const turns = useMemo(
		() => parseTurns(data?.messages || []),
		[data?.messages],
	);

	const handleFork = useCallback(async (turnIndex: number) => {
		if (forking) return;
		setForking(true);
		try {
			const session = await createSession.mutateAsync();
			const prompt = buildContextPrompt(turns, turnIndex);

			sessionStorage.setItem(`opencode_pending_prompt:${session.id}`, prompt);

			openTabAndNavigate({
				id: session.id,
				title: 'Continued chat',
				type: 'session',
				href: `/sessions/${session.id}`,
				serverId: useServerStore.getState().activeServerId,
			});
		} catch {
			setForking(false);
		}
	}, [forking, turns, createSession]);

	const handleMigrate = useCallback(async () => {
		if (migrating) return;
		const server = useServerStore.getState();
		const active = server.servers.find((s) => s.id === server.activeServerId);
		if (!active?.sandboxId) return;

		setMigrating(true);
		try {
			const result = await migrate.mutateAsync({
				threadId,
				sandboxExternalId: active.sandboxId,
			});

			openTabAndNavigate({
				id: result.sessionId,
				title: 'Migrated session',
				type: 'session',
				href: `/sessions/${result.sessionId}`,
				serverId: server.activeServerId,
			});
		} catch {
			setMigrating(false);
		}
	}, [migrating, threadId, migrate]);

	if (isLoading) {
		return (
			<div className="flex-1 flex items-center justify-center">
				<Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
			</div>
		);
	}

	if (error) {
		return (
			<div className="flex-1 flex flex-col items-center justify-center text-center gap-3">
				<AlertCircle className="h-8 w-8 text-destructive" />
				<p className="text-sm text-muted-foreground">Failed to load messages</p>
			</div>
		);
	}

	return (
		<div className="flex flex-col h-full">
			<div className="flex items-center gap-2 px-5 py-3 border-b border-border/50">
				<History className="h-3.5 w-3.5 text-muted-foreground" />
				<span className="text-xs font-medium text-muted-foreground">Previous Chat</span>
				<span className="text-[10px] text-muted-foreground/60">·</span>
				<span className="text-[10px] text-muted-foreground/60">{turns.length} turns</span>
			</div>

			<div className="flex-1 overflow-y-auto">
				<div className="max-w-4xl mx-auto px-6 py-6 space-y-8">
					{turns.map((turn, i) => (
						<LegacyTurn
							key={turn.id}
							turn={turn}
							onFork={() => handleFork(i)}
							forking={forking}
						/>
					))}
				</div>
			</div>

			<div className="mx-auto w-full max-w-4xl relative shrink-0 px-2 sm:px-4 pb-6">
				<div className="w-full bg-card border border-border rounded-[24px] overflow-hidden relative">
					<div className="pointer-events-none select-none blur-[2px] opacity-40">
						<div className="px-4 pt-4 pb-6 min-h-[96px]">
							<span className="text-[15px] text-muted-foreground">What do you want to build?</span>
						</div>
						<div className="flex items-center justify-between mb-1.5 pl-2 pr-1.5">
							<div className="flex items-center gap-1">
								<div className="h-8 w-8 rounded-xl bg-muted/40" />
								<div className="w-px h-4 bg-border mx-1" />
								<div className="h-6 w-16 rounded-lg bg-muted/40" />
								<div className="h-6 w-20 rounded-lg bg-muted/40" />
							</div>
							<div className="h-8 w-8 rounded-full bg-muted/40" />
						</div>
					</div>
					<div className="absolute inset-0 flex flex-col items-center justify-center gap-3 rounded-[24px]">
						<p className="text-sm text-muted-foreground">This is a legacy chat. Convert it to continue.</p>
						<p className="text-xs text-muted-foreground/70 mt-1">Files will be imported to the Legacy folder on the Files page.</p>
						<button
							onClick={handleMigrate}
							disabled={forking || migrating || turns.length === 0}
							className={cn(
								'flex items-center gap-2 px-5 py-2 rounded-full text-sm font-medium transition-colors',
								forking || migrating
									? 'bg-primary/50 text-primary-foreground/50 cursor-not-allowed'
									: 'bg-primary text-primary-foreground hover:bg-primary/90 cursor-pointer',
							)}
						>
							{migrating ? (
								<>
									<Loader2 className="size-3.5 animate-spin" />
									Converting...
								</>
							) : (
								<>
									<ArrowRightLeft className="size-3.5" />
									Convert to session
								</>
							)}
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
