'use client';

import * as React from 'react';

/**
 * The host adapters for @kortix/ui: the copy components render when the
 * caller passes no label, the link component they navigate with, and the
 * organization marks KortixLogo renders. A host mounts <UiProvider> once at
 * its root. Without one, components render the English defaults, a plain <a>
 * and the Kortix logo.
 */
/**
 * The copy @kortix/ui/chat renders. Every key has an English default; a host
 * passes the keys it translates as `strings.chat`. Function keys take the
 * value they interpolate.
 */
export interface ChatStrings {
  /** Empty transcript hint. */
  emptyState: string;
  loadingConversation: string;
  sending: string;
  agentWorking: string;
  /** Composer placeholder while the runtime is ready. */
  placeholder: string;
  /** Appended to `placeholder` when the session has at least one command. */
  placeholderCommandsHint: string;
  /** Composer placeholder while the runtime is not ready. */
  placeholderWaiting: string;
  /** Composer textarea label. */
  message: string;
  /** Slash-command menu label and header. */
  commands: string;
  send: string;
  stop: string;
  runtimeStopped: string;
  reconnect: string;
  connectingRuntime: string;
  /** Model picker trigger label. */
  model: string;
  defaultModel: string;
  searchModels: string;
  models: string;
  noModelsMatch: string;
  /** Agent picker trigger label. */
  agent: string;
  defaultAgent: string;
  /** The default agent's row: `name (default)`. */
  defaultAgentNamed: (name: string) => string;
  thoughtProcess: string;
  /** Retry note while the model call is retried. */
  retrying: (attempt: number, message: string) => string;
  /** Under the error row that ended an automatic recovery chain. */
  autoRetried: (count: number) => string;
  contextCompacted: string;
  contextCompactedAuto: string;
  delegatedTo: (agent: string) => string;
  filesChanged: (count: number) => string;
  questionTitle: string;
  questionsTitle: (count: number) => string;
  stopAndCancel: string;
  customAnswerPlaceholder: string;
  customAnswerLabel: string;
  submitAnswer: string;
  answerFailed: string;
  /** Permission prompt: the `Allow` before the permission name and the `?` after it. */
  allowPrefix: string;
  allowSuffix: string;
  /** Fallback permission name. */
  thisAction: string;
  deny: string;
  always: string;
  allowOnce: string;
  decisionFailed: string;
  sendFailedBilling: string;
  sendFailedRuntimeNotReady: string;
  sendFailedRuntimeError: string;
  sendFailedModel: (provider: string) => string;
  sendFailed: string;
  /** Title of the alert when a slash command is refused. */
  commandFailed: string;
  webSearchFailed: (error: string) => string;
  noResults: string;
  noMatches: string;
  todoItems: (count: number) => string;
}

export const defaultChatStrings: ChatStrings = {
  emptyState: 'Send a message to get the agent working.',
  loadingConversation: 'Loading conversation…',
  sending: 'Sending…',
  agentWorking: 'Agent is working…',
  placeholder: 'Message the agent…',
  placeholderCommandsHint: '  (/ for commands)',
  placeholderWaiting: 'Waiting for the runtime…',
  message: 'Message',
  commands: 'Commands',
  send: 'Send',
  stop: 'Stop',
  runtimeStopped: 'The runtime stopped. Reconnect to keep chatting.',
  reconnect: 'Reconnect',
  connectingRuntime: 'Connecting to the runtime…',
  model: 'Model',
  defaultModel: 'Default model',
  searchModels: 'Search models…',
  models: 'Models',
  noModelsMatch: 'No models match.',
  agent: 'Agent',
  defaultAgent: 'Default agent',
  defaultAgentNamed: (name) => `${name} (default)`,
  thoughtProcess: 'Thought process',
  retrying: (attempt, message) => `Retrying (attempt ${attempt}): ${message}`,
  autoRetried: (count) =>
    `Retried automatically ${count === 1 ? 'once' : `${count} times`} before this failure.`,
  contextCompacted: 'Context compacted',
  contextCompactedAuto: 'Context compacted automatically',
  delegatedTo: (agent) => `Delegated to ${agent}`,
  filesChanged: (count) => `${count} file${count === 1 ? '' : 's'} changed`,
  questionTitle: 'The agent has a question',
  questionsTitle: (count) => `${count} questions`,
  stopAndCancel: 'Stop and cancel',
  customAnswerPlaceholder: 'Type your own answer…',
  customAnswerLabel: 'Your own answer',
  submitAnswer: 'Submit answer',
  answerFailed: 'Could not send your answer',
  allowPrefix: 'Allow',
  allowSuffix: '?',
  thisAction: 'this action',
  deny: 'Deny',
  always: 'Always',
  allowOnce: 'Allow once',
  decisionFailed: 'Could not send your decision',
  sendFailedBilling: 'This session is out of credit',
  sendFailedRuntimeNotReady: 'The runtime is still starting',
  sendFailedRuntimeError: 'The agent could not run that',
  sendFailedModel: (provider) => `The ${provider} model failed`,
  sendFailed: 'Your message was not sent',
  commandFailed: 'The command did not run',
  webSearchFailed: (error) => `Web search failed: ${error}`,
  noResults: 'No results.',
  noMatches: 'No matches.',
  todoItems: (count) => `${count} item${count === 1 ? '' : 's'}`,
};

