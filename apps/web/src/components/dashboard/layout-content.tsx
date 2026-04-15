"use client";

import { usePathname, useRouter } from "next/navigation";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import { useAuth } from "@/components/AuthProvider";
import {
	ConnectingScreen,
	useConnectionToasts,
	type Stage as ConnectingStage,
} from "@/components/dashboard/connecting-screen";
import { AppProviders } from "@/components/layout/app-providers";
import { TabBar } from "@/components/tabs/tab-bar";
import { useAdminRole } from "@/hooks/admin";
import { useSystemStatusQuery } from "@/hooks/edge-flags";
import { useCreateOpenCodeSession } from "@/hooks/opencode/use-opencode-sessions";
import { OpenCodeEventStreamProvider } from "@/hooks/opencode/use-opencode-events";
import { useSandbox } from "@/hooks/platform/use-sandbox";
import { useSandboxConnection } from "@/hooks/platform/use-sandbox-connection";
import { useWebNotifications } from "@/hooks/use-web-notifications";
import { backendApi } from "@/lib/api-client";
import { getClient } from "@/lib/opencode-sdk";
import { Button } from "@/components/ui/button";
import { KortixLoader } from "@/components/ui/kortix-loader";
import { featureFlags } from "@/lib/feature-flags";
import { buildInstancePath, getActiveInstanceIdFromCookie, getCurrentInstanceIdFromPathname, normalizeAppPathname } from "@/lib/instance-routes";
import { cn } from "@/lib/utils";
import { resolveTabFromPathname } from "@/lib/tab-route-resolver";
import { useSandboxConnectionStore } from "@/stores/sandbox-connection-store";
import { useOnboardingModeStore } from "@/stores/onboarding-mode-store";
import { getActiveOpenCodeUrl, useServerStore, switchToInstance, switchToInstanceAsync } from "@/stores/server-store";
import { useTabStore, isTabRecentlyClosed } from "@/stores/tab-store";
import { AnnouncementDialog } from "../announcements/announcement-dialog";
import { NovuInboxProvider } from "../notifications/novu-inbox-provider";
import { FilePreviewDialog } from "../common/file-preview-dialog";
import { UpdateDialogProvider } from "@/components/update-dialog-provider";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { ChevronRight } from "lucide-react";

/** Monitors session status transitions and fires browser notifications. Renders nothing. */
function WebNotificationProvider() {
	useWebNotifications();
	return null;
}

// Lazy load heavy components that aren't needed for initial render

const MaintenancePage = lazy(() =>
	import("@/components/maintenance/maintenance-page").then((mod) => ({
		default: mod.MaintenancePage,
	})),
);
const StatusOverlay = lazy(() =>
	import("@/components/ui/status-overlay").then((mod) => ({
		default: mod.StatusOverlay,
	})),
);
const PresentationViewerWrapper = lazy(() =>
	import("@/stores/presentation-viewer-store").then((mod) => ({
		default: mod.PresentationViewerWrapper,
	})),
);

const SetupWizard = lazy(() =>
	import("@/components/onboarding/setup-wizard").then((mod) => ({
		default: mod.SetupWizard,
	})),
);


const DashboardPromoBanner = lazy(() =>
	import("@/components/home/dashboard-promo-banner").then((mod) => ({
		default: mod.DashboardPromoBanner,
	})),
);

const MobileAppInterstitial = lazy(() =>
	import("@/components/announcements/mobile-app-interstitial").then((mod) => ({
		default: mod.MobileAppInterstitial,
	})),
);

const SleepOverlay = lazy(() =>
	import("@/components/dashboard/sleep-overlay").then((mod) => ({
		default: mod.SleepOverlay,
	})),
);

const TechnicalIssueBanner = lazy(() =>
	import("@/components/announcements/technical-issue-banner").then((mod) => ({
		default: mod.TechnicalIssueBanner,
	})),
);

const MaintenanceCountdownBanner = lazy(() =>
	import("@/components/announcements/maintenance-countdown-banner").then(
		(mod) => ({ default: mod.MaintenanceCountdownBanner }),
	),
);



const CommandPalette = lazy(() =>
	import("@/components/command-palette").then((mod) => ({
		default: mod.CommandPalette,
	})),
);

const GlobalProviderModal = lazy(() =>
	import("@/components/providers/provider-modal").then((mod) => ({
		default: mod.GlobalProviderModal,
	})),
);




