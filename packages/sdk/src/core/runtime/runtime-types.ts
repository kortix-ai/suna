/**
 * The types of the runtime surfaces this SDK still reads through the
 * session runtime's REST compatibility routes (sessions, agents, commands,
 * config, providers, MCP, projects, worktrees, pty) and of the runtime event
 * stream.
 *
 * The declarations below the aliases are copied from `@opencode-ai/sdk`
 * 1.18.23 and frozen: this package no longer depends on that one, so an
 * OpenCode upgrade cannot change what it publishes. They go when the
 * compatibility routes do.
 *
 * The transcript is Kortix's own format (`transcript-types.ts`,
 * `kortix.transcript.v1`). The names this SDK published for it before v1 are
 * the aliases right below.
 */
import type {
  KortixAbortedError,
  KortixAgentPart,
  KortixApiError,
  KortixAssistantMessageInfo,
  KortixCompactionPart,
  KortixContentFilterError,
  KortixContextOverflowError,
  KortixFileDiff,
  KortixFilePart,
  KortixFilePartSource,
  KortixFilePartSourceText,
  KortixMessageInfo,
  KortixOutputLengthError,
  KortixPart,
  KortixPatchPart,
  KortixProviderAuthError,
  KortixReasoningPart,
  KortixRetryPart,
  KortixSessionStatus,
  KortixSnapshotPart,
  KortixStepFinishPart,
  KortixStepStartPart,
  KortixStructuredOutputError,
  KortixSubtaskPart,
  KortixTextPart,
  KortixTodo,
  KortixToolPart,
  KortixToolState,
  KortixToolStateCompleted,
  KortixToolStateError,
  KortixToolStatePending,
  KortixToolStateRunning,
  KortixUnknownError,
  KortixUserMessageInfo,
  RuntimePermissionRequest,
  RuntimeQuestion,
  RuntimeQuestionAnswer,
  RuntimeQuestionOption,
  RuntimeQuestionRequest,
  RuntimeToolRef,
} from './transcript-types';

// ─── Transcript names published before kortix.transcript.v1 ─────────────────

/** A message's `info`: the user or assistant half of `{ info, parts }`. */
export type Message = KortixMessageInfo;
export type UserMessage = KortixUserMessageInfo;
export type AssistantMessage = KortixAssistantMessageInfo;
export type Part = KortixPart;
export type TextPart = KortixTextPart;
export type SubtaskPart = KortixSubtaskPart;
export type ReasoningPart = KortixReasoningPart;
export type FilePart = KortixFilePart;
export type FilePartSource = KortixFilePartSource;
export type FilePartSourceText = KortixFilePartSourceText;
export type ToolPart = KortixToolPart;
export type ToolState = KortixToolState;
export type ToolStatePending = KortixToolStatePending;
export type ToolStateRunning = KortixToolStateRunning;
export type ToolStateCompleted = KortixToolStateCompleted;
export type ToolStateError = KortixToolStateError;
export type StepStartPart = KortixStepStartPart;
export type StepFinishPart = KortixStepFinishPart;
export type SnapshotPart = KortixSnapshotPart;
export type PatchPart = KortixPatchPart;
export type AgentPart = KortixAgentPart;
export type RetryPart = KortixRetryPart;
export type CompactionPart = KortixCompactionPart;
export type SnapshotFileDiff = KortixFileDiff;
export type SessionStatus = KortixSessionStatus;
export type PermissionRequest = RuntimePermissionRequest;
export type QuestionRequest = RuntimeQuestionRequest;
export type QuestionInfo = RuntimeQuestion;
export type QuestionOption = RuntimeQuestionOption;
export type QuestionAnswer = RuntimeQuestionAnswer;
export type QuestionTool = RuntimeToolRef;
export type Todo = KortixTodo;
export type ProviderAuthError = KortixProviderAuthError;
export type UnknownError = KortixUnknownError;
export type MessageOutputLengthError = KortixOutputLengthError;
export type MessageAbortedError = KortixAbortedError;
export type StructuredOutputError = KortixStructuredOutputError;
export type ContextOverflowError = KortixContextOverflowError;
export type ContentFilterError = KortixContentFilterError;
/** Not exported: `ApiError` is this SDK's HTTP error class. */
type ApiError = KortixApiError;

// ─── The runtime event stream ────────────────────────────────────────────────

