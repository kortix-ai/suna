import os
import uuid
import shlex
import structlog
from datetime import datetime
from typing import Optional

from core.agentpress.tool import ToolResult, openapi_schema, tool_metadata
from core.sandbox.tool_base import SandboxToolsBase
from core.agentpress.thread_manager import ThreadManager
from core.utils.logger import logger
from daytona_sdk import SessionExecuteRequest

GIT_AGENT_COMMIT_GUIDELINES = """
You are working in a local-only git repository inside a sandbox workspace (/workspace).

High-level rules:
1. When to commit
   - Commit only after a coherent, meaningful unit of work is finished:
     - A feature slice
     - A bugfix
     - A refactor that leaves the code in a stable state
   - Do NOT commit tiny mechanical edits unless they form a logical step on their own.
   - Avoid committing while the project is in a knowingly broken state unless explicitly required.

2. Grouping changes
   - Group all files that must change together to keep the project consistent.
   - If reverting your commit would leave the project broken, your commit boundaries are wrong.
   - Include all dependent files:
     - Code + tests
     - Config + code that depends on it
     - Content + assets that must exist together

3. Safety before commit
   - Prefer to run relevant checks if available:
     - Unit tests
     - Linters
     - Type-checkers
   - If checks fail and the failure is due to your change, fix it before committing.
   - If you must commit with failing checks, clearly mark this in the commit message (e.g. 'WIP: ...').

4. Commit message style
   - Be concise but meaningful; answer “what changed” and “why” at a glance.
   - Use present tense, imperative:
     - "Fix crash when saving empty document"
     - "Refactor auth middleware for token refresh"
     - "Add markdown export for reports"
   - Prefer including the main artifact or concern in the subject:
     - "api: validate payload in /users endpoint"
     - "ui: add error state to login form"

5. Revertability
   - Each commit should be revertable without leaving the repo in an obviously broken or incomplete state.
   - Avoid cross-commit hidden dependencies (e.g. one commit introduces a call, the next introduces the implementation).
   - If your change is inherently large, break it into smaller, individually coherent commits.

6. Tool usage
   - Only call the git commit tool when:
     - You’ve finished a meaningful chunk of work.
     - The workspace is in a consistent state that can safely become a restore point.
   - Always provide a good commit message that summarizes the change at a high level.
"""