const SessionLayout = lazy(() =>
	import("@/components/session/session-layout").then((mod) => ({
		default: mod.SessionLayout,
	})),
);
const SessionChat = lazy(() =>
	import("@/components/session/session-chat").then((mod) => ({
		default: mod.SessionChat,
	})),
);
const FileTabContent = lazy(() =>
	import("@/components/tabs/file-tab-content").then((mod) => ({
		default: mod.FileTabContent,
	})),
);
const PreviewTabContent = lazy(() =>
	import("@/components/tabs/preview-tab-content").then((mod) => ({
		default: mod.PreviewTabContent,
	})),
);
const TerminalTabContent = lazy(() =>
	import("@/components/tabs/terminal-tab-content").then((mod) => ({
		default: mod.TerminalTabContent,
	})),
);
const PageTabContent = lazy(() =>
	import("@/components/tabs/page-tab-content").then((mod) => ({
		default: mod.PageTabContent,
	})),
);
const RunningServicesPanel = lazy(() =>
	import("@/components/tabs/running-services-panel").then((mod) => ({
		default: mod.RunningServicesPanel,
	})),
);
const BrowserTabContent = lazy(() =>
	import("@/components/tabs/browser-tab-content").then((mod) => ({
		default: mod.BrowserTabContent,
	})),
);
const DesktopTabContent = lazy(() =>
	import("@/components/tabs/desktop-tab-content").then((mod) => ({
		default: mod.DesktopTabContent,
	})),
);

const BootOverlay = lazy(() =>
	import("@/components/onboarding/boot-overlay").then((mod) => ({
		default: mod.BootOverlay,
	})),
);

/* ─── Onboarding helpers ─────────────────────────────────────── */

function getInstanceUrl() {
	return useServerStore.getState().getActiveServerUrl();
}

async function authFetch(...args: Parameters<typeof fetch>) {
	const { authenticatedFetch } = await import("@/lib/auth-token");
	return authenticatedFetch(...args);
}