/**
 * An event the session runtime streams: the Kortix session events
 * (`KortixSessionEvent`) and the harness events this SDK handles (session
 * tree, diffs, pty, lsp, vcs, worktrees). `id` is the stream position.
 */
export type Event =
  | EventServerInstanceDisposed
  | EventSessionCreated
  | EventSessionUpdated
  | EventSessionDeleted
  | EventMessageUpdated
  | EventMessageRemoved
  | EventMessagePartUpdated
  | EventMessagePartRemoved
  | EventSessionNextRevertStaged
  | EventSessionNextRevertCleared
  | EventSessionNextRevertCommitted
  | EventMessagePartDelta
  | EventSessionDiff
  | EventSessionError
  | EventInstallationUpdated
  | EventInstallationUpdateAvailable
  | EventFileEdited
  | EventPtyCreated
  | EventPtyUpdated
  | EventPtyExited
  | EventPtyDeleted
  | EventTodoUpdated
  | EventLspUpdated
  | EventPermissionAsked
  | EventPermissionReplied
  | EventMcpToolsChanged
  | EventProjectUpdated
  | EventSessionStatus
  | EventSessionIdle
  | EventQuestionAsked
  | EventQuestionReplied
  | EventQuestionRejected
  | EventSessionCompacted
  | EventVcsBranchUpdated
  | EventWorktreeReady
  | EventWorktreeFailed
  | EventServerConnected;

// ─── Frozen at @opencode-ai/sdk 1.18.23 ──────────────────────────────────────

export type OAuth = {
    type: "oauth";
    refresh: string;
    access: string;
    expires: number;
    accountId?: string;
    enterpriseUrl?: string;
};
export type ApiAuth = {
    type: "api";
    key: string;
    metadata?: {
        [key: string]: string;
    };
};
export type WellKnownAuth = {
    type: "wellknown";
    key: string;
    token: string;
};
export type Auth = OAuth | ApiAuth | WellKnownAuth;
export type PermissionAction = "allow" | "deny" | "ask";
export type PermissionRule = {
    permission: string;
    pattern: string;
    action: PermissionAction;
};
export type PermissionRuleset = Array<PermissionRule>;
export type Session = {
    id: string;
    slug: string;
    projectID: string;
    workspaceID?: string;
    directory: string;
    path?: string;
    parentID?: string;
    summary?: {
        additions: number;
        deletions: number;
        files: number;
        diffs?: Array<SnapshotFileDiff>;
    };
    cost?: number;
    tokens?: {
        input: number;
        output: number;
        reasoning: number;
        cache: {
            read: number;
            write: number;
        };
    };
    share?: {
        url: string;
    };
    title: string;
    agent?: string;
    model?: {
        id: string;
        providerID: string;
        variant?: string;
    };
    version: string;
    metadata?: {
        [key: string]: unknown;
    };
    time: {
        created: number;
        updated: number;
        compacting?: number;
        archived?: number;
    };
    permission?: PermissionRuleset;
    revert?: {
        messageID: string;
        partID?: string;
        snapshot?: string;
        diff?: string;
    };
};
export type OutputFormatText = {
    type: "text";
};
export type JsonSchema = {
    [key: string]: unknown;
};
export type OutputFormatJsonSchema = {
    type: "json_schema";
    schema: JsonSchema;
    retryCount?: number;
};
export type OutputFormat = OutputFormatText | OutputFormatJsonSchema;
export type Pty = {
    id: string;
    title: string;
    command: string;
    args: Array<string>;
    cwd: string;
    status: "running" | "exited";
    pid: number;
    exitCode?: number;
};
/**
 * Log level
 */
export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";
/**
 * Server configuration for opencode serve and web commands
 */
