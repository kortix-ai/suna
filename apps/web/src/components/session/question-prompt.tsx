/**
 * QuestionPrompt — compact self-contained inline chip inside the chat input card.
 *
 * - Compact header row (icon + summary + dismiss/chevron)
 * - Expandable body with question options
 * - Single-question immediate submit on pick
 * - Multi-select toggle + Next/Confirm flow
 * - Custom answers typed in the main chat textarea (no nested input)
 */

"use client";

import { MessageCircle, X } from "lucide-react";
import { useCallback, useEffect, useImperativeHandle, useState } from "react";
import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import type { QuestionAnswer, QuestionInfo, QuestionRequest } from "@/ui";

// ---------------------------------------------------------------------------
// Lightweight markdown renderer for question text (no Shiki/KaTeX/Mermaid)
// ---------------------------------------------------------------------------

function QuestionMarkdown({ content, className }: { content: string; className?: string }) {
	return (
		<div className={cn("question-md", className)}>
		<ReactMarkdown
			remarkPlugins={[remarkGfm]}
			components={{
				p: ({ children }) => <p className="my-1 leading-relaxed">{children}</p>,
				strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
				em: ({ children }) => <em className="text-muted-foreground">{children}</em>,
				ul: ({ children }) => <ul className="my-0.5 pl-4 list-disc">{children}</ul>,
				ol: ({ children }) => <ol className="my-0.5 pl-4 list-decimal">{children}</ol>,
				li: ({ children }) => <li className="my-0">{children}</li>,
				code: ({ children }) => (
					<code className="text-xs px-1 py-0.5 rounded bg-muted font-mono">{children}</code>
				),
				a: ({ href, children }) => (
					<a href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2 hover:text-primary/80">
						{children}
					</a>
				),
			}}
		>
			{content}
		</ReactMarkdown>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/** The action the main send button should perform when a question is active. */
export type QuestionAction = 'send' | 'next' | 'submit' | 'add';

/** Methods exposed via ref for parent-driven interaction. */
export interface QuestionPromptHandle {
	/** Submit a custom answer (typed in the main chat textarea) for the current question. */
	submitCustomAnswer: (text: string) => void;
	/** Whether the current question accepts a custom text answer. */
	acceptsCustom: boolean;
	/** What action the main send button should show/perform. */
	action: QuestionAction;
	/** Whether the action can be performed right now (e.g. multi-select has selections). */
	canAct: boolean;
	/** Perform the current action (next/submit). Called by the main send button. */
	performAction: () => void;
}

interface QuestionPromptProps {
	request: QuestionRequest;
	onReply: (requestId: string, answers: QuestionAnswer[]) => void;
	onReject: (requestId: string) => void;
	/** Called whenever the question's action state changes (for syncing to the send button). */
	onActionChange?: (action: QuestionAction, canAct: boolean) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const QuestionPrompt = React.forwardRef<QuestionPromptHandle, QuestionPromptProps>(
	function QuestionPrompt(
		{ request, onReply, onReject, onActionChange },
		ref,
	) {
	const questions = request.questions;
	const isSingle = questions.length === 1 && !questions[0].multiple;

	const [tab, setTab] = useState(0);
	const [answers, setAnswers] = useState<QuestionAnswer[]>(() =>
		questions.map(() => []),
	);
	const [replying, setReplying] = useState(false);

	const isConfirm = tab === questions.length;
	const currentQuestion = questions[tab] as QuestionInfo | undefined;
	const isMulti = currentQuestion?.multiple ?? false;
	const options = currentQuestion?.options ?? [];
	const currentAnswers = answers[tab] ?? [];
	const showCustom = currentQuestion?.custom !== false;

	// -----------------------------------------------------------------------
	// Handlers
	// -----------------------------------------------------------------------

	const pick = useCallback(
		(answer: string) => {
			const next = [...answers];
			next[tab] = [answer];
			setAnswers(next);

			if (isSingle) {
				setReplying(true);
				onReply(request.id, [[answer]]);
				return;
			}

			// Advance to next tab
			setTab(tab + 1);
		},
		[answers, tab, isSingle, request.id, onReply],
	);

	const toggle = useCallback(
		(answer: string) => {
			const existing = answers[tab] ?? [];
			const next = [...existing];
			const idx = next.indexOf(answer);
			if (idx === -1) next.push(answer);
			else next.splice(idx, 1);

			const updated = [...answers];
			updated[tab] = next;
			setAnswers(updated);
		},
		[answers, tab],
	);

	const selectOption = useCallback(
		(optIndex: number) => {
			const opts = currentQuestion?.options ?? [];
			const opt = opts[optIndex];
			if (!opt) return;

			if (isMulti) {
				toggle(opt.label);
			} else {
				pick(opt.label);
			}
		},
		[currentQuestion?.options, isMulti, toggle, pick],
	);

	/** Called by the parent (via ref) when the user types a custom answer in the main textarea and hits send. */
	const handleCustomSubmit = useCallback(
		(value: string) => {
			const trimmed = value.trim();
			if (!trimmed) return;

			if (isMulti) {
				const existing = answers[tab] ?? [];
				if (!existing.includes(trimmed)) {
					const next = [...existing, trimmed];
					const updated = [...answers];
					updated[tab] = next;
					setAnswers(updated);
				}
				return;
			}

			pick(trimmed);
		},
		[isMulti, answers, tab, pick],
	);

	const advanceToNext = useCallback(() => {
		if (currentAnswers.length > 0) {
			setTab(tab + 1);
		}
	}, [currentAnswers.length, tab]);

	// Derive what action the main send button should represent
	const action: QuestionAction = (() => {
		if (isSingle) return 'send';
		if (isConfirm) return 'submit';
		// Any non-confirm tab in a multi-question flow shows "Next"
		return 'next';
	})();

	const canAct = (() => {
		if (action === 'submit') return true;
		if (action === 'next') return currentAnswers.length > 0;
		return true;
	})();

	const submit = useCallback(() => {
		setReplying(true);
		const finalAnswers = questions.map((_, i) => answers[i] ?? []);
		onReply(request.id, finalAnswers);
	}, [answers, questions, request.id, onReply]);

	const performAction = useCallback(() => {
		if (action === 'submit') {
			submit();
		} else if (action === 'next') {
			advanceToNext();
		}
		// 'send' is handled by SessionChatInput directly (custom answer)
	}, [action, submit, advanceToNext]);

	// Notify parent of action state changes
	useEffect(() => {
		onActionChange?.(action, canAct);
	}, [action, canAct, onActionChange]);

	// Expose imperative handle for parent-driven interaction
	useImperativeHandle(ref, () => ({
		submitCustomAnswer: handleCustomSubmit,
		acceptsCustom: showCustom && !isConfirm,
		action,
		canAct,
		performAction,
	}), [handleCustomSubmit, showCustom, isConfirm, action, canAct, performAction]);



	const reject = useCallback(() => {
		setReplying(true);
		onReject(request.id);
	}, [request.id, onReject]);

	// -----------------------------------------------------------------------
	// Once replied, hide completely
	// -----------------------------------------------------------------------

	if (replying) return null;

	// -----------------------------------------------------------------------
	// Header summary text
	// -----------------------------------------------------------------------

	const headerSummary = (() => {
		if (isSingle) {
			const q = questions[0];
			const trimmedHeader = q.header?.trim();
			if (trimmedHeader && trimmedHeader !== q.question.trim()) {
				return trimmedHeader;
			}
			return "Question";
		}
		const answered = answers.filter((a) => a.length > 0).length;
		return `${answered} of ${questions.length} answered`;
	})();

	// -----------------------------------------------------------------------
	// Render
	// -----------------------------------------------------------------------

	return (
		<div className="rounded-2xl border border-border/40 bg-muted/40 overflow-hidden">
			{/* Header row */}
			<div className="flex items-center gap-2 w-full px-3 py-1.5">
				<MessageCircle className="size-3.5 text-muted-foreground flex-shrink-0" />
				<span className="text-xs text-muted-foreground flex-1 min-w-0 truncate text-left">
					{isSingle ? "" : `${questions.length} questions \u00B7 `}
					<span className="text-foreground/80 font-medium truncate">
						{headerSummary}
					</span>
				</span>
				<span
					role="button"
					tabIndex={0}
					onClick={reject}
					onKeyDown={(e) => {
						if (e.key === "Enter" || e.key === " ") {
							reject();
						}
					}}
					className="inline-flex items-center justify-center size-5 rounded-md text-muted-foreground/40 hover:text-foreground hover:bg-muted transition-colors cursor-pointer shrink-0"
				>
					<X className="size-3" />
				</span>
			</div>

			{/* Body — scrollable so long option lists don't blow up the card */}
			<div className="border-t border-border/30 max-h-[420px] overflow-y-auto">
					{/* Tab bar (multi-question only) */}
					{!isSingle && (
						<div className="flex items-center gap-0.5 px-2 py-1 overflow-x-auto scrollbar-hide border-b border-border/30 bg-muted/20">
							{questions.map((q, i) => {
								const isAnswered = (answers[i]?.length ?? 0) > 0;
								return (
									<button
										key={i}
										onClick={() => {
											setTab(i);
										}}
										className={cn(
											"flex items-center gap-1 px-2 py-0.5 text-sm font-medium rounded-md border transition-colors duration-150 cursor-pointer whitespace-nowrap",
											tab === i
												? "bg-background/80 text-foreground border-border/70"
												: "text-muted-foreground border-transparent hover:text-foreground hover:bg-muted/70",
										)}
									>
										<span
											className={cn(
												"size-3 rounded-sm flex-shrink-0 flex items-center justify-center border",
												isAnswered
													? "border-border bg-muted"
													: tab === i
														? "border-foreground/30"
														: "border-border",
											)}
										>
											{isAnswered && (
												<svg viewBox="0 0 12 12" fill="none" width="7" height="7">
													<path d="M3 7.17905L5.02703 8.85135L9 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" className="text-foreground" />
												</svg>
											)}
											{!isAnswered && tab === i && (
												<div className="size-0.5 rounded-full bg-foreground" />
											)}
										</span>
										{q.header || `Q${i + 1}`}
									</button>
								);
							})}
							<button
								onClick={() => {
									setTab(questions.length);
								}}
							className={cn(
								"px-2 py-0.5 text-sm font-medium rounded-md border transition-colors duration-150 cursor-pointer",
								isConfirm
									? "bg-background/80 text-foreground border-border/70"
									: "text-muted-foreground border-transparent hover:text-foreground hover:bg-muted/70",
							)}
							>
								Confirm
							</button>
						</div>
					)}

					<div className="px-3 py-2">
						{/* Confirm / review tab */}
						{isConfirm ? (
							<div className="space-y-0.5">
							{questions.map((q, i) => {
								const ans = answers[i] ?? [];
								const done = ans.length > 0;
								return (
									<div
										key={i}
										className={cn(
											"flex items-center gap-1.5 py-0.5",
											!done && "opacity-40",
										)}
									>
										<span
											className={cn(
												"size-3 rounded-sm flex-shrink-0 flex items-center justify-center border",
												done ? "border-border bg-muted" : "border-border",
											)}
										>
											{done && (
												<svg viewBox="0 0 12 12" fill="none" width="7" height="7">
													<path d="M3 7.17905L5.02703 8.85135L9 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" className="text-foreground" />
												</svg>
											)}
										</span>
										<span
									className={cn(
												"text-sm leading-tight flex-1 min-w-0",
												done ? "text-foreground" : "text-muted-foreground",
											)}
										>
											<span className="truncate block">{q.header || q.question}</span>
										</span>
										<span className="text-sm text-muted-foreground truncate max-w-[40%] shrink-0">
											{ans.length > 0 ? ans.join(", ") : "\u2014"}
										</span>
									</div>
								);
							})}
							</div>
						) : currentQuestion ? (
							<div className="space-y-1">
								{/* Question text */}
							<div className="text-xs md:text-sm font-medium text-foreground/95 leading-relaxed max-h-[300px] overflow-y-auto">
								<QuestionMarkdown
									content={currentQuestion.question + (isMulti ? " *(select multiple)*" : "")}
								/>
							</div>

								{/* Options — compact rows */}
								<div className="space-y-px">
									{options.map((opt, i) => {
										const isPicked = currentAnswers.includes(opt.label);
										return (
											<button
												key={i}
												onClick={() => selectOption(i)}
												className={cn(
													"w-full flex items-center gap-2 px-2 py-1.5 rounded-2xl text-left cursor-pointer group border transition-colors duration-150 ease-out active:scale-[0.998]",
													isPicked
														? "bg-primary/10 border-primary/30"
														: "border-transparent hover:bg-muted/40",
												)}
											>
												<span
													className={cn(
														"size-4 rounded-[4px] flex-shrink-0 flex items-center justify-center border transition-colors",
														isPicked
															? "border-primary/50 bg-primary/10"
															: "border-border group-hover:border-foreground/30",
													)}
												>
													{isPicked && (
														<svg viewBox="0 0 12 12" fill="none" width="8" height="8">
															<path d="M3 7.17905L5.02703 8.85135L9 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" className="text-foreground" />
														</svg>
													)}
												</span>
												<span className="text-xs leading-tight min-w-0">
													<span
														className={cn(
															"font-semibold transition-colors duration-150",
															isPicked ? "text-foreground" : "text-foreground/80",
														)}
													>
														{opt.label}
													</span>
													{opt.description && (
														<span className={cn("ml-1", isPicked ? "text-muted-foreground/90" : "text-muted-foreground")}>
															{opt.description}
														</span>
													)}
												</span>
											</button>
										);
									})}


								</div>


							</div>
						) : null}
					</div>
				</div>
		</div>
	);
});
