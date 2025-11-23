import asyncio
from typing import Optional, Dict, Any
import time
import asyncio
from uuid import uuid4
from core.agentpress.tool import ToolResult, openapi_schema, tool_metadata
from core.sandbox.tool_base import SandboxToolsBase
from core.agentpress.thread_manager import ThreadManager

@tool_metadata(
    display_name="Terminal & Commands",
    description="Run commands, install packages, and execute scripts in your workspace",
    icon="Terminal",
    color="bg-gray-100 dark:bg-gray-800/50",
    is_core=True,
    weight=20,
    visible=True
)
class SandboxShellTool(SandboxToolsBase):
    """Tool for executing tasks in a Daytona sandbox with browser-use capabilities. 
    Uses sessions for maintaining state between commands and provides comprehensive process management."""

    TOOL_INSTRUCTIONS = """### SHELL & TERMINAL OPERATIONS WORKFLOW

**CLI TOOLS PREFERENCE:**
* Always prefer CLI tools over Python scripts when possible
* CLI tools are generally faster and more efficient for:
  1. File operations and content extraction
  2. Text processing and pattern matching
  3. System operations and file management
  4. Data transformation and filtering
* Use Python only when:
  1. Complex logic is required
  2. CLI tools are insufficient
  3. Custom processing is needed
  4. Integration with other Python code is necessary
* HYBRID APPROACH: Combine Python and CLI as needed - use Python for logic and data processing, CLI for system operations and utilities

**CLI OPERATIONS BEST PRACTICES:**
- Use terminal commands for system operations, file manipulations, and quick tasks
- For command execution, you have two approaches:
  1. Synchronous Commands (blocking):
     * Use for quick operations that complete within 60 seconds
     * Commands run directly and wait for completion
     * IMPORTANT: Do not use for long-running operations as they will timeout after 60 seconds
  
  2. Asynchronous Commands (non-blocking):
     * Use `blocking="false"` (or omit `blocking`, as it defaults to false) for any command that might take longer than 60 seconds or for starting background services
     * Commands run in background and return immediately
     * Common use cases: Development servers (React, Express, etc.), build processes, long-running data processing, background services

**SESSION MANAGEMENT:**
* Each command must specify a session_name
* Use consistent session names for related commands
* Different sessions are isolated from each other
* Example: Use "build" session for build commands, "dev" for development servers
* Sessions maintain state between commands

**COMMAND EXECUTION GUIDELINES:**
* For commands that might take longer than 60 seconds, ALWAYS use `blocking="false"` (or omit `blocking`)
* Do not rely on increasing timeout for long-running commands if they are meant to run in the background
* Use proper session names for organization
* Chain commands with && for sequential execution
* Use | for piping output between commands
* Redirect output to files for long-running processes

**COMMAND BEST PRACTICES:**
- Avoid commands requiring confirmation; actively use -y or -f flags for automatic confirmation
- Avoid commands with excessive output; save to files when necessary
- Chain multiple commands with operators to minimize interruptions and improve efficiency:
  1. Use && for sequential execution: `command1 && command2 && command3`
  2. Use || for fallback execution: `command1 || command2`
  3. Use ; for unconditional execution: `command1; command2`
  4. Use | for piping output: `command1 | command2`
  5. Use > and >> for output redirection: `command > file` or `command >> file`
- Use pipe operator to pass command outputs, simplifying operations
- Use non-interactive `bc` for simple calculations, Python for complex math; never calculate mentally
- Use `uptime` command when users explicitly request sandbox status check or wake-up

**TEXT & DATA PROCESSING:**
IMPORTANT: Use the `cat` command to view contents of small files (100 kb or less). For files larger than 100 kb, use commands like `head`, `tail` to preview or read only part of the file.

- Distinguish between small and large text files:
  1. ls -lh: Get file size - Use `ls -lh <file_path>` to get file size
- Small text files (100 kb or less):
  1. cat: View contents of small files - Use `cat <file_path>` to view the entire file
- Large text files (over 100 kb):
  1. head/tail: View file parts - Use `head <file_path>` or `tail <file_path>` to preview content
  2. less: View large files interactively
  3. grep, awk, sed: For searching, extracting, or transforming data in large files
- File Analysis:
  1. file: Determine file type
  2. wc: Count words/lines
- Data Processing:
  1. jq: JSON processing - Use for JSON extraction and transformation
  2. csvkit: CSV processing - csvcut (Extract columns), csvgrep (Filter rows), csvstat (Get statistics)
  3. xmlstarlet: XML processing - Use for XML extraction and transformation

**REGEX & CLI DATA PROCESSING:**
- CLI Tools Usage:
  1. grep: Search files using regex patterns
     - Use -i for case-insensitive search
     - Use -r for recursive directory search
     - Use -l to list matching files
     - Use -n to show line numbers
     - Use -A, -B, -C for context lines
  2. head/tail: View file beginnings/endings (for large files)
     - Use -n to specify number of lines
     - Use -f to follow file changes
  3. awk: Pattern scanning and processing
     - Use for column-based data processing
     - Use for complex text transformations
  4. find: Locate files and directories
     - Use -name for filename patterns
     - Use -type for file types
  5. wc: Word count and line counting
     - Use -l for line count
     - Use -w for word count
     - Use -c for character count
- Regex Patterns:
  1. Use for precise text matching
  2. Combine with CLI tools for powerful searches
  3. Save complex patterns to files for reuse
  4. Test patterns with small samples first
  5. Use extended regex (-E) for complex patterns
- Data Processing Workflow:
  1. Use grep to locate relevant files
  2. Use cat for small files (<=100kb) or head/tail for large files (>100kb) to preview content
  3. Use awk for data extraction
  4. Use wc to verify results
  5. Chain commands with pipes for efficiency
"""

    def __init__(self, project_id: str, thread_manager: ThreadManager):
        super().__init__(project_id, thread_manager)
        self._sessions: Dict[str, str] = {}  # Maps session names to session IDs

    async def _ensure_session(self, session_name: str = "default") -> str:
        """Ensure a session exists and return its ID."""
        if session_name not in self._sessions:
            session_id = str(uuid4())
            try:
                await self._ensure_sandbox()  # Ensure sandbox is initialized
                await self.sandbox.process.create_session(session_id)
                self._sessions[session_name] = session_id
            except Exception as e:
                raise RuntimeError(f"Failed to create session: {str(e)}")
        return self._sessions[session_name]

    async def _cleanup_session(self, session_name: str):
        """Clean up a session if it exists."""
        if session_name in self._sessions:
            try:
                await self._ensure_sandbox()  # Ensure sandbox is initialized
                await self.sandbox.process.delete_session(self._sessions[session_name])
                del self._sessions[session_name]
            except Exception as e:
                print(f"Warning: Failed to cleanup session {session_name}: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "execute_command",
            "description": "Execute a shell command in the workspace directory. IMPORTANT: Commands are non-blocking by default and run in a tmux session. This is ideal for long-running operations like starting servers or build processes. Uses sessions to maintain state between commands. This tool is essential for running CLI tools, installing packages, and managing system operations.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "The shell command to execute. Use this for running CLI tools, installing packages, or system operations. Commands can be chained using &&, ||, and | operators."
                    },
                    "folder": {
                        "type": "string",
                        "description": "Optional relative path to a subdirectory of /workspace where the command should be executed. Example: 'data/pdfs'"
                    },
                    "session_name": {
                        "type": "string",
                        "description": "Optional name of the tmux session to use. Use named sessions for related commands that need to maintain state. Defaults to a random session name.",
                    },
                    "blocking": {
                        "type": "boolean",
                        "description": "Whether to wait for the command to complete. Defaults to false for non-blocking execution.",
                        "default": False
                    },
                    "timeout": {
                        "type": "integer",
                        "description": "Optional timeout in seconds for blocking commands. Defaults to 60. Ignored for non-blocking commands.",
                        "default": 60
                    }
                },
                "required": ["command"]
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
                # For blocking execution, use a more reliable approach
                # Add a unique marker to detect command completion
                marker = f"COMMAND_DONE_{str(uuid4())[:8]}"
                completion_command = self._format_completion_command(command, marker)
                wrapped_completion_command = completion_command.replace('"', '\\"')
                
                # Send the command with completion marker
                await self._execute_raw_command(f'tmux send-keys -t {session_name} "{wrapped_completion_command}" Enter')
                
                start_time = time.time()
                final_output = ""
                
                while (time.time() - start_time) < timeout:
                    # Wait a shorter interval for more responsive checking
                    await asyncio.sleep(0.5)
                    
                    # Check if session still exists (command might have exited)
                    check_result = await self._execute_raw_command(f"tmux has-session -t {session_name} 2>/dev/null || echo 'ended'")
                    if "ended" in check_result.get("output", ""):
                        break
                        
                    # Get current output and check for our completion marker
                    output_result = await self._execute_raw_command(f"tmux capture-pane -t {session_name} -p -S - -E -")
                    current_output = output_result.get("output", "")

                    if self._is_command_completed(current_output, marker):
                        final_output = current_output
                        break
                
                # If we didn't get the marker, capture whatever output we have
                if not final_output:
                    output_result = await self._execute_raw_command(f"tmux capture-pane -t {session_name} -p -S - -E -")
                    final_output = output_result.get("output", "")
                
                # Kill the session after capture
                await self._execute_raw_command(f"tmux kill-session -t {session_name}")
                
                return self.success_response({
                    "output": final_output,
                    "session_name": session_name,
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

    async def _execute_raw_command(self, command: str) -> Dict[str, Any]:
        """Execute a raw command directly in the sandbox."""
        # Ensure session exists for raw commands
        session_id = await self._ensure_session("raw_commands")
        
        # Execute command in session
        from daytona_sdk import SessionExecuteRequest
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
        # The response has .output, .stdout, and .stderr attributes
        logs_output = logs.output if logs and logs.output else ""
        
        return {
            "output": logs_output,
            "exit_code": response.exit_code
        }

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "check_command_output",
            "description": "Check the output of a previously executed command in a tmux session. Use this to monitor the progress or results of non-blocking commands.",
            "parameters": {
                "type": "object",
                "properties": {
                    "session_name": {
                        "type": "string",
                        "description": "The name of the tmux session to check."
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
        for session_name in list(self._sessions.keys()):
            await self._cleanup_session(session_name)
        
        # Also clean up any tmux sessions
        try:
            await self._ensure_sandbox()
            await self._execute_raw_command("tmux kill-server 2>/dev/null || true")
        except:
            pass