@tool_metadata(
    display_name="Local Git Commit",
    description="Create a local git commit in the sandbox workspace (/workspace). No remotes or origins are used.",
    icon="GitCommit",
    color="bg-slate-100 dark:bg-slate-800/50",
    weight=240,
    visible=True
)
class SandboxGitTool(SandboxToolsBase):
    """
    Local-only git helper for the sandbox workspace.

    - Works only inside /workspace.
    - Automatically initializes git if needed.
    - Commits all current changes in the working tree.
    - Does NOT interact with any remote/origin.
    """

    def __init__(self, project_id: str, thread_manager: ThreadManager):
        super().__init__(project_id, thread_manager)
        from core.utils.db_helpers import get_initialized_db
        self.db = get_initialized_db()
        self._git_initialized = False
        self._log = structlog.get_logger(__name__).bind(tool="SandboxGitTool")

    async def _ensure_git_repo(self) -> None:
        """
        Ensure /workspace is a git repo and has basic local-only configuration.
        Does nothing if .git already exists.
        """
        await self._ensure_sandbox()

        if self._git_initialized:
            return

        user_name = os.getenv("GIT_LOCAL_USER_NAME", "Suna Agent")
        user_email = os.getenv("GIT_LOCAL_USER_EMAIL", "agent@suna.local")

        workspace = self.workspace_path
        cmd = (
            f"cd {shlex.quote(workspace)} && "
            f"if [ ! -d .git ]; then "
            f"git init && "
            f"git config user.name {shlex.quote(user_name)} && "
            f"git config user.email {shlex.quote(user_email)}; "
            f"fi"
        )

        try:
            self._log.debug("Ensuring git repo exists", workspace=workspace)
            await self._run_shell(cmd)
            self._git_initialized = True
        except Exception as e:
            logger.error(f"Failed to initialize local git repo in sandbox: {str(e)}")
            raise

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "git_commit",
            "description": (
                "Create a local git commit for all current changes in the sandbox workspace (/workspace). "
                "Automatically initializes git if needed. Does not push to any remote."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "message": {
                        "type": "string",
                        "description": (
                            "Concise, meaningful commit message summarizing the completed unit of work. "
                            "Example: 'Fix crash when saving empty document'."
                        )
                    },
                    "allow_empty": {
                        "type": "boolean",
                        "description": (
                            "If true, allow creating an empty commit even when there are no changes. "
                            "Use rarely (e.g., to mark checkpoints)."
                        ),
                        "default": False
                    }
                },
                "required": ["message"]
            }
        }
    })
    async def git_commit(
        self,
        message: str,
        allow_empty: bool = False
    ) -> ToolResult:
        """
        Commit all current changes in /workspace to the local git repository.
        No remotes or origins are used.
        """
        try:
            await self._ensure_git_repo()

            workspace = self.workspace_path

            # 1) Capture git status to see what will be committed
            status_tmp = f"/tmp/git_status_{uuid.uuid4().hex}"
            status_cmd = (
                f"cd {shlex.quote(workspace)} && "
                f"git status --porcelain > {shlex.quote(status_tmp)}"
            )

            try:
                await self._run_shell(status_cmd)
                status_bytes = await self.sandbox.fs.download_file(status_tmp)
            finally:
                try:
                    await self.sandbox.fs.delete_file(status_tmp)
                except Exception:
                    pass

            status_text = status_bytes.decode("utf-8", errors="ignore")
            changed_lines = [
                line for line in status_text.splitlines()
                if line.strip()
            ]

            if not changed_lines and not allow_empty:
                return self.fail_response(
                    "No changes to commit in /workspace. "
                    "Modify files before calling git_commit, or set allow_empty=true explicitly."
                )

            # 2) Run git add + commit
            commit_cmd = (
                f"cd {shlex.quote(workspace)} && "
                f"git add -A && "
                f"git commit {'--allow-empty ' if allow_empty else ''}-m {shlex.quote(message)}"
            )

            self._log.debug(
                "Creating local git commit",
                workspace=workspace,
                allow_empty=allow_empty,
                changed_files=len(changed_lines)
            )

            try:
                await self._run_shell(commit_cmd)
            except Exception as e:
                logger.error(f"git commit failed in sandbox: {str(e)}")
                return self.fail_response(f"git commit failed: {str(e)}")

            # 3) Get new commit hash
            hash_tmp = f"/tmp/git_hash_{uuid.uuid4().hex}"
            hash_cmd = (
                f"cd {shlex.quote(workspace)} && "
                f"git rev-parse HEAD > {shlex.quote(hash_tmp)}"
            )

            try:
                await self._run_shell(hash_cmd)
                hash_bytes = await self.sandbox.fs.download_file(hash_tmp)
            finally:
                try:
                    await self.sandbox.fs.delete_file(hash_tmp)
                except Exception:
                    pass

            commit_hash = hash_bytes.decode("utf-8", errors="ignore").strip()

            # Format a human-friendly message with some status context
            changed_files_preview = []
            for line in changed_lines[:10]:
                # git status --porcelain: XY<space>path
                path_part = line[3:].strip() if len(line) > 3 else line.strip()
                changed_files_preview.append(path_part)

            more_count = max(0, len(changed_lines) - len(changed_files_preview))

            msg_lines = [
                f"✅ Local git commit created in /workspace",
                f"🔑 Commit hash: {commit_hash}",
                f"📝 Message: {message}",
                f"📂 Files changed: {len(changed_lines)}",
            ]

            if changed_files_preview:
                msg_lines.append("📄 Sample of changed files:")
                for p in changed_files_preview:
                    msg_lines.append(f"  • {p}")
                if more_count > 0:
                    msg_lines.append(f"  … and {more_count} more file(s)")

            msg_lines.append("")
            msg_lines.append("📌 This commit is local-only. No remotes/origins are used.")

            return self.success_response("\n".join(msg_lines))

        except Exception as e:
            logger.error(f"Unexpected error in git_commit: {str(e)}")
            return self.fail_response(f"Unexpected error during git commit: {str(e)}")

    async def _run_shell(self, cmd: str) -> None:
        """Run a shell command inside the sandbox using Daytona process session APIs."""
        await self._ensure_sandbox()

        session_id = f"session_{uuid.uuid4().hex}"
        try:
            # Create a session and execute the command synchronously
            await self.sandbox.process.create_session(session_id)
            request = SessionExecuteRequest(command=f"bash -lc {shlex.quote(cmd)}", var_async=False)
            await self.sandbox.process.execute_session_command(session_id, request)
        except Exception as e:
            logger.error(f"Error executing shell command in sandbox session: {str(e)}")
            raise
        finally:
            # Best-effort cleanup of the session (if supported)
            try:
                if hasattr(self.sandbox.process, 'delete_session'):
                    await self.sandbox.process.delete_session(session_id)
            except Exception:
                pass
