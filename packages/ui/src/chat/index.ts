/**
 * @kortix/ui/chat — the session thread plus two standalone pickers.
 *
 *   const session = useSession(projectId, sessionId);
 *   return <SessionThread session={session} />;
 *
 * `SessionThread` is the one thread implementation (`@kortix/ui/session`, the
 * thread apps/web renders). Its building blocks live in `@kortix/ui/session`.
 * `ModelPicker` and `AgentPicker` are controlled pickers over a plain list,
 * for a form outside a session (a new-session form).
 */
export { AgentPicker } from './agent-picker';
export { filterModels, ModelPicker } from './model-picker';
export { SessionThread, type SessionThreadProps } from '../session/session-thread';
