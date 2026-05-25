"use client";

import { useTranslations } from 'next-intl';

import { ExternalLink, SquareKanban, X } from "lucide-react";
import { useCallback } from "react";
import { SessionChat } from "@/components/session/session-chat";
import {
	Dialog,
	DialogContent,
	DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useServerStore } from "@/stores/server-store";
import { openTabAndNavigate } from "@/stores/tab-store";

interface SubSessionModalProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	sessionId: string;
	parentSessionId?: string;
	title?: string;
}

export function SubSessionModal({
	open,
	onOpenChange,
	sessionId,
	parentSessionId,
	title,
}: SubSessionModalProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
	const handleOpenInTab = useCallback(() => {
		onOpenChange(false);
		openTabAndNavigate({
			id: sessionId,
			title: title || "Sub-agent",
			type: "session",
			href: `/sessions/${sessionId}`,
			parentSessionId,
			serverId: useServerStore.getState().activeServerId,
		});
	}, [sessionId, parentSessionId, title, onOpenChange]);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				hideCloseButton
				className={cn(
					"flex flex-col p-0 gap-0 overflow-hidden",
					"w-[90vw] max-w-4xl h-[80vh] max-h-[800px]",
				)}
				aria-describedby={undefined}
			>
				{/* Header bar */}
				<div className="flex items-center gap-2 px-4 py-2.5 border-b border-border/50 bg-muted/30 shrink-0">
					<SquareKanban className="size-3.5 text-muted-foreground flex-shrink-0" />
					<DialogTitle className="text-sm font-medium truncate flex-1">
						{title || "Sub-session"}
					</DialogTitle>
					<button
						type="button"
						onClick={handleOpenInTab}
						className={cn(
							"flex items-center gap-1.5 px-2 py-1 rounded-md text-xs",
							"text-muted-foreground hover:text-foreground",
							"hover:bg-muted/60 transition-colors",
						)}
					>
						<ExternalLink className="size-3" />
						<span>{tHardcodedUi.raw('componentsSessionSubSessionModal.line68JsxTextOpenInTab')}</span>
					</button>
					<button
						type="button"
						onClick={() => onOpenChange(false)}
						className={cn(
							"flex items-center justify-center size-6 rounded-md",
							"text-muted-foreground hover:text-foreground",
							"hover:bg-muted/60 transition-colors",
						)}
					>
						<X className="size-3.5" />
					</button>
				</div>

				{/* Session chat — read-only, no header */}
				<div className="flex-1 min-h-0 overflow-hidden">
			<SessionChat
					sessionId={sessionId}
					hideHeader
					readOnly
					initialScrollTop
				/>
				</div>
			</DialogContent>
		</Dialog>
	);
}
