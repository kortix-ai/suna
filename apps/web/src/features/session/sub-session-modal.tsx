"use client";

import { SquareKanban, X } from "lucide-react";
import { SessionChat } from "@/features/session/session-chat";
import {
	Dialog,
	DialogContent,
	DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

interface SubSessionModalProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	sessionId: string;
	title?: string;
}

export function SubSessionModal({
	open,
	onOpenChange,
	sessionId,
	title,
}: SubSessionModalProps) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				hideCloseButton
				className={cn(
					"flex flex-col p-0 gap-0 overflow-hidden",
					"w-[92vw] max-w-5xl h-[80vh] max-h-[840px]",
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
