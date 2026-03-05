import asyncio
from typing import Optional, Dict, Any
import time
from uuid import uuid4
from core.agentpress.tool import ToolResult, openapi_schema, tool_metadata
from core.sandbox.tool_base import SandboxToolsBase
from core.agentpress.thread_manager import ThreadManager
from core.utils.tool_output_streaming import stream_tool_output, get_tool_output_streaming_context, get_current_tool_call_id
from core.utils.logger import logger

@tool_metadata(
    display_name="Bash",
    description="Execute bash commands in the workspace with optional timeout",
    icon="Terminal",
    color="bg-gray-100 dark:bg-gray-800/50",
    is_core=True,
    weight=20,
    visible=True,
    usage_guide="""
## Bash - Execute bash commands in the workspace

Executes bash commands in the workspace directory with real-time output streaming. Working directory persists between commands.

IMPORTANT: This tool is for terminal operations like git, npm, docker, etc. DO NOT use it for file operations (reading, writing, editing, searching, finding files) - use the specialized tools for this instead.

### Before Executing Commands

1. **Directory Verification:**
   - If the command will create new directories or files, first use `ls` to verify the parent directory exists
   - Example: before running "mkdir foo/bar", first use `ls foo` to check that "foo" exists

2. **Command Execution:**
   - Always quote file paths that contain spaces with double quotes
   - Example: cd "/workspace/my folder" (correct) vs cd /workspace/my folder (incorrect)

### When to Use
- Installing packages (pip install, npm install, apt-get)
- Running build commands and scripts
- Git operations (status, diff, log, add, commit)
- Running tests or linters
- System administration tasks
- Any task requiring shell execution

### When NOT to Use
- DO NOT use cat/head/tail to read files - use read_file instead
- DO NOT use sed/awk to edit files - use edit_file or str_replace instead
- DO NOT use echo/heredoc to create files - use create_file instead
- DO NOT use find for file search - use Glob patterns instead
- DO NOT use grep for content search - use search_file instead

### Important Notes
- Commands timeout after 300 seconds (5 minutes) by default
- Output is truncated if it exceeds 50000 characters
- Working directory is /workspace by default
- Use ABSOLUTE paths in commands (e.g., /workspace/src/main.py)
- Always use non-interactive flags (-y, --yes, -f) to avoid prompts

### Multiple Commands
- If commands are independent and can run in parallel, make multiple tool calls
- If commands depend on each other, chain with && (e.g., `git add . && git commit -m "message"`)
- Use `;` only when you need to run commands sequentially but don't care if earlier commands fail
- Try to maintain your current working directory by using absolute paths and avoiding `cd`

### Long-Running Processes
For background processes (servers, watches), use tmux:
```bash
# Start background server
tmux new-session -d -s myserver 'npm run dev'

# Check on process
tmux capture-pane -t myserver -p

# Kill process
tmux kill-session -t myserver
```

### Git Operations
- NEVER use git commands with -i flag (interactive mode not supported)
- NEVER use --amend unless explicitly requested
- NEVER force push to main/master
- When committing, use HEREDOC for multiline messages

### Port 8080
Port 8080 is AUTO-EXPOSED and publicly accessible. Files served from /workspace are automatically available via preview URLs.
"""
)
class SandboxShellTool(SandboxToolsBase):
    """Tool for executing shell commands in a Daytona sandbox.
    Commands run synchronously with real-time output streaming.
    For long-running processes, use tmux directly in your commands."""

    def __init__(self, project_id: str, thread_manager: ThreadManager):
        super().__init__(project_id, thread_manager)

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "execute_command",
            "description": """Execute a bash command in the workspace directory with optional timeout.

IMPORTANT: This tool is for terminal operations like git, npm, docker, etc. DO NOT use it for file operations (reading, writing, editing, searching, finding files) - use the specialized tools for this instead.

Before executing the command:
1. If the command creates new directories/files, first verify the parent directory exists using `ls`
2. Always quote file paths that contain spaces with double quotes

Usage notes:
- Commands timeout after 300 seconds by default (max 600 seconds / 10 minutes)
- Output is truncated if it exceeds 50000 characters
- For long-running processes, use tmux: `tmux new-session -d -s name 'command'`
- Chain dependent commands with && (e.g., `git add . && git commit -m "message"`)
- Avoid using cat, head, tail, sed, awk, echo, find, grep - use dedicated tools instead""",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "**REQUIRED** - The bash command to execute. Commands run synchronously and wait for completion."
                    },
                    "description": {
                        "type": "string",
                        "description": "**OPTIONAL** - Clear, concise description of what this command does. For simple commands (git, npm), keep it brief (5-10 words). For complex commands (piped commands, obscure flags), add enough context to clarify what it does."
                    },
                    "folder": {
                        "type": "string",
                        "description": "**OPTIONAL** - Relative path to a subdirectory of /workspace where the command should be executed. Example: 'src/data'"
                    },
                    "timeout": {
                        "type": "integer",
                        "description": "**OPTIONAL** - Timeout in seconds (max 600). Default: 300 (5 minutes). Increase for longer operations.",
                        "default": 300
                    }
                },
                "required": ["command"],
                "additionalProperties": False
            }
        }
    })
    async def execute_command(
        self,
        command: str,
        description: Optional[str] = None,
        folder: Optional[str] = None,
        timeout: int = 300
    ) -> ToolResult:
        try:
            # Ensure sandbox is initialized
            await self._ensure_sandbox()
            
            # Set up working directory
            cwd = self.workspace_path
            if folder:
                folder = folder.strip('/')
                cwd = f"{self.workspace_path}/{folder}"
            
            # Use PTY for real-time streaming
            tool_output_ctx = get_tool_output_streaming_context()
            tool_call_id = get_current_tool_call_id() or f"cmd_{str(uuid4())[:8]}"
            logger.debug(f"[SHELL STREAMING] Using tool_call_id: {tool_call_id}")
            
            # Track output for streaming
            output_buffer = []
            exit_code = 0
            
            async def on_pty_data(data: bytes):
                try:
                    text = data.decode("utf-8", errors="replace")
                    output_buffer.append(text)
                    
                    # Stream output to frontend if we have a tool output streaming context
                    if tool_output_ctx:
                        await stream_tool_output(
                            tool_call_id=tool_call_id,
                            output_chunk=text,
                            is_final=False,
                            tool_name="execute_command"
                        )
                except Exception as e:
                    logger.warning(f"Error processing PTY output: {e}")
            
            try:
                from daytona_sdk.common.pty import PtySize
                
                pty_session_id = f"cmd-{str(uuid4())[:8]}"
                
                # Create PTY session with output callback
                pty_handle = await self.sandbox.process.create_pty_session(
                    id=pty_session_id,
                    on_data=on_pty_data,
                    pty_size=PtySize(cols=120, rows=40)
                )
                
                # Always cd to workspace directory since PTY starts in container's WORKDIR (/app)
                await pty_handle.send_input(f"cd {cwd}\n")
                await asyncio.sleep(0.1)
                
                # Add marker to detect completion
                marker = f"__CMD_DONE_{str(uuid4())[:8]}__"
                
                # Check if command contains a heredoc - if so, we need the marker on a new line
                # Heredocs require the delimiter (EOF, etc.) to be on its own line
                # Common heredoc patterns: << EOF, << 'EOF', << "EOF", <<- EOF, <<-'EOF', etc.
                import re
                heredoc_pattern = r'<<-?\s*[\'"]?\w+[\'"]?\s*$'
                if re.search(heredoc_pattern, command, re.MULTILINE):
                    # Command has heredoc - put marker on a separate line
                    full_command = f"{command}\necho '{marker}' $?\n"
                else:
                    full_command = f"{command}; echo '{marker}' $?\n"
                
                # Send the command
                await pty_handle.send_input(full_command)
                
                # Wait for completion or timeout
                # Note: marker appears TWICE in output:
                # 1. When the terminal echoes the typed command
                # 2. When the echo command actually executes after completion
                # We need to wait for the SECOND occurrence
                start_time = time.time()
                while (time.time() - start_time) < timeout:
                    await asyncio.sleep(0.1)
                    
                    # Check if marker appeared in output (need 2 occurrences)
                    current_output = "".join(output_buffer)
                    marker_count = current_output.count(marker)
                    if marker_count >= 2:
                        # Extract exit code from the LAST marker line (the actual output)
                        try:
                            marker_idx = current_output.rfind(marker)
                            after_marker = current_output[marker_idx + len(marker):].strip().split()[0]
                            exit_code = int(after_marker) if after_marker.isdigit() else 0
                        except:
                            exit_code = 0
                        break
                else:
                    # Timeout reached
                    exit_code = -1
                
                # Kill PTY session
                try:
                    await pty_handle.kill()
                except:
                    pass
                
                # Clean output (remove marker line and control sequences)
                final_output = "".join(output_buffer)
                
                # Remove the marker line from output
                if marker in final_output:
                    marker_idx = final_output.rfind(marker)
                    # Find the start of the line containing the marker
                    line_start = final_output.rfind('\n', 0, marker_idx)
                    if line_start != -1:
                        final_output = final_output[:line_start]
                
                # Strip ANSI escape sequences for cleaner output
                import re
                ansi_escape = re.compile(r'\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])')
                final_output = ansi_escape.sub('', final_output)
                
                # Stream final message
                if tool_output_ctx:
                    await stream_tool_output(
                        tool_call_id=tool_call_id,
                        output_chunk="",
                        is_final=True,
                        tool_name="execute_command"
                    )
                
                if exit_code == -1:
                    return self.success_response({
                        "output": final_output.strip(),
                        "cwd": cwd,
                        "exit_code": exit_code,
                        "timeout": True,
                        "message": f"Command timed out after {timeout} seconds. For long-running processes, use tmux: `tmux new-session -d -s name 'command'`"
                    })
                
                return self.success_response({
                    "output": final_output.strip(),
                    "cwd": cwd,
                    "exit_code": exit_code
                })
                
            except Exception as pty_error:
                logger.warning(f"PTY execution failed, falling back to direct execution: {pty_error}")
                # Fall back to direct session execution
                return await self._fallback_execute(command, cwd, timeout)
                
        except Exception as e:
            return self.fail_response(f"Error executing command: {str(e)}")

    async def _fallback_execute(self, command: str, cwd: str, timeout: int) -> ToolResult:
        """Fallback execution method using direct session commands."""
        try:
            from daytona_sdk import SessionExecuteRequest
            
            session_id = f"cmd_{str(uuid4())[:8]}"
            await self.sandbox.process.create_session(session_id)
            
            try:
                req = SessionExecuteRequest(
                    command=command,
                    var_async=False,
                    cwd=cwd
                )
                
                response = await self.sandbox.process.execute_session_command(
                    session_id=session_id,
                    req=req,
                    timeout=timeout
                )
                
                logs = await self.sandbox.process.get_session_command_logs(
                    session_id=session_id,
                    command_id=response.cmd_id
                )
                
                logs_output = logs.output if logs and logs.output else ""
                
                return self.success_response({
                    "output": logs_output,
                    "cwd": cwd,
                    "exit_code": response.exit_code
                })
            finally:
                try:
                    await self.sandbox.process.delete_session(session_id)
                except:
                    pass
                    
        except Exception as e:
            return self.fail_response(f"Error executing command: {str(e)}")

    async def _execute_raw_command(self, command: str, retry_count: int = 0) -> Dict[str, Any]:
        """Execute a raw command directly in the sandbox.
        
        Uses a per-call session to avoid race conditions when multiple commands run in parallel.
        
        Args:
            command: The command to execute
            retry_count: Internal counter for retry attempts (max 2)
        """
        session_id = f"cmd_{str(uuid4())[:8]}"
        
        from daytona_sdk import SessionExecuteRequest
        
        try:
            await self._ensure_sandbox()
            await self.sandbox.process.create_session(session_id)
            
            req = SessionExecuteRequest(
                command=command,
                var_async=False,
                cwd=self.workspace_path
            )
            
            response = await self.sandbox.process.execute_session_command(
                session_id=session_id,
                req=req,
                timeout=30
            )
            
            logs = await self.sandbox.process.get_session_command_logs(
                session_id=session_id,
                command_id=response.cmd_id
            )
            
            logs_output = logs.output if logs and logs.output else ""
            
            return {
                "output": logs_output,
                "exit_code": response.exit_code
            }
            
        except Exception as e:
            error_str = str(e).lower()
            error_repr = repr(e).lower()
            is_session_error = (
                "session not found" in error_str or
                "not found" in error_str or
                "session" in error_str and "not" in error_str and "found" in error_str or
                "404" in error_str or
                "session not found" in error_repr
            )
            
            if is_session_error and retry_count < 2:
                logger.warning(
                    f"Session error detected (attempt {retry_count + 1}/2): {type(e).__name__}: {e}. "
                    f"Retrying with new session..."
                )
                return await self._execute_raw_command(command, retry_count + 1)
            else:
                if is_session_error:
                    logger.error(
                        f"Session error persisted after {retry_count + 1} attempts. "
                        f"Error: {type(e).__name__}: {e}"
                    )
                raise
        finally:
            try:
                await self.sandbox.process.delete_session(session_id)
            except:
                pass

    async def cleanup(self):
        """Clean up resources."""
        pass