/**
 * Every string @kortix/ui renders by itself. Components that render copy
 * without a caller-supplied label read it from here, so a host translates
 * them once through `<UiProvider strings>`. Copy not listed here is English
 * only (MermaidRenderer's controls).
 */
export interface UiStrings {
  /** ConfirmDialog confirm button. */
  confirm: string;
  /** ConfirmDialog and TypeToConfirmDialog cancel button. */
  cancel: string;
  /** Screen-reader label of the Dialog and Sheet close button. */
  close: string;
  /** CommandDialog screen-reader title. */
  commandPaletteTitle: string;
  /** CommandDialog screen-reader description. */
  commandPaletteDescription: string;
  /** @kortix/ui/chat copy. */
  chat: ChatStrings;
}

export const defaultUiStrings: UiStrings = {
  confirm: 'Confirm',
  cancel: 'Cancel',
  close: 'Close',
  commandPaletteTitle: 'Command Palette',
  commandPaletteDescription: 'Search for a command to run...',
  chat: defaultChatStrings,
};

/** What a host passes as `strings`: any subset, `chat` included. */
export type UiStringsInput = Partial<Omit<UiStrings, 'chat'>> & { chat?: Partial<ChatStrings> };

export type UiLinkProps = React.AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string;
  ref?: React.Ref<HTMLAnchorElement>;
};
export type UiLinkComponent = React.ComponentType<UiLinkProps>;

/** Organization marks that replace the Kortix logo. Each `*_dark_url` falls back to its light mark. */
export interface UiBrand {
  /** Alt text of the replaced logo. */
  app_name?: string | null;
  /** Wide brandmark: replaces the `brandmark` logo variant. */
  logo_url?: string | null;
  /** Square symbol: replaces the `icon` logo variant. */
  icon_url?: string | null;
  logo_dark_url?: string | null;
  icon_dark_url?: string | null;
}

/**
 * A hook that returns the brand for the subtree it is called in. KortixLogo
 * calls it on every render, so the host can read its own context (apps/web
 * passes `useBranding`). It must call the same hooks on every render.
 */
export type UseUiBrand = () => UiBrand | null;

const useNoBrand: UseUiBrand = () => null;

const DefaultLink = React.forwardRef<HTMLAnchorElement, UiLinkProps>(function DefaultLink(
  props,
  ref,
) {
  return <a ref={ref} {...props} />;
});

interface UiContextValue {
  strings: UiStrings;
  link: UiLinkComponent;
  useBrand: UseUiBrand;
}

const UiContext = React.createContext<UiContextValue>({
  strings: defaultUiStrings,
  link: DefaultLink,
  useBrand: useNoBrand,
});

export function UiProvider({
  strings,
  link,
  useBrand,
  children,
}: {
  strings?: UiStringsInput;
  link?: UiLinkComponent;
  /** Default: no brand, so KortixLogo renders the Kortix marks. */
  useBrand?: UseUiBrand;
  children: React.ReactNode;
}) {
  const value = React.useMemo<UiContextValue>(
    () => ({
      strings: { ...defaultUiStrings, ...strings, chat: { ...defaultChatStrings, ...strings?.chat } },
      link: link ?? DefaultLink,
      useBrand: useBrand ?? useNoBrand,
    }),
    [strings, link, useBrand],
  );
  return <UiContext.Provider value={value}>{children}</UiContext.Provider>;
}

export function useUiStrings(): UiStrings {
  return React.useContext(UiContext).strings;
}

export function useUiLink(): UiLinkComponent {
  return React.useContext(UiContext).link;
}

/** The host's organization brand for this subtree, or null for the Kortix marks. */
export function useUiBrand(): UiBrand | null {
  return React.useContext(UiContext).useBrand();
}