export type ServerConfig = {
    port?: number;
    hostname?: string;
    mdns?: boolean;
    mdnsDomain?: string;
    cors?: Array<string>;
};
export type PermissionActionConfig = "ask" | "allow" | "deny";
export type PermissionObjectConfig = {
    [key: string]: PermissionActionConfig;
};
export type PermissionRuleConfig = PermissionActionConfig | PermissionObjectConfig;
export type PermissionConfig = PermissionActionConfig | {
    read?: PermissionRuleConfig;
    edit?: PermissionRuleConfig;
    glob?: PermissionRuleConfig;
    grep?: PermissionRuleConfig;
    list?: PermissionRuleConfig;
    bash?: PermissionRuleConfig;
    task?: PermissionRuleConfig;
    external_directory?: PermissionRuleConfig;
    todowrite?: PermissionActionConfig;
    question?: PermissionActionConfig;
    webfetch?: PermissionActionConfig;
    websearch?: PermissionActionConfig;
    lsp?: PermissionRuleConfig;
    doom_loop?: PermissionActionConfig;
    skill?: PermissionRuleConfig;
    [key: string]: PermissionRuleConfig | PermissionActionConfig | undefined;
};
export type AgentConfig = {
    model?: string;
    variant?: string;
    temperature?: number;
    top_p?: number;
    prompt?: string;
    tools?: {
        [key: string]: boolean;
    };
    disable?: boolean;
    description?: string;
    mode?: "subagent" | "primary" | "all";
    hidden?: boolean;
    options?: {
        [key: string]: unknown;
    };
    /**
     * Hex color code (e.g., #FF5733) or theme color (e.g., primary)
     */
    color?: string | "primary" | "secondary" | "accent" | "success" | "warning" | "error" | "info";
    steps?: number;
    maxSteps?: number;
    permission?: PermissionConfig;
    [key: string]: unknown | string | number | {
        [key: string]: boolean;
    } | boolean | "subagent" | "primary" | "all" | {
        [key: string]: unknown;
    } | string | "primary" | "secondary" | "accent" | "success" | "warning" | "error" | "info" | number | PermissionConfig | undefined;
};
export type ProviderConfig = {
    api?: string;
    name?: string;
    env?: Array<string>;
    id?: string;
    npm?: string;
    whitelist?: Array<string>;
    blacklist?: Array<string>;
    options?: {
        apiKey?: string;
        baseURL?: string;
        enterpriseUrl?: string;
        setCacheKey?: boolean;
        /**
         * Timeout in milliseconds for full requests to this provider. Set to false to disable timeout.
         */
        timeout?: number | false;
        /**
         * Timeout in milliseconds to wait for response headers. Provider integrations may set defaults. Set to false to disable timeout.
         */
        headerTimeout?: number | false;
        chunkTimeout?: number;
        [key: string]: unknown | string | boolean | number | false | number | false | number | undefined;
    };
    models?: {
        [key: string]: {
            id?: string;
            name?: string;
            family?: string;
            release_date?: string;
            attachment?: boolean;
            reasoning?: boolean;
            temperature?: boolean;
            tool_call?: boolean;
            interleaved?: boolean | "reasoning" | "reasoning_content" | "reasoning_text" | string | {
                field: "reasoning" | "reasoning_content" | "reasoning_text" | string;
            };
            cost?: {
                input: number;
                output: number;
                cache_read?: number;
                cache_write?: number;
                context_over_200k?: {
                    input: number;
                    output: number;
                    cache_read?: number;
                    cache_write?: number;
                };
            };
            limit?: {
                context: number;
                input?: number;
                output: number;
            };
            modalities?: {
                input?: Array<"text" | "audio" | "image" | "video" | "pdf">;
                output?: Array<"text" | "audio" | "image" | "video" | "pdf">;
            };
            experimental?: boolean;
            status?: "alpha" | "beta" | "deprecated" | "active";
            provider?: {
                npm?: string;
                api?: string;
            };
            options?: {
                [key: string]: unknown;
            };
            headers?: {
                [key: string]: string;
            };
            /**
             * Variant-specific configuration
             */
            variants?: {
                [key: string]: {
                    disabled?: boolean;
                    [key: string]: unknown | boolean | undefined;
                };
            };
        };
    };
};
export type McpLocalConfig = {
    /**
     * Type of MCP server connection
     */
    type: "local";
    /**
     * Command and arguments to run the MCP server
     */
    command: Array<string>;
    cwd?: string;
    environment?: {
        [key: string]: string;
    };
    enabled?: boolean;
    timeout?: number;
};
export type McpOAuthConfig = {
    clientId?: string;
    clientSecret?: string;
    scope?: string;
    callbackPort?: number;
    redirectUri?: string;
};
export type McpRemoteConfig = {
    /**
     * Type of MCP server connection
     */
    type: "remote";
    /**
     * URL of the remote MCP server
     */
    url: string;
    enabled?: boolean;
    headers?: {
        [key: string]: string;
    };
    /**
     * OAuth authentication configuration for the MCP server. Set to false to disable OAuth auto-detection.
     */
    oauth?: McpOAuthConfig | false;
    timeout?: number;
};
/**
 * @deprecated Always uses stretch layout.
 */
