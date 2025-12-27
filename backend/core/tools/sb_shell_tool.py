import asyncio
from typing import Optional, Dict, Any
import time
from uuid import uuid4
from core.agentpress.tool import ToolResult, openapi_schema, tool_metadata
from core.sandbox.tool_base import SandboxToolsBase
from core.agentpress.thread_manager import ThreadManager
from core.tool_output_streaming_context import stream_tool_output, get_tool_output_streaming_context, get_current_tool_call_id
from core.utils.logger import logger

@tool_metadata(
    display_name="Terminal & Commands",
    description="Run commands, install packages, and execute scripts in your workspace",
    icon="Terminal",
    color="bg-gray-100 dark:bg-gray-800/50",
    is_core=True,
    weight=20,
    visible=True,
    usage_guide="""
### CLI OPERATIONS & TERMINAL COMMANDS

**EXECUTION MODES:**
1. **Synchronous Commands (blocking=true):**
   - Use for quick operations under 60 seconds
   - Commands run directly and wait for completion
   - Example: use execute_command with command "ls -l" and blocking true

2. **Asynchronous Commands (blocking=false or omit):**
   - Use for ANY command that might take longer than 60 seconds
   - Commands run in background and return immediately
   - Common use cases: Build processes, long-running data processing, background services
   - **NOTE:** DO NOT start web servers - port 8080 is already running and publicly accessible

**SESSION MANAGEMENT:**
- Each command must specify a session_name
- Use consistent session names for related commands (e.g., "build" for build commands)
- Different sessions are isolated from each other
- Sessions maintain state between commands

**COMMAND EXECUTION GUIDELINES:**
- For long-running commands: ALWAYS use `blocking=false` (or omit)
- Use proper session names for organization
- Chain commands with && for sequential execution
- Use | for piping output between commands
- Redirect output to files for long-running processes

**BEST PRACTICES:**
- Avoid commands requiring confirmation; use -y or -f flags
- Avoid commands with excessive output; save to files when necessary
- Chain multiple commands with && to minimize interruptions
- Use pipe operator to pass command outputs
- Use non-interactive `bc` for simple calculations, Python for complex math

**CLI TOOLS PREFERENCE:**
- Always prefer CLI tools over Python scripts when possible
- CLI tools are faster for: file operations, text processing, system operations, data transformation
- Use Python only when: complex logic required, CLI tools insufficient, custom processing needed
"""
)
class SandboxShellTool(SandboxToolsBase):
    """Tool for executing tasks in a Daytona sandbox with browser-use capabilities. 
    Uses sessions for maintaining state between commands and provides comprehensive process management."""

    def __init__(self, project_id: str, thread_manager: ThreadManager):
        super().__init__(project_id, thread_manager)
        self._sessions: Dict[str, str] = {}  # Maps session names to session IDs
        self._session_lock = asyncio.Lock()  # Lock for thread-safe session access

    async def _ensure_session(self, session_name: str = "default") -> str:
        """Ensure a session exists and return its ID."""
        # Check if we have a cached session ID
        if session_name in self._sessions:
            session_id = self._sessions[session_name]
            # Verify the session still exists by attempting to list sessions
            try:
                await self._ensure_sandbox()
                # Try to verify session exists - if it doesn't, create a new one
                # Note: Some Daytona versions might not have a list_sessions method,
                # so we'll just try to create a new session if the old one fails
                return session_id
            except Exception as e:
                logger.debug(f"Cached session {session_name} ({session_id}) may no longer exist: {e}")
                # Remove invalid session from cache
                del self._sessions[session_name]
        
        # Create a new session
        session_id = str(uuid4())
        try:
            await self._ensure_sandbox()  # Ensure sandbox is initialized
            await self.sandbox.process.create_session(session_id)
            self._sessions[session_name] = session_id
            logger.debug(f"Created new session: {session_name} ({session_id})")
        except Exception as e:
            raise RuntimeError(f"Failed to create session: {str(e)}")
        return self._sessions[session_name]

    async def _cleanup_session(self, session_name: str):
        """Clean up a session if it exists."""
        if session_name in self._sessions:
            session_id = self._sessions[session_name]
            try:
                await self._ensure_sandbox()  # Ensure sandbox is initialized
                await self.sandbox.process.delete_session(session_id)
                logger.debug(f"Cleaned up session: {session_name} ({session_id})")
            except Exception as e:
                logger.debug(f"Failed to cleanup session {session_name} ({session_id}): {str(e)}")
            finally:
                # Always remove from cache, even if deletion failed
                del self._sessions[session_name]

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "execute_command",
            "description": "Execute a shell command in the workspace directory. Commands can run in two modes: (1) BLOCKING (blocking=true): Command runs synchronously, waits for completion, returns full output, and automatically cleans up the session - NO need to call check_command_output afterwards. (2) NON-BLOCKING (blocking=false, default): Command runs in background tmux session - use check_command_output to monitor progress. Use blocking=true for quick commands (installs, file operations, builds). Use non-blocking for long-running processes (servers, watches). **🚨 PARAMETER NAMES**: Use EXACTLY these parameter names: `command` (REQUIRED), `folder` (optional), `session_name` (optional), `blocking` (optional), `timeout` (optional).",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "**REQUIRED** - The shell command to execute. Use this for running CLI tools, installing packages, or system operations. Commands can be chained using &&, ||, and | operators. Example: 'npm install && npm run build'"
                    },
                    "folder": {
                        "type": "string",
                        "description": "**OPTIONAL** - Relative path to a subdirectory of /workspace where the command should be executed. Example: 'data/pdfs'"
                    },
                    "session_name": {
                        "type": "string",
                        "description": "**OPTIONAL** - Name of the tmux session to use. Only relevant for NON-BLOCKING commands where you need to check output later. Ignored for blocking commands."
                    },
                    "blocking": {
                        "type": "boolean",
                        "description": "**OPTIONAL** - If true, waits for command completion and returns output directly (session auto-cleaned, do NOT call check_command_output). If false (default), runs in background tmux session (use check_command_output to monitor). Default: false.",
                        "default": False
                    },
                    "timeout": {
                        "type": "integer",
                        "description": "**OPTIONAL** - Timeout in seconds for blocking commands. Default: 60. Ignored for non-blocking commands.",
                        "default": 60
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
        folder: Optional[str] = None,
        session_name: Optional[str] = None,
        blocking: bool = False,
        timeout: int = 60
    ) -> ToolResult:
        try:
            # Ensure sandbox is initialized
            await self._ensure_sandbox()
            
            # Set up working directory
            cwd = self.workspace_path
            if folder:
                folder = folder.strip('/')
                cwd = f"{self.workspace_path}/{folder}"
            
            # Generate a session name if not provided
            if not session_name:
                session_name = f"session_{str(uuid4())[:8]}"
            
            # Check if tmux session already exists
            check_session = await self._execute_raw_command(f"tmux has-session -t {session_name} 2>/dev/null || echo 'not_exists'")
            session_exists = "not_exists" not in check_session.get("output", "")
            
            if not session_exists:
                # Create a new tmux session with the specified working directory
                await self._execute_raw_command(f"tmux new-session -d -s {session_name} -c {cwd}")
            
            # Escape double quotes for the command
            wrapped_command = command.replace('"', '\\"')
            
            if blocking:
                # Use PTY for blocking commands with real-time streaming
                tool_output_ctx = get_tool_output_streaming_context()
                # Use the actual tool_call_id from LLM, or generate fallback
                tool_call_id = get_current_tool_call_id() or f"cmd_{str(uuid4())[:8]}"
                logger.debug(f"[SHELL STREAMING] Using tool_call_id: {tool_call_id}")
                
                # Track output for streaming
                output_buffer = []
                last_streamed_len = 0
                command_completed = asyncio.Event()
                exit_code = 0
                
                async def on_pty_data(data: bytes):
                    nonlocal last_streamed_len
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
                    
                    return self.success_response({
                        "output": final_output.strip(),
                        "cwd": cwd,
                        "completed": True,
                        "exit_code": exit_code,
                        "streamed": tool_output_ctx is not None
                    })
                    
                except Exception as pty_error:
                    logger.warning(f"PTY execution failed, falling back to tmux: {pty_error}")
                    # Fall back to tmux approach
                    marker = f"COMMAND_DONE_{str(uuid4())[:8]}"
                    completion_command = self._format_completion_command(command, marker)
                    wrapped_completion_command = completion_command.replace('"', '\\"')
                    
                    await self._execute_raw_command(f'tmux send-keys -t {session_name} "{wrapped_completion_command}" Enter')
                    
                    start_time = time.time()
                    final_output = ""
                    
                    while (time.time() - start_time) < timeout:
                        await asyncio.sleep(0.5)
                        check_result = await self._execute_raw_command(f"tmux has-session -t {session_name} 2>/dev/null || echo 'ended'")
                        if "ended" in check_result.get("output", ""):
                            break
                        output_result = await self._execute_raw_command(f"tmux capture-pane -t {session_name} -p -S - -E -")
                        current_output = output_result.get("output", "")
                        if self._is_command_completed(current_output, marker):
                            final_output = current_output
                            break
                    
                    if not final_output:
                        output_result = await self._execute_raw_command(f"tmux capture-pane -t {session_name} -p -S - -E -")
                        final_output = output_result.get("output", "")
                    
                    await self._execute_raw_command(f"tmux kill-session -t {session_name}")
                    
                    return self.success_response({
                        "output": final_output,
                        "cwd": cwd,
                        "completed": True
                    })
            else:
                # Send command to tmux session for non-blocking execution
                await self._execute_raw_command(f'tmux send-keys -t {session_name} "{wrapped_command}" Enter')
                
                # For non-blocking, just return immediately
                return self.success_response({
                    "session_name": session_name,
                    "cwd": cwd,
                    "message": f"Command sent to tmux session '{session_name}'. Use check_command_output to view results.",
                    "completed": False
                })
                
        except Exception as e:
            # Attempt to clean up session in case of error
            if session_name:
                try:
                    await self._execute_raw_command(f"tmux kill-session -t {session_name}")
                except:
                    pass
            return self.fail_response(f"Error executing command: {str(e)}")

    async def _execute_raw_command(self, command: str, retry_count: int = 0) -> Dict[str, Any]:
        """Execute a raw command directly in the sandbox.
        
        Uses a per-call session to avoid race conditions when multiple commands run in parallel.
        
        Args:
            command: The command to execute
            retry_count: Internal counter for retry attempts (max 2)
        """
        # Create a unique session for this command to avoid race conditions
        session_id = f"cmd_{str(uuid4())[:8]}"
        
        # Execute command in session
        from daytona_sdk import SessionExecuteRequest
        
        try:
            await self._ensure_sandbox()
            
            # Create session
            await self.sandbox.process.create_session(session_id)
            
            req = SessionExecuteRequest(
                command=command,
                var_async=False,
                cwd=self.workspace_path
            )
            
            response = await self.sandbox.process.execute_session_command(
                session_id=session_id,
                req=req,
                timeout=30  # Short timeout for utility commands
            )
            
            logs = await self.sandbox.process.get_session_command_logs(
                session_id=session_id,
                command_id=response.cmd_id
            )
            
            # Extract the actual log content from the SessionCommandLogsResponse object
            logs_output = logs.output if logs and logs.output else ""
            
            return {
                "output": logs_output,
                "exit_code": response.exit_code
            }
            
        except Exception as e:
            # Check if this is a session-not-found error
            error_str = str(e).lower()
            error_repr = repr(e).lower()
            is_session_error = (
                "session not found" in error_str or
                "not found" in error_str or
                "session" in error_str and "not" in error_str and "found" in error_str or
                "404" in error_str or
                "session not found" in error_repr
            )
            
            # Retry up to 2 times for session errors
            if is_session_error and retry_count < 2:
                logger.warning(
                    f"Session error detected (attempt {retry_count + 1}/2): {type(e).__name__}: {e}. "
                    f"Retrying with new session..."
                )
                # Recursively retry with incremented counter
                return await self._execute_raw_command(command, retry_count + 1)
            else:
                # Either not a session error, or we've exhausted retries
                if is_session_error:
                    logger.error(
                        f"Session error persisted after {retry_count + 1} attempts. "
                        f"Error: {type(e).__name__}: {e}"
                    )
                raise
        finally:
            # Clean up the session
            try:
                await self.sandbox.process.delete_session(session_id)
            except:
                pass  # Ignore cleanup errors

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "check_command_output",
            "description": "Check the output of a NON-BLOCKING command running in a tmux session. IMPORTANT: Only use this for commands that were executed with blocking=false. Do NOT use this for blocking commands - they return output directly and clean up their session automatically.",
            "parameters": {
                "type": "object",
                "properties": {
                    "session_name": {
                        "type": "string",
                        "description": "The name of the tmux session to check. This is returned by execute_command when blocking=false."
                    },
                    "kill_session": {
                        "type": "boolean",
                        "description": "Whether to terminate the tmux session after checking. Set to true when you're done with the command.",
                        "default": False
                    }
                },
                "required": ["session_name"]
            }
        }
    })
    async def check_command_output(
        self,
        session_name: str,
        kill_session: bool = False
    ) -> ToolResult:
        try:
            # Ensure sandbox is initialized
            await self._ensure_sandbox()
            
            # Check if session exists
            check_result = await self._execute_raw_command(f"tmux has-session -t {session_name} 2>/dev/null || echo 'not_exists'")
            if "not_exists" in check_result.get("output", ""):
                return self.fail_response(f"Tmux session '{session_name}' does not exist.")
            
            # Get output from tmux pane
            output_result = await self._execute_raw_command(f"tmux capture-pane -t {session_name} -p -S - -E -")
            output = output_result.get("output", "")
            
            # Kill session if requested
            if kill_session:
                await self._execute_raw_command(f"tmux kill-session -t {session_name}")
                termination_status = "Session terminated."
            else:
                termination_status = "Session still running."
            
            return self.success_response({
                "output": output,
                "session_name": session_name,
                "status": termination_status
            })
                
        except Exception as e:
            return self.fail_response(f"Error checking command output: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "terminate_command",
            "description": "Terminate a running command by killing its tmux session.",
            "parameters": {
                "type": "object",
                "properties": {
                    "session_name": {
                        "type": "string",
                        "description": "The name of the tmux session to terminate."
                    }
                },
                "required": ["session_name"]
            }
        }
    })
    async def terminate_command(
        self,
        session_name: str
    ) -> ToolResult:
        try:
            # Ensure sandbox is initialized
            await self._ensure_sandbox()
            
            # Check if session exists
            check_result = await self._execute_raw_command(f"tmux has-session -t {session_name} 2>/dev/null || echo 'not_exists'")
            if "not_exists" in check_result.get("output", ""):
                return self.fail_response(f"Tmux session '{session_name}' does not exist.")
            
            # Kill the session
            await self._execute_raw_command(f"tmux kill-session -t {session_name}")
            
            return self.success_response({
                "message": f"Tmux session '{session_name}' terminated successfully."
            })
                
        except Exception as e:
            return self.fail_response(f"Error terminating command: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "list_commands",
            "description": "List all running tmux sessions and their status.",
            "parameters": {
                "type": "object",
                "properties": {}
            }
        }
    })
    async def list_commands(self) -> ToolResult:
        try:
            # Ensure sandbox is initialized
            await self._ensure_sandbox()
            
            # List all tmux sessions
            result = await self._execute_raw_command("tmux list-sessions 2>/dev/null || echo 'No sessions'")
            output = result.get("output", "")
            
            if "No sessions" in output or not output.strip():
                return self.success_response({
                    "message": "No active tmux sessions found.",
                    "sessions": []
                })
            
            # Parse session list
            sessions = []
            for line in output.split('\n'):
                if line.strip():
                    parts = line.split(':')
                    if parts:
                        session_name = parts[0].strip()
                        sessions.append(session_name)
            
            return self.success_response({
                "message": f"Found {len(sessions)} active sessions.",
                "sessions": sessions
            })
                
        except Exception as e:
            return self.fail_response(f"Error listing commands: {str(e)}")

    def _format_completion_command(self, command: str, marker: str) -> str:
        """Format command with completion marker, handling heredocs properly."""
        import re
        
        # Check if command contains heredoc syntax
        # Look for patterns like: << EOF, << 'EOF', << "EOF", <<EOF
        heredoc_pattern = r'<<\s*[\'"]?\w+[\'"]?'
        
        if re.search(heredoc_pattern, command):
            # For heredoc commands, add the completion marker on a new line
            # This ensures it executes after the heredoc completes
            return f"{command}\necho {marker}"
        else:
            # For regular commands, use semicolon separator
            return f"{command} ; echo {marker}"

    def _is_command_completed(self, current_output: str, marker: str) -> bool:
        """
        Check if command execution is completed by comparing marker from end to start.
        
        Args:
            current_output: Current output content
            marker: Completion marker
            
        Returns:
            bool: True if command completed, False otherwise
        """
        if not current_output or not marker:
            return False

        # Find the last complete marker match position to start comparison
        # Avoid terminal prompt output at the end
        marker_end_pos = -1
        for i in range(len(current_output) - len(marker), -1, -1):
            if current_output[i:i+len(marker)] == marker:
                marker_end_pos = i + len(marker) - 1
                break
        
        # Start comparison from found marker position or end of output
        if marker_end_pos != -1:
            output_idx = marker_end_pos
            marker_idx = len(marker) - 1
        else:
            output_idx = len(current_output) - 1
            marker_idx = len(marker) - 1
        
        # Compare characters from end to start
        while marker_idx >= 0 and output_idx >= 0:
            # Skip newlines in current_output
            if current_output[output_idx] == '\n':
                output_idx -= 1
                continue
                
            # Compare characters
            if current_output[output_idx] != marker[marker_idx]:
                return False
                
            # Continue comparison
            output_idx -= 1
            marker_idx -= 1
        
        # If marker not fully matched
        if marker_idx >= 0:
            return False
            
        # Check if preceded by "echo " (command just started)
        check_count = 0
        echo_chars = "echo "
        echo_idx = len(echo_chars) - 1
        
        while output_idx >= 0 and check_count < 5:
            # Skip newlines
            if current_output[output_idx] == '\n':
                output_idx -= 1
                continue
                
            check_count += 1
            
            # Check for "echo " pattern
            if echo_idx >= 0 and current_output[output_idx] == echo_chars[echo_idx]:
                echo_idx -= 1
            else:
                echo_idx = len(echo_chars) - 1
                
            output_idx -= 1
            
        # If "echo " found, command just started
        if echo_idx < 0:
            return False
            
        return True

    async def cleanup(self):
        """Clean up all sessions."""
        # Only cleanup if we actually have a sandbox - don't create one during cleanup
        if self._sandbox is None:
            return
        
        for session_name in list(self._sessions.keys()):
            await self._cleanup_session(session_name)
        
        # Also clean up any tmux sessions
        try:
            await self._execute_raw_command("tmux kill-server 2>/dev/null || true")
        except:
            pass