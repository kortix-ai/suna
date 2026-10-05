/**
 * Tool renderers for agents, tasks and sessions: task, todowrite, task_*, agent_*, session_*.
 * Import each `<name>-tool.tsx` here; the file registers itself with `ToolRegistry`.
 * Mirrors the agents/tasks/sessions imports of apps/web `tool/tools/register.ts`.
 */
import './task-tool';
import './todo-write-tool';
import './task-list-tool';
import './task-delete-tool';
import './task-done-tool';
import './agent-spawn-tool';
import './agent-status-tool';
import './agent-message-tool';
import './agent-stop-tool';
import './agent-task-update-tool';
import './session-spawn-tool';
import './session-get-tool';
import './session-list-background-tool';
import './session-message-tool';
import './session-read-tool';
import './session-search-tool';
import './session-stats-tool';
import './session-lineage-tool';