export type LayoutConfig = "auto" | "stretch";
export type ImageAttachmentConfig = {
    auto_resize?: boolean;
    max_width?: number;
    max_height?: number;
    max_base64_bytes?: number;
};
export type AttachmentConfig = {
    image?: ImageAttachmentConfig;
};
export type Config = {
    $schema?: string;
    shell?: string;
    logLevel?: LogLevel;
    server?: ServerConfig;
    command?: {
        [key: string]: {
            template: string;
            description?: string;
            agent?: string;
            model?: string;
            variant?: string;
            subtask?: boolean;
        };
    };
    skills?: {
        paths?: Array<string>;
        urls?: Array<string>;
    };
    references?: {
        [key: string]: string | ConfigV2ReferenceGit | ConfigV2ReferenceLocal;
    };
    reference?: {
        [key: string]: string | ConfigV2ReferenceGit | ConfigV2ReferenceLocal;
    };
    watcher?: {
        ignore?: Array<string>;
    };
    snapshot?: boolean;
    plugin?: Array<string | [
        string,
        {
            [key: string]: unknown;
        }
    ]>;
    share?: "manual" | "auto" | "disabled";
    autoshare?: boolean;
    /**
     * Automatically update to the latest version. Set to true to auto-update, false to disable, or 'notify' to show update notifications
     */
    autoupdate?: boolean | "notify";
    disabled_providers?: Array<string>;
    enabled_providers?: Array<string>;
    model?: string;
    small_model?: string;
    default_agent?: string;
    subagent_depth?: number;
    username?: string;
    mode?: {
        build?: AgentConfig;
        plan?: AgentConfig;
        [key: string]: AgentConfig | undefined;
    };
    agent?: {
        plan?: AgentConfig;
        build?: AgentConfig;
        general?: AgentConfig;
        explore?: AgentConfig;
        title?: AgentConfig;
        summary?: AgentConfig;
        compaction?: AgentConfig;
        [key: string]: AgentConfig | undefined;
    };
    provider?: {
        [key: string]: ProviderConfig;
    };
    mcp?: {
        [key: string]: McpLocalConfig | McpRemoteConfig | {
            enabled: boolean;
        };
    };
    /**
     * Enable or configure formatters. Omit or set to false to disable, true to enable built-ins, or an object to enable built-ins with overrides.
     */
    formatter?: boolean | {
        [key: string]: {
            disabled?: boolean;
            command?: Array<string>;
            environment?: {
                [key: string]: string;
            };
            extensions?: Array<string>;
        };
    };
    /**
     * Enable or configure LSP servers. Omit or set to false to disable, true to enable built-ins, or an object to enable built-ins with overrides.
     */
    lsp?: boolean | {
        [key: string]: {
            disabled: true;
        } | {
            command: Array<string>;
            extensions?: Array<string>;
            disabled?: boolean;
            env?: {
                [key: string]: string;
            };
            initialization?: {
                [key: string]: unknown;
            };
        };
    };
    instructions?: Array<string>;
    layout?: LayoutConfig;
    permission?: PermissionConfig;
    tools?: {
        [key: string]: boolean;
    };
    attachment?: AttachmentConfig;
    enterprise?: {
        url?: string;
    };
    tool_output?: {
        max_lines?: number;
        max_bytes?: number;
    };
    compaction?: {
        auto?: boolean;
        prune?: boolean;
        tail_turns?: number;
        preserve_recent_tokens?: number;
        reserved?: number;
    };
    experimental?: {
        disable_paste_summary?: boolean;
        batch_tool?: boolean;
        openTelemetry?: boolean;
        primary_tools?: Array<string>;
        continue_loop_on_deny?: boolean;
        mcp_timeout?: number;
        policies?: Array<ConfigV2ExperimentalPolicy>;
    };
};
export type Model = {
    id: string;
    providerID: string;
    api: {
        id: string;
        url: string;
        npm: string;
    };
    name: string;
    family?: string;
    capabilities: {
        temperature: boolean;
        reasoning: boolean;
        attachment: boolean;
        toolcall: boolean;
        input: {
            text: boolean;
            audio: boolean;
            image: boolean;
            video: boolean;
            pdf: boolean;
        };
        output: {
            text: boolean;
            audio: boolean;
            image: boolean;
            video: boolean;
            pdf: boolean;
        };
        interleaved: boolean | {
            field: "reasoning" | "reasoning_content" | "reasoning_text" | string;
        };
    };
    cost: {
        input: number;
        output: number;
        cache: {
            read: number;
            write: number;
        };
        tiers?: Array<{
            input: number;
            output: number;
            cache: {
                read: number;
                write: number;
            };
            tier: {
                type: "context";
                size: number;
            };
        }>;
        experimentalOver200K?: {
            input: number;
            output: number;
            cache: {
                read: number;
                write: number;
            };
        };
    };
    limit: {
        context: number;
        input?: number;
        output: number;
    };
    status: "alpha" | "beta" | "deprecated" | "active";
    options: {
        [key: string]: unknown;
    };
    headers: {
        [key: string]: string;
    };
    release_date: string;
    variants?: {
        [key: string]: {
            [key: string]: unknown;
        };
    };
};
export type Provider = {
    id: string;
    name: string;
    source: "env" | "config" | "custom" | "api";
    env: Array<string>;
    key?: string;
    options: {
        [key: string]: unknown;
    };
    models: {
        [key: string]: Model;
    };
};
export type ToolListItem = {
    id: string;
    description: string;
    parameters: unknown;
};
export type ToolList = Array<ToolListItem>;
export type ToolIds = Array<string>;
export type WorktreeCreateInput = {
    name?: string;
    /**
     * Additional startup script to run after the project's start command
     */
    startCommand?: string;
};
export type Worktree = {
    name: string;
    branch?: string;
    directory: string;
};
export type WorktreeRemoveInput = {
    directory: string;
};
export type WorktreeResetInput = {
    directory: string;
};
export type FileNode = {
    name: string;
    path: string;
    absolute: string;
    type: "file" | "directory";
    ignored: boolean;
};
export type FileContent = {
    type: "text" | "binary";
    content: string;
    diff?: string;
    patch?: {
        oldFileName: string;
        newFileName: string;
        oldHeader?: string;
        newHeader?: string;
        hunks: Array<{
            oldStart: number;
            oldLines: number;
            newStart: number;
            newLines: number;
            lines: Array<string>;
        }>;
        index?: string;
    };
    encoding?: "base64";
    mimeType?: string;
};
export type Path = {
    home: string;
    state: string;
    config: string;
    worktree: string;
    directory: string;
};
export type VcsFileDiff = {
    file: string;
    patch?: string;
    additions: number;
    deletions: number;
    status?: "added" | "deleted" | "modified";
};
export type Command = {
    name: string;
    description?: string;
    agent?: string;
    model?: string;
    source?: "command" | "mcp" | "skill";
    template: string;
    subtask?: boolean;
    hints: Array<string>;
};
export type Agent = {
    name: string;
    description?: string;
    mode: "subagent" | "primary" | "all";
    native?: boolean;
    hidden?: boolean;
    topP?: number;
    temperature?: number;
    color?: string;
    permission: PermissionRuleset;
    model?: {
        modelID: string;
        providerID: string;
    };
    variant?: string;
    prompt?: string;
    options: {
        [key: string]: unknown;
    };
    steps?: number;
};
export type McpStatusConnected = {
    status: "connected";
};
export type McpStatusDisabled = {
    status: "disabled";
};
export type McpStatusFailed = {
    status: "failed";
    error: string;
};
export type McpStatusNeedsAuth = {
    status: "needs_auth";
};
export type McpStatusNeedsClientRegistration = {
    status: "needs_client_registration";
    error: string;
};
export type McpStatus = McpStatusConnected | McpStatusDisabled | McpStatusFailed | McpStatusNeedsAuth | McpStatusNeedsClientRegistration;
export type Project = {
    id: string;
    worktree: string;
    vcs?: ProjectVcs;
    name?: string;
    icon?: ProjectIcon;
    commands?: ProjectCommands;
    time: ProjectTime;
    sandboxes: Array<string>;
};
export type ProviderAuthMethod = {
    type: "oauth" | "api";
    label: string;
    prompts?: Array<{
        type: "text";
        key: string;
        message: string;
        placeholder?: string;
        when?: {
            key: string;
            op: "eq" | "neq";
            value: string;
        };
    } | {
        type: "select";
        key: string;
        message: string;
        options: Array<{
            label: string;
            value: string;
            hint?: string;
        }>;
        when?: {
            key: string;
            op: "eq" | "neq";
            value: string;
        };
    }>;
};
export type ProviderAuthAuthorization = {
    url: string;
    method: "auto" | "code";
    instructions: string;
};
export type TextPartInput = {
    id?: string;
    type: "text";
    text: string;
    synthetic?: boolean;
    ignored?: boolean;
    time?: {
        start: number;
        end?: number;
    };
    metadata?: {
        [key: string]: unknown;
    };
};
export type FilePartInput = {
    id?: string;
    type: "file";
    mime: string;
    filename?: string;
    url: string;
    source?: FilePartSource;
};
export type AgentPartInput = {
    id?: string;
    type: "agent";
    name: string;
    source?: {
        value: string;
        start: number;
        end: number;
    };
};
export type SubtaskPartInput = {
    id?: string;
    type: "subtask";
    prompt: string;
    description: string;
    agent: string;
    model?: {
        providerID: string;
        modelID: string;
    };
    command?: string;
};
export type FileDiff = {
    path: string;
    status: "added" | "modified" | "deleted";
    additions: number;
    deletions: number;
    patch: string;
};
export type RevertState = {
    messageID: string;
    partID?: string;
    snapshot?: string;
    diff?: string;
    files?: Array<FileDiff>;
};
export type ProjectVcs = "git";
export type ProjectIcon = {
    url?: string;
    override?: string;
    color?: string;
};
export type ProjectCommands = {
    /**
     * Startup script to run when creating a new workspace (worktree)
     */
    start?: string;
};
export type ProjectTime = {
    created: number;
    updated: number;
    initialized?: number;
};
export type EventServerInstanceDisposed = {
    id: string;
    type: "server.instance.disposed";
    properties: {
        directory: string;
    };
};
export type ConfigV2ReferenceGit = {
    repository: string;
    branch?: string;
    description?: string;
    hidden?: boolean;
};
export type ConfigV2ReferenceLocal = {
    path: string;
    description?: string;
    hidden?: boolean;
};
export type PolicyEffect = "allow" | "deny";
export type ConfigV2ExperimentalPolicy = {
    action: "provider.use";
    effect: PolicyEffect;
    resource: string;
};
export type EventSessionCreated = {
    id: string;
    type: "session.created";
    properties: {
        sessionID: string;
        info: Session;
    };
};
export type EventSessionUpdated = {
    id: string;
    type: "session.updated";
    properties: {
        sessionID: string;
        info: Session;
    };
};
export type EventSessionDeleted = {
    id: string;
    type: "session.deleted";
    properties: {
        sessionID: string;
        info: Session;
    };
};
export type EventMessageUpdated = {
    id: string;
    type: "message.updated";
    properties: {
        sessionID: string;
        info: Message;
    };
};
export type EventMessageRemoved = {
    id: string;
    type: "message.removed";
    properties: {
        sessionID: string;
        messageID: string;
    };
};
export type EventMessagePartUpdated = {
    id: string;
    type: "message.part.updated";
    properties: {
        sessionID: string;
        part: Part;
        time: number;
    };
};
export type EventMessagePartRemoved = {
    id: string;
    type: "message.part.removed";
    properties: {
        sessionID: string;
        messageID: string;
        partID: string;
    };
};
export type EventSessionNextRevertStaged = {
    id: string;
    type: "session.next.revert.staged";
    properties: {
        timestamp: number;
        sessionID: string;
        revert: RevertState;
    };
};
export type EventSessionNextRevertCleared = {
    id: string;
    type: "session.next.revert.cleared";
    properties: {
        timestamp: number;
        sessionID: string;
    };
};
export type EventSessionNextRevertCommitted = {
    id: string;
    type: "session.next.revert.committed";
    properties: {
        timestamp: number;
        sessionID: string;
        messageID: string;
    };
};
export type EventMessagePartDelta = {
    id: string;
    type: "message.part.delta";
    properties: {
        sessionID: string;
        messageID: string;
        partID: string;
        field: string;
        delta: string;
    };
};
export type EventSessionDiff = {
    id: string;
    type: "session.diff";
    properties: {
        sessionID: string;
        diff: Array<SnapshotFileDiff>;
    };
};
export type EventSessionError = {
    id: string;
    type: "session.error";
    properties: {
        sessionID?: string;
        error?: ProviderAuthError | UnknownError | MessageOutputLengthError | MessageAbortedError | StructuredOutputError | ContextOverflowError | ContentFilterError | ApiError;
    };
};
export type EventInstallationUpdated = {
    id: string;
    type: "installation.updated";
    properties: {
        version: string;
    };
};
export type EventInstallationUpdateAvailable = {
    id: string;
    type: "installation.update-available";
    properties: {
        version: string;
    };
};
export type EventFileEdited = {
    id: string;
    type: "file.edited";
    properties: {
        file: string;
    };
};
export type EventPtyCreated = {
    id: string;
    type: "pty.created";
    properties: {
        info: Pty;
    };
};
export type EventPtyUpdated = {
    id: string;
    type: "pty.updated";
    properties: {
        info: Pty;
    };
};
export type EventPtyExited = {
    id: string;
    type: "pty.exited";
    properties: {
        id: string;
        exitCode: number;
    };
};
export type EventPtyDeleted = {
    id: string;
    type: "pty.deleted";
    properties: {
        id: string;
    };
};
export type EventTodoUpdated = {
    id: string;
    type: "todo.updated";
    properties: {
        sessionID: string;
        todos: Array<Todo>;
    };
};
export type EventLspUpdated = {
    id: string;
    type: "lsp.updated";
    properties: {
        [key: string]: unknown;
    };
};
export type EventPermissionAsked = {
    id: string;
    type: "permission.asked";
    properties: {
        id: string;
        sessionID: string;
        permission: string;
        patterns: Array<string>;
        metadata: {
            [key: string]: unknown;
        };
        always: Array<string>;
        tool?: {
            messageID: string;
            callID: string;
        };
    };
};
export type EventPermissionReplied = {
    id: string;
    type: "permission.replied";
    properties: {
        sessionID: string;
        requestID: string;
        reply: "once" | "always" | "reject";
    };
};
export type EventMcpToolsChanged = {
    id: string;
    type: "mcp.tools.changed";
    properties: {
        server: string;
    };
};
export type EventProjectUpdated = {
    id: string;
    type: "project.updated";
    properties: {
        id: string;
        worktree: string;
        vcs?: ProjectVcs;
        name?: string;
        icon?: ProjectIcon;
        commands?: ProjectCommands;
        time: ProjectTime;
        sandboxes: Array<string>;
    };
};
export type EventSessionStatus = {
    id: string;
    type: "session.status";
    properties: {
        sessionID: string;
        status: SessionStatus;
    };
};
export type EventSessionIdle = {
    id: string;
    type: "session.idle";
    properties: {
        sessionID: string;
    };
};
export type EventQuestionAsked = {
    id: string;
    type: "question.asked";
    properties: {
        id: string;
        sessionID: string;
        /**
         * Questions to ask
         */
        questions: Array<QuestionInfo>;
        tool?: QuestionTool;
    };
};
export type EventQuestionReplied = {
    id: string;
    type: "question.replied";
    properties: {
        sessionID: string;
        requestID: string;
        answers: Array<QuestionAnswer>;
    };
};
export type EventQuestionRejected = {
    id: string;
    type: "question.rejected";
    properties: {
        sessionID: string;
        requestID: string;
    };
};
export type EventSessionCompacted = {
    id: string;
    type: "session.compacted";
    properties: {
        sessionID: string;
    };
};
export type EventVcsBranchUpdated = {
    id: string;
    type: "vcs.branch.updated";
    properties: {
        branch?: string;
    };
};
export type EventWorktreeReady = {
    id: string;
    type: "worktree.ready";
    properties: {
        name: string;
        branch?: string;
    };
};
export type EventWorktreeFailed = {
    id: string;
    type: "worktree.failed";
    properties: {
        message: string;
    };
};
export type EventServerConnected = {
    id: string;
    type: "server.connected";
    properties: {
        [key: string]: unknown;
    };
};
export type ProviderListResponses = {
    /**
     * List of providers
     */
    200: {
        all: Array<Provider>;
        default: {
            [key: string]: string;
        };
        connected: Array<string>;
    };
};
export type ProviderListResponse = ProviderListResponses[keyof ProviderListResponses];