async function persistEnv(key: string, value: string): Promise<boolean> {
	const u = getInstanceUrl();
	if (!u) return false;
	// Retry a few times — on fresh login the auth session may still be hydrating
	// and authFetch returns a synthetic 401 if the token isn't available yet.
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			const res = await authFetch(`${u}/env/${key}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ value }),
			});
			if (res.ok) return true;
			if (res.status === 401 && attempt < 4) {
				await new Promise(r => setTimeout(r, 1000));
				continue;
			}
			return false;
		} catch {
			if (attempt < 4) {
				await new Promise(r => setTimeout(r, 1000));
				continue;
			}
			return false;
		}
	}
	return false;
}

async function readEnv(key: string): Promise<string | null> {
	try {
		const u = getInstanceUrl();
		const res = await authFetch(`${u}/env/${key}`);
		if (!res.ok) return null;
		const d = await res.json();
		return d?.[key] ?? null;
	} catch { return null; }
}

// ============================================================================
// Pre-mounted session tabs: keeps all open sessions alive in the DOM so
// switching between tabs is instant (no re-mount, no loading spinner).
// ============================================================================
function SessionTabsContainer({ children }: { children: React.ReactNode }) {
	const tabs = useTabStore((s) => s.tabs) || {};
	const tabOrder = useTabStore((s) => s.tabOrder) || [];
	const activeTabId = useTabStore((s) => s.activeTabId);
	const obActive = useOnboardingModeStore((s) => s.active);
	const obSessionId = useOnboardingModeStore((s) => s.sessionId);

	// Collect tab IDs by type
	const sessionTabIds = tabOrder.filter((id) => tabs[id]?.type === "session");
	const fileTabIds = tabOrder.filter((id) => tabs[id]?.type === "file");
	const previewTabIds = tabOrder.filter((id) => tabs[id]?.type === "preview");
	const terminalTabIds = tabOrder.filter((id) => tabs[id]?.type === "terminal");
	const servicesTabIds = tabOrder.filter((id) => tabs[id]?.type === "services");
	const browserTabIds = tabOrder.filter((id) => tabs[id]?.type === "browser");
	const desktopTabIds = tabOrder.filter((id) => tabs[id]?.type === "desktop");
	const pageTabIds = tabOrder.filter((id) => {
		const t = tabs[id]?.type;
		return t === "settings" || t === "page" || t === "project" || t === "dashboard";
	});
	const activeTab = activeTabId ? tabs[activeTabId] : null;
	// All tab types are now pre-mounted — route-based children are never shown
	const showingMountedTab = !!activeTab;

	return (
		<div
			className={cn(
				"bg-background flex-1 min-h-0 flex flex-col overflow-hidden relative",
			)}
		>
			{/* Pre-mounted session tabs — always rendered, shown/hidden via CSS */}
			{sessionTabIds.map((id) => (
				<div
					key={id}
					className={cn(
						"absolute inset-0 flex flex-col",
						id !== activeTabId && "hidden",
					)}
				>
					<Suspense fallback={null}>
						<SessionLayout sessionId={id}>
							<SessionChat sessionId={id} hideHeader={obActive && id === obSessionId} />
						</SessionLayout>
					</Suspense>
				</div>
			))}

			{/* File tabs — rendered when active */}
			{fileTabIds.map((id) => {
				const tab = tabs[id];
				if (!tab) return null;
				// Extract file path from tab id (strip "file:" prefix)
				const filePath = id.startsWith("file:") ? id.slice(5) : id;
				return (
					<div
						key={id}
						className={cn(
							"absolute inset-0 flex flex-col",
							id !== activeTabId && "hidden",
						)}
					>
						<Suspense fallback={null}>
							<FileTabContent tabId={id} filePath={filePath} />
						</Suspense>
					</div>
				);
			})}

			{/* Preview tabs — iframe previews of sandbox services */}
			{previewTabIds.map((id) => (
				<div
					key={id}
					className={cn(
						"absolute inset-0 flex flex-col",
						id !== activeTabId && "hidden",
					)}
				>
					<Suspense fallback={null}>
						<PreviewTabContent tabId={id} />
					</Suspense>
				</div>
			))}

			{/* Terminal tabs — 1 tab = 1 PTY */}
			{terminalTabIds.map((id) => {
				const ptyId = id.startsWith("terminal:") ? id.slice(9) : id;
				return (
					<div
						key={id}
						className={cn(
							"absolute inset-0 flex flex-col",
							id !== activeTabId && "hidden",
						)}
					>
						<Suspense fallback={null}>
							<TerminalTabContent
								ptyId={ptyId}
								tabId={id}
								hidden={id !== activeTabId}
							/>
						</Suspense>
					</div>
				);
			})}

			{/* Services tabs — Running Services panel */}
			{servicesTabIds.map((id) => (
				<div
					key={id}
					className={cn(
						"absolute inset-0 flex flex-col",
						id !== activeTabId && "hidden",
					)}
				>
					<Suspense fallback={null}>
						<RunningServicesPanel />
					</Suspense>
				</div>
			))}

	{/* Browser tabs — agent-browser CDP viewport (port 9224, Chrome-only) */}
	{browserTabIds.map((id) => (
		<div
			key={id}
			className={cn(
				"absolute inset-0 flex flex-col",
				id !== activeTabId && "hidden",
			)}
		>
			<Suspense fallback={null}>
				<BrowserTabContent />
			</Suspense>
		</div>
	))}

	{/* Desktop tabs — full Selkies desktop stream (port 6080) */}
	{desktopTabIds.map((id) => (
		<div
			key={id}
			className={cn(
				"absolute inset-0 flex flex-col",
				id !== activeTabId && "hidden",
			)}
		>
			<Suspense fallback={null}>
				<DesktopTabContent />
			</Suspense>
		</div>
	))}

	{/* Page/settings/dashboard tabs — pre-mounted, shown/hidden via CSS */}
		{pageTabIds.map((id) => {
				const tab = tabs[id];
				if (!tab) return null;
				return (
					<div
						key={id}
						className={cn(
							"absolute inset-0 flex flex-col overflow-y-auto",
							id !== activeTabId && "hidden",
						)}
					>
						<Suspense fallback={null}>
							<PageTabContent href={tab.href} />
						</Suspense>
					</div>
				);
			})}

			{/* Route-based children (fallback — hidden since all types are pre-mounted) */}
			<div
				className={cn(
					"flex-1 min-h-0 flex flex-col overflow-y-auto",
					showingMountedTab && "hidden",
				)}
			>
				{children}
			</div>
		</div>
	);
}

/* ─── Floating skip button shown during the onboarding chat session ───── */
function OnboardingSkipButton({ onConfirm }: { onConfirm: () => void }) {
	return (
		<AlertDialog>
			<AlertDialogTrigger asChild>
				<Button
					variant="outline"
					size="sm"
					className="absolute top-3 right-3 z-20"
				>
					Skip onboarding
					<ChevronRight className="h-3.5 w-3.5" />
				</Button>
			</AlertDialogTrigger>
			<AlertDialogContent className="max-w-sm rounded-2xl">
				<AlertDialogHeader>
					<AlertDialogTitle className="text-base font-medium text-foreground/90">Skip onboarding?</AlertDialogTitle>
					<AlertDialogDescription className="text-[13px] text-muted-foreground/60 leading-relaxed">
						You can set up your profile anytime. Your agent will work fine — it just won&apos;t know your preferences yet.
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter className="gap-2 sm:gap-2">
					<AlertDialogCancel className="rounded-xl text-[13px]">Continue</AlertDialogCancel>
					<AlertDialogAction
						onClick={onConfirm}
						className="rounded-xl text-[13px] bg-foreground text-background hover:bg-foreground/90"
					>
						Skip onboarding
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}

interface DashboardLayoutContentProps {
	children: React.ReactNode;
	/**
	 * Sidebar open state as read from the `sidebar_state` cookie on the
	 * server. Used as the SSR default so the sidebar doesn't flash
	 * expanded-then-collapse on reload when the user's last choice was
	 * collapsed. `undefined` means no cookie was set (first visit).
	 */
	initialSidebarOpen?: boolean;
}

export default function DashboardLayoutContent({
	children,
	initialSidebarOpen,
}: DashboardLayoutContentProps) {
	const { user, isLoading } = useAuth();
	const router = useRouter();
	const pathname = usePathname();
	const explicitRouteInstanceId = getCurrentInstanceIdFromPathname(pathname);
	const routeInstanceId = explicitRouteInstanceId || getActiveInstanceIdFromCookie();
	const { data: systemStatus, isLoading: systemStatusLoading } =
		useSystemStatusQuery();
	const maintenanceNotice = systemStatus?.maintenanceNotice;
	const technicalIssue = systemStatus?.technicalIssue;
	const statusUpdatedAt = systemStatus?.updatedAt;
	// NOTE: useApiHealth was removed from the layout guards. Its momentary
	// failures were unmounting the ENTIRE component tree (including session
	// tabs and chat input), causing the "random refresh/flicker" bug.
	// Sandbox reachability is handled by ConnectingScreen (overlay, not
	// early return), which never unmounts children.

	// Register the primary sandbox in the server store so the OpenCode SDK can
	// connect. Must run before the onboarding check.
	useSandbox();

	// Sandbox health poller + connect/disconnect toasts. Mounted at the top of
	// the layout (not inside the post-guard JSX) so the first health check
	// starts in parallel with the onboarding check. This collapses the old
	// "DashboardSkeleton → ConnectingScreen first-connect overlay" double
	// loader into a single unified loading state on initial mount.
	useSandboxConnection();
	useConnectionToasts();
	const connectionStatus = useSandboxConnectionStore((s) => s.status);

	const { data: adminRoleData, isLoading: isCheckingAdminRole } =
		useAdminRole();
	const isAdmin = adminRoleData?.isAdmin ?? false;

	useEffect(() => {
		if (user) {
			backendApi.post("/prewarm", undefined, { showErrors: false });
		}
	}, [user]);

	// Check authentication status
	useEffect(() => {
		if (!isLoading && !user) {
			router.push("/auth");
		}
	}, [user, isLoading, router]);

	// ── Onboarding-as-state: the dashboard IS the onboarding page ──
	// No redirect. If ONBOARDING_COMPLETE is false the dashboard renders
	// in onboarding mode (full-screen thread, no chrome). When complete
	// the sidebars morph in — pure state change.
	const ob = useOnboardingModeStore();
	const createSession = useCreateOpenCodeSession();
	const createSessionRef = useRef(createSession);
	createSessionRef.current = createSession;
	const obCreating = useRef(false);
	const obCmdFired = useRef(false);
	const obRetries = useRef(0);

	const activeServerId = useServerStore((s) => s.activeServerId);

	// Seed `onboardingChecked` from localStorage so users who have already
	// completed onboarding on this instance skip the 100-300 ms round-trip
	// on every subsequent cold load. The real check still runs in the
	// background and flips this to its authoritative value.
	const [onboardingChecked, setOnboardingChecked] = useState(() => {
		if (typeof window === "undefined") return false;
		try {
			return (
				localStorage.getItem(
					`kortix-onboarding-complete:${routeInstanceId || "default"}`,
				) === "true"
			);
		} catch {
			return false;
		}
	});
	const [routeSyncing, setRouteSyncing] = useState(false);
	const openTab = useTabStore((s) => s.openTab);
	const setActiveTab = useTabStore((s) => s.setActiveTab);

	useEffect(() => {
		const normalizedPath = normalizeAppPathname(pathname);
		const descriptor = resolveTabFromPathname(normalizedPath);
		if (!descriptor) return;

		// Skip if this tab was just closed via the UI — pathname can race behind
		// the close action and we'd spuriously re-open the tab the user just closed.
		if (isTabRecentlyClosed(descriptor.id)) return;

		const { tabs, activeTabId: currentActive } = useTabStore.getState();
		const existing = tabs[descriptor.id];
		if (existing) {
			if (currentActive !== descriptor.id) {
				setActiveTab(descriptor.id);
			}
			return;
		}

		openTab({
			id: descriptor.id,
			title: descriptor.title,
			type: descriptor.type,
			href: descriptor.href,
			...(descriptor.metadata ? { metadata: descriptor.metadata } : {}),
		});
	}, [pathname, openTab, setActiveTab]);

	useEffect(() => {
		// When the instance changes, re-seed from that instance's cache.
		if (typeof window === "undefined") return;
		try {
			const cached =
				localStorage.getItem(
					`kortix-onboarding-complete:${routeInstanceId || "default"}`,
				) === "true";
			setOnboardingChecked(cached);
		} catch {
			setOnboardingChecked(false);
		}
	}, [routeInstanceId]);

	// Timeout fallback — fail open if sandbox never responds.
	useEffect(() => {
		if (onboardingChecked || routeSyncing) return;
		const t = setTimeout(() => {
			if (!onboardingChecked) {
				console.warn("[layout] Onboarding check timed out — failing open");
				setOnboardingChecked(true);
			}
		}, 1000);
		return () => clearTimeout(t);
	}, [onboardingChecked, routeSyncing]);

	// ── Query param controls ──────────────────────────────────────
	// ?onboarding-skip  → mark complete, skip straight to dashboard
	// ?onboarding-redo  → reset to false, re-run onboarding from scratch
	const [paramHandled, setParamHandled] = useState(false);
	useEffect(() => {
		if (typeof window === "undefined") return;
		const params = new URLSearchParams(window.location.search);
		const wantsSkip = params.has("onboarding-skip");
		const wantsRedo = params.has("onboarding-redo");

		// Persist skip/redo intent in sessionStorage so it survives auth redirects.
		// The auth callback strips query params, so we stash the intent before redirect
		// and check it after login when we land back on the dashboard.
		if (wantsSkip) sessionStorage.setItem("kortix-onboarding-skip", "1");
		if (wantsRedo) sessionStorage.setItem("kortix-onboarding-redo", "1");

		const storedSkip = sessionStorage.getItem("kortix-onboarding-skip") === "1";
		const storedRedo = sessionStorage.getItem("kortix-onboarding-redo") === "1";
		const shouldSkip = wantsSkip || storedSkip;
		const shouldRedo = wantsRedo || storedRedo;

		if (!shouldSkip && !shouldRedo) { setParamHandled(true); return; }

		// Don't attempt to persist until we have a valid sandbox URL.
		// In cloud mode, getInstanceUrl() returns '' while the sandbox is still
		// being registered. Bailing here keeps sessionStorage intact so the
		// effect retries when activeServerId changes to a real server.
		const instanceUrl = getInstanceUrl();
		if (!instanceUrl) return;

		(async () => {
			if (shouldSkip) {
				const ok = await persistEnv("ONBOARDING_COMPLETE", "true");
				if (!ok) return; // sandbox unreachable — keep intent, retry on next activeServerId change
				sessionStorage.removeItem("kortix-onboarding-skip");
				// Clean URL and let the normal check pass through
				const clean = new URL(window.location.href);
				clean.searchParams.delete("onboarding-skip");
				window.history.replaceState({}, "", clean.pathname + clean.search);
				ob.done(); // exit onboarding mode if active
				setParamHandled(true);
			} else if (shouldRedo) {
				const ok = await persistEnv("ONBOARDING_COMPLETE", "false");
				if (!ok) return; // sandbox unreachable — keep intent, retry on next activeServerId change
				await persistEnv("ONBOARDING_SESSION_ID", "");
				await persistEnv("ONBOARDING_COMMAND_FIRED", "");
				sessionStorage.removeItem("kortix-onboarding-redo");
				const clean = new URL(window.location.href);
				clean.searchParams.delete("onboarding-redo");
				window.history.replaceState({}, "", clean.pathname + clean.search);
				ob.done(); // reset any existing state
				setParamHandled(true);
			}
		})();
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [activeServerId]);

	// Check ONBOARDING_COMPLETE — enter onboarding mode or pass through.
	//
	// Guiding rule: onboarding is ONLY entered when we have positive evidence
	// that it's incomplete (the proxy returned a 200 with ONBOARDING_COMPLETE
	// !== 'true'). A 5xx / network failure means the sandbox is unreachable
	// right now — we can't tell whether onboarding was done, so we do NOT
	// enter onboarding mode. Instead we bail and let either
	//   (a) the retry-on-activeServerId-change re-run the check once the
	//       sandbox comes back, or
	//   (b) the 1-second timeout fail-open branch render the dashboard shell
	//       so the connection monitor can surface the real error.
	//
	// Previously we defaulted to onboarding on any failure, which meant a
	// transiently down sandbox would pop the setup wizard on users who had
	// already onboarded. Never again.
	useEffect(() => {
		if (!paramHandled) return;
		const check = async () => {
			if (routeSyncing) return;
			const instanceUrl = getActiveOpenCodeUrl();
			if (!instanceUrl) return;
			try {
				const f = await import("@/lib/auth-token").then((m) => m.authenticatedFetch);
				const res = await f(`${instanceUrl}/env/ONBOARDING_COMPLETE`, undefined, { retryOnAuthError: false });
				if (!res.ok) {
					// Sandbox unreachable or auth not yet propagated — do NOT
					// assume "not onboarded". Bail silently; the effect re-runs
					// when activeServerId changes, and the timeout fallback
					// keeps the UI from hanging forever.
					console.warn(`[onboarding] /env/ONBOARDING_COMPLETE returned ${res.status} — deferring, not entering onboarding`);
					return;
				}
				const data = await res.json();
				if (data?.ONBOARDING_COMPLETE === 'true') {
					// Persist so subsequent cold loads skip this round-trip.
					try {
						localStorage.setItem(
							`kortix-onboarding-complete:${routeInstanceId || "default"}`,
							"true",
						);
					} catch {
						/* private mode / quota — non-fatal */
					}
					setOnboardingChecked(true);
				} else {
					// Enter onboarding mode. If there's an existing session, skip boot + setup.
					// Also clear any stale "onboarding complete" cache for this instance.
					try {
						localStorage.removeItem(
							`kortix-onboarding-complete:${routeInstanceId || "default"}`,
						);
					} catch {
						/* non-fatal */
					}
					const existing = await readEnv("ONBOARDING_SESSION_ID");
					ob.enter({ skipBoot: !!existing, skipSetup: !!existing });
					setOnboardingChecked(true);
				}
			} catch {
				// Network error — sandbox is unreachable. Same reasoning as
				// the !res.ok branch: do NOT default to onboarding. Let the
				// connection monitor surface the real error state.
				console.warn('[onboarding] Failed to check ONBOARDING_COMPLETE — deferring, not entering onboarding');
			}
		};
		check();
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [activeServerId, routeInstanceId, routeSyncing, paramHandled]);

	// ── Onboarding: create / resume session (only after boot + setup are done) ──
	useEffect(() => {
		if (!ob.active || ob.showBoot || ob.showSetup || ob.sessionId) return;
		if (obCreating.current) return;
		obCreating.current = true;

		let retryTimer: ReturnType<typeof setTimeout>;
		(async () => {
			try {
				const alreadyFired = (await readEnv("ONBOARDING_COMMAND_FIRED")) === "true";
				if (alreadyFired) obCmdFired.current = true;

				let sid: string | null = null;
				let needsCmd = false;
				const existing = await readEnv("ONBOARDING_SESSION_ID");

				if (existing) {
					try {
						const c = getClient();
						await c.session.get({ sessionID: existing });
						sid = existing;
						const msgs = await c.session.messages({ sessionID: existing });
						if (!(msgs.data ?? []).some((m: any) => m.info?.role === "assistant")) needsCmd = true;
					} catch {
						persistEnv("ONBOARDING_SESSION_ID", "");
					}
				}

				if (!sid) {
					const s = await createSessionRef.current.mutateAsync({ title: "Kortix Onboarding" });
					persistEnv("ONBOARDING_SESSION_ID", s.id);
					sid = s.id;
					needsCmd = true;
				}

				if (needsCmd && !obCmdFired.current) {
					obCmdFired.current = true;
					persistEnv("ONBOARDING_COMMAND_FIRED", "true");
					void getClient().session.command({ sessionID: sid, command: "onboarding", arguments: "" })
						.catch(() => { obCmdFired.current = false; });
				}

				ob.setSessionId(sid);
				useTabStore.getState().openTab({ id: sid, title: "Kortix Onboarding", type: "session", href: `/sessions/${sid}` });
			} catch (err) {
				obCreating.current = false;
				obRetries.current++;
				const msg = err instanceof Error ? err.message : String(err ?? "");
				if (/still syncing|provisioning|not ready|sandbox route/i.test(msg) || obRetries.current < 3) {
					retryTimer = setTimeout(() => { obCreating.current = false; ob.hideBoot(); }, 2000);
				} else {
					toast.error(msg || "Could not start onboarding. Try refreshing.");
				}
			}
		})();
		return () => clearTimeout(retryTimer);
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ob.active, ob.showBoot, ob.showSetup, ob.sessionId]);

	// ── Onboarding: liveness fallback — re-fire /onboarding if assistant never starts ──
	useEffect(() => {
		if (!ob.active || !ob.sessionId) return;
		const t = setTimeout(async () => {
			try {
				const c = getClient();
				const msgs = await c.session.messages({ sessionID: ob.sessionId! });
				if ((msgs.data ?? []).some((m: any) => m.info?.role === "assistant")) return;
				obCmdFired.current = true;
				persistEnv("ONBOARDING_COMMAND_FIRED", "true");
				void c.session.command({ sessionID: ob.sessionId!, command: "onboarding", arguments: "" })
					.catch(() => { obCmdFired.current = false; });
			} catch {}
		}, 8000);
		return () => clearTimeout(t);
	}, [ob.active, ob.sessionId]);

	// ── Onboarding: poll ONBOARDING_COMPLETE → trigger morph ──
	useEffect(() => {
		if (!ob.active || ob.morphing || ob.showBoot) return;
		const iv = setInterval(async () => {
			const v = await readEnv("ONBOARDING_COMPLETE");
			if (v === "true") {
				clearInterval(iv);
				ob.morph();
				setTimeout(() => ob.done(), 900);
			}
		}, 3000);
		return () => clearInterval(iv);
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ob.active, ob.morphing, ob.showBoot]);

	// ── Boot overlay callback ──
	const handleBootDone = useCallback(() => ob.hideBoot(), [ob]);

	// ── Setup wizard callback ──
	const handleSetupDone = useCallback(() => ob.hideSetup(), [ob]);

	// ── Skip onboarding callback (from floating button during chat) ──
	const handleSkipOnboarding = useCallback(async () => {
		await persistEnv("ONBOARDING_COMPLETE", "true");
		ob.morph();
		setTimeout(() => ob.done(), 900);
	}, [ob]);

	// Keep the active server in sync with the current instance.
	// Source of truth: URL path (/instances/:id/...) OR active-instance cookie
	// (set by middleware on rewrite). The store MUST point at that instance.
	//
	// Fast path: subscribe to the server store. `useSandbox()` is fetching
	// sandboxes in parallel; as soon as the one we want lands in the store
	// we switch to it synchronously — no extra `listSandboxes()` round-trip.
	// Only if it doesn't show up within a short grace window do we fall back
	// to an explicit API fetch.
	useEffect(() => {
		if (!routeInstanceId || !user) {
			setRouteSyncing(false);
			return;
		}

		// Already pointing at the right instance? Skip entirely.
		{
			const state = useServerStore.getState();
			const active = state.servers.find((s) => s.id === state.activeServerId);
			if (active?.instanceId === routeInstanceId) {
				setRouteSyncing(false);
				return;
			}
		}

		let cancelled = false;

		// Try the store synchronously first — zero network cost.
		const syncResult = switchToInstance(routeInstanceId);
		if (syncResult) {
			setRouteSyncing(false);
			return;
		}

		setRouteSyncing(true);

		// Subscribe to store updates so we react the instant `useSandbox()`
		// registers the instance. This avoids making our own `listSandboxes()`
		// call in the common case.
		const unsubscribe = useServerStore.subscribe((s) => {
			if (cancelled) return;
			const match = s.servers.find(
				(server) => server.instanceId === routeInstanceId,
			);
			if (!match) return;
			const result = switchToInstance(routeInstanceId);
			if (result) {
				setRouteSyncing(false);
				unsubscribe();
			}
		});

		// Grace window fallback: if `useSandbox()` hasn't populated the store
		// within 1.5s (e.g. primary sandbox fetch failed, or this instance is
		// stopped/deleted), fetch directly. `validate: false` still tries the
		// store first before hitting the API.
		const fallbackTimer = setTimeout(() => {
			if (cancelled) return;
			switchToInstanceAsync(routeInstanceId, { validate: false })
				.then((result) => {
					if (cancelled) return;
					if (!result) {
						router.replace(`/instances/${routeInstanceId}`);
						return;
					}
					setRouteSyncing(false);
					unsubscribe();
				})
				.catch(() => {
					if (cancelled) return;
					router.replace(`/instances/${routeInstanceId}`);
				});
		}, 1500);

		return () => {
			cancelled = true;
			clearTimeout(fallbackTimer);
			unsubscribe();
		};
	}, [routeInstanceId, user, router]);

	const isMaintenanceActive = (() => {
		if (
			!maintenanceNotice?.enabled ||
			!maintenanceNotice.startTime ||
			!maintenanceNotice.endTime
		) {
			return false;
		}
		const now = new Date();
		const start = new Date(maintenanceNotice.startTime);
		const end = new Date(maintenanceNotice.endTime);
		return now >= start && now <= end;
	})();

	const isMaintenanceScheduled = (() => {
		if (
			!maintenanceNotice?.enabled ||
			!maintenanceNotice.startTime ||
			!maintenanceNotice.endTime
		) {
			return false;
		}
		const now = new Date();
		const start = new Date(maintenanceNotice.startTime);
		const end = new Date(maintenanceNotice.endTime);
		return now < start && now < end;
	})();

	// ── Unified initial-load gate ───────────────────────────────────────────
	// On the VERY first render, show the single canonical ConnectingScreen
	// until:
	//   - auth has resolved
	//   - the onboarding check has returned
	//   - the sandbox connection has settled (connected OR unreachable)
	//
	// Once we've rendered the dashboard once, `hasEverRendered` latches true
	// and we never return to the connect screen via early-return — transient
	// failures and in-app instance switches are handled by the ConnectingScreen
	// overlay rendered inside the tree, which avoids unmounting everything
	// (the invariant called out at the top of this component).
	//
	// The same <ConnectingScreen /> component is used here and as the overlay
	// below, so there is exactly one loading screen in the entire app.
	const [hasEverRendered, setHasEverRendered] = useState(false);
	useEffect(() => {
		if (hasEverRendered) return;
		if (
			!isLoading &&
			!!user &&
			onboardingChecked &&
			connectionStatus !== "connecting"
		) {
			setHasEverRendered(true);
		}
	}, [hasEverRendered, isLoading, user, onboardingChecked, connectionStatus]);

	// Pin the stage copy to whatever is actually pending so the connect
	// screen reflects real progress instead of cycling blindly.
	let gateStage: ConnectingStage | undefined;
	if (isLoading || !user) gateStage = "auth";
	else if (routeSyncing) gateStage = "routing";
	else if (connectionStatus === "connecting") gateStage = "reaching";
	else if (!onboardingChecked) gateStage = "restoring";

	const gateActive =
		!hasEverRendered &&
		(isLoading ||
			!user ||
			!onboardingChecked ||
			connectionStatus === "connecting");

	const maintenanceBlock =
		isMaintenanceActive &&
		!systemStatusLoading &&
		!isCheckingAdminRole &&
		!isAdmin;

	const hideChrome = ob.active && !ob.morphing;

	// ConnectingScreen is mounted once at the top level and persists across
	// the gate→dashboard transition. Same DOM position in every branch, so
	// React keeps the same instance and there is zero flicker between the
	// initial load screen and the dashboard shell. When `gateActive` flips
	// false, the sibling layout tree mounts underneath without disturbing
	// the already-painted loader. After connection settles, the component
	// reads store state and either returns null (connected) or swaps to
	// the reconnect pill / unreachable view in place.
	return (
		<>
			<ConnectingScreen
				forceConnecting={gateActive}
				overrideStage={gateStage}
			/>
			{!gateActive && maintenanceBlock && (
				<Suspense fallback={null}>
					<MaintenancePage />
				</Suspense>
			)}
			{!gateActive && !maintenanceBlock && (
				<NovuInboxProvider>
			{/* Boot overlay — BIOS + logo on top of everything */}
			{ob.showBoot && (
				<Suspense fallback={null}>
					<BootOverlay onComplete={handleBootDone} />
				</Suspense>
			)}

			<Suspense fallback={null}>
				<SleepOverlay />
			</Suspense>
			<AppProviders
				showSidebar={true}
				defaultSidebarOpen={
					// Prefer the server-read cookie so SSR and client match
					// (no flicker on reload). Fall back to `!ob.active` when
					// there's no persisted choice yet.
					initialSidebarOpen ?? !ob.active
				}
				sidebarSiblings={
					<Suspense fallback={null}>
						<StatusOverlay />
					</Suspense>
				}
			>
			<OpenCodeEventStreamProvider />
			<WebNotificationProvider />
			<UpdateDialogProvider />
			<Suspense fallback={null}>
				<GlobalProviderModal />
			</Suspense>

			{/* Setup wizard — shown after boot, before chat session */}
			{ob.showSetup && (
				<Suspense fallback={null}>
					<SetupWizard onComplete={handleSetupDone} />
				</Suspense>
			)}

			{!hideChrome && (
				<Suspense fallback={null}>
					<DashboardPromoBanner />
				</Suspense>
			)}

				<div className="relative flex-1 min-h-0 flex flex-col overflow-hidden">
					{!hideChrome && (
						<Suspense fallback={null}>
							<AnnouncementDialog />
						</Suspense>
					)}
					{!hideChrome && <FilePreviewDialog />}

					<Suspense fallback={null}>
						<CommandPalette />
					</Suspense>

					{/* Tab bar — hidden during onboarding, morphs in */}
					<AnimatePresence initial={false}>
						{!hideChrome && (
							<motion.div
								key="tab-bar"
								initial={{ height: 0, opacity: 0 }}
								animate={{ height: "auto", opacity: 1 }}
								exit={{ height: 0, opacity: 0 }}
							transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
							className="overflow-hidden"
						>
								<TabBar />
							</motion.div>
						)}
					</AnimatePresence>

					<div className="flex-1 min-h-0 flex flex-col md:border md:border-b-0 md:border-border/50 overflow-hidden md:rounded-t-xl relative">
						<SessionTabsContainer>{children}</SessionTabsContainer>

						{/* Floating skip button during onboarding chat session */}
						{ob.active && !ob.showBoot && !ob.showSetup && ob.sessionId && (
							<OnboardingSkipButton onConfirm={handleSkipOnboarding} />
						)}

						{/* Loading state while creating onboarding session */}
						{ob.active && !ob.sessionId && !ob.showBoot && !ob.showSetup && (
							<div className="absolute inset-0 z-10 flex items-center justify-center bg-background">
								<div className="flex flex-col items-center gap-3">
									<KortixLoader size="medium" />
									<p className="text-xs text-muted-foreground">Setting up your workspace…</p>
								</div>
							</div>
						)}
					</div>

					<Suspense fallback={null}>
						<PresentationViewerWrapper />
					</Suspense>
				</div>

				{/* Fixed-position notification toasts — rendered outside main flex to not affect layout */}
				{technicalIssue?.enabled && technicalIssue.message && (
					<Suspense fallback={null}>
						<TechnicalIssueBanner
							message={technicalIssue.message}
							statusUrl={technicalIssue.statusUrl}
							updatedAt={statusUpdatedAt}
						/>
					</Suspense>
				)}
				{isMaintenanceScheduled &&
					maintenanceNotice?.startTime &&
					maintenanceNotice?.endTime && (
						<Suspense fallback={null}>
							<MaintenanceCountdownBanner
								startTime={maintenanceNotice.startTime}
								endTime={maintenanceNotice.endTime}
								updatedAt={statusUpdatedAt}
							/>
						</Suspense>
					)}
				{!featureFlags.disableMobileAdvertising ? (
					<Suspense fallback={null}>
						<MobileAppInterstitial />
					</Suspense>
				) : null}
			</AppProviders>
		</NovuInboxProvider>
			)}
		</>
	);
}
