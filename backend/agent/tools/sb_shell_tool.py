import asyncio
from typing import Optional, Dict, Any
import time
import asyncio
from uuid import uuid4
from agentpress.tool import ToolResult, openapi_schema, xml_schema
from sandbox.tool_base import SandboxToolsBase
from agentpress.thread_manager import ThreadManager

class SandboxShellTool(SandboxToolsBase):
    """Tool for executing tasks in a Daytona sandbox with browser-use capabilities. 
    Uses sessions for maintaining state between commands and provides comprehensive process management."""

    def __init__(self, project_id: str, thread_manager: ThreadManager):
        super().__init__(project_id, thread_manager)
        self._sessions: Dict[str, str] = {}  # Maps session names to session IDs
        self.workspace_path = "/workspace"  # Ensure we're always operating in /workspace

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
    @xml_schema(
        tag_name="execute-command",
        mappings=[
            {"param_name": "command", "node_type": "content", "path": "."},
            {"param_name": "folder", "node_type": "attribute", "path": ".", "required": False},
            {"param_name": "session_name", "node_type": "attribute", "path": ".", "required": False},
            {"param_name": "blocking", "node_type": "attribute", "path": ".", "required": False},
            {"param_name": "timeout", "node_type": "attribute", "path": ".", "required": False}
        ],
        example='''
        <function_calls>
        <invoke name="execute_command">
        <parameter name="command">npm run dev</parameter>
        <parameter name="session_name">dev_server</parameter>
        </invoke>
        </function_calls>

        <!-- Example 2: Running in Specific Directory -->
        <function_calls>
        <invoke name="execute_command">
        <parameter name="command">npm run build</parameter>
        <parameter name="folder">frontend</parameter>
        <parameter name="session_name">build_process</parameter>
        </invoke>
        </function_calls>

        <!-- Example 3: Blocking command (wait for completion) -->
        <function_calls>
        <invoke name="execute_command">
        <parameter name="command">npm install</parameter>
        <parameter name="blocking">true</parameter>
        <parameter name="timeout">300</parameter>
        </invoke>
        </function_calls>
        '''
    )
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
                # Create a new tmux session
                await self._execute_raw_command(f"tmux new-session -d -s {session_name}")
                
            # Ensure we're in the correct directory and send command to tmux
            full_command = f"cd {cwd} && {command}"
            wrapped_command = full_command.replace('"', '\\"')  # Escape double quotes
            
            if blocking:
                # For blocking execution, use a more reliable approach
                # Add a unique marker to detect command completion
                marker = f"COMMAND_DONE_{str(uuid4())[:8]}"
                completion_command = f"{command} ; echo {marker}"
                wrapped_completion_command = completion_command.replace('"', '\\"')
                
                # Send the command with completion marker
                await self._execute_raw_command(f'tmux send-keys -t {session_name} "cd {cwd} && {wrapped_completion_command}" Enter')
                
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
                    
                    if marker in current_output:
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
        
        return {
            "output": logs,
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
    @xml_schema(
        tag_name="check-command-output",
        mappings=[
            {"param_name": "session_name", "node_type": "attribute", "path": ".", "required": True},
            {"param_name": "kill_session", "node_type": "attribute", "path": ".", "required": False}
        ],
        example='''
        <function_calls>
        <invoke name="check_command_output">
        <parameter name="session_name">dev_server</parameter>
        </invoke>
        </function_calls>
        
        <!-- Example 2: Check final output and kill session -->
        <function_calls>
        <invoke name="check_command_output">
        <parameter name="session_name">build_process</parameter>
        <parameter name="kill_session">true</parameter>
        </invoke>
        </function_calls>
        '''
    )
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
    @xml_schema(
        tag_name="terminate-command",
        mappings=[
            {"param_name": "session_name", "node_type": "attribute", "path": ".", "required": True}
        ],
        example='''
        <function_calls>
        <invoke name="terminate_command">
        <parameter name="session_name">dev_server</parameter>
        </invoke>
        </function_calls>
        '''
    )
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
    @xml_schema(
        tag_name="list-commands",
        mappings=[],
        example='''
        <function_calls>
        <invoke name="list_commands">
        </invoke>
        </function_calls>
        '''
    )
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