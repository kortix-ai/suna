from typing import Optional, Dict
from uuid import uuid4
from agentpress.tool import ToolResult, openapi_schema, xml_schema
from sandbox.sandbox import SandboxToolsBase
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
                self.sandbox.process.create_session(session_id)
                self._sessions[session_name] = session_id
            except Exception as e:
                raise RuntimeError(f"Failed to create session: {str(e)}")
        return self._sessions[session_name]

    async def _cleanup_session(self, session_name: str):
        """Clean up a session if it exists."""
        if session_name in self._sessions:
            try:
                await self._ensure_sandbox()  # Ensure sandbox is initialized
                self.sandbox.process.delete_session(self._sessions[session_name])
                del self._sessions[session_name]
            except Exception as e:
                print(f"Warning: Failed to cleanup session {session_name}: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "execute_command",
            "description": "Execute a shell command in the workspace directory. IMPORTANT: Commands are blocking by default and wait for completion up to the specified timeout. For operations that might exceed the timeout, structure the command itself to run in the background (e.g., using '&', 'nohup', or 'tmux'). Uses sessions to maintain state between commands. Essential for running CLI tools, installing packages, and system operations. Always verify command outputs. Commands can be chained using &&, ||, and |.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "The shell command to execute. Use this for running CLI tools, installing packages, or system operations. Commands can be chained using &&, ||, and | operators. Example: 'find . -type f | sort && grep -r \"pattern\" . | awk \"{print $1}\" | sort | uniq -c'"
                    },
                    "folder": {
                        "type": "string",
                        "description": "Optional relative path to a subdirectory of /workspace where the command should be executed. Example: 'data/pdfs'"
                    },
                    "session_name": {
                        "type": "string",
                        "description": "Optional name of the session to use. Use named sessions for related commands that need to maintain state. Defaults to 'default'.",
                        "default": "default"
                    },
                    "timeout": {
                        "type": "integer",
                        "description": "Optional timeout in seconds for the tool to wait for the command. Defaults to 60. For commands expected to run longer, ensure they are structured to execute in the background within the command string itself.",
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
            {"param_name": "timeout", "node_type": "attribute", "path": ".", "required": False}
        ],
        example='''
        <!-- BLOCKING COMMANDS (Direct Execution) -->
        <!-- Example 1: Basic Command Execution -->
        <execute-command>
        ls -la
        </execute-command>

        <!-- Example 2: Running in Specific Directory -->
        <execute-command folder="src">
        npm install
        </execute-command>

        <!-- Example 3: Long-running Process with Extended Timeout -->
        <execute-command timeout="300">
        npm run build
        </execute-command>

        <!-- Example 4: Complex Command with Environment Variables -->
        <execute-command>
        export NODE_ENV=production && npm run preview
        </execute-command>

        <!-- Example 5: Command with Output Redirection -->
        <execute-command>
        npm run build > build.log 2>&1
        </execute-command>

        <!-- NON-BLOCKING COMMANDS (TMUX Sessions) -->
        <!-- Example 1: Start a Vite Development Server -->
        <execute-command>
        tmux new-session -d -s vite_dev "cd /workspace && npm run dev"
        </execute-command>

        <!-- Example 2: Check if Vite Server is Running -->
        <execute-command>
        tmux list-sessions | grep -q vite_dev && echo "Vite server running" || echo "Vite server not found"
        </execute-command>

        <!-- Example 3: Get Vite Server Output -->
        <execute-command>
        tmux capture-pane -pt vite_dev
        </execute-command>

        <!-- Example 4: Stop Vite Server -->
        <execute-command>
        tmux kill-session -t vite_dev
        </execute-command>

        <!-- Example 5: Start a Vite Build Process -->
        <execute-command>
        tmux new-session -d -s vite_build "cd /workspace && npm run build"
        </execute-command>

        <!-- Example 6: Monitor Vite Build Progress -->
        <execute-command>
        tmux capture-pane -pt vite_build
        </execute-command>

        <!-- Example 7: Start Multiple Vite Services -->
        <execute-command>
        tmux new-session -d -s vite_services "cd /workspace && npm run start:all"
        </execute-command>

        <!-- Example 8: Check All Running Services -->
        <execute-command>
        tmux list-sessions
        </execute-command>

        <!-- Example 9: Kill All TMUX Sessions -->
        <execute-command>
        tmux kill-server
        </execute-command>
        '''
    )
    async def execute_command(
        self, 
        command: str, 
        folder: Optional[str] = None,
        session_name: str = "default",
        timeout: int = 60
    ) -> ToolResult:
        try:
            # Ensure sandbox is initialized
            await self._ensure_sandbox()
            
            # Ensure session exists
            session_id = await self._ensure_session(session_name)
            
            # Set up working directory
            cwd = self.workspace_path
            if folder:
                folder = folder.strip('/')
                cwd = f"{self.workspace_path}/{folder}"
            
            # Ensure we're in the correct directory before executing the command
            command = f"cd {cwd} && {command}"
            
            # Execute command in session
            from sandbox.sandbox import SessionExecuteRequest
            req = SessionExecuteRequest(
                command=command,
                var_async=False,  # This makes the command blocking by default
                cwd=cwd  # Still set the working directory for reference
            )
            
            response = self.sandbox.process.execute_session_command(
                session_id=session_id,
                req=req,
                timeout=timeout
            )
            
            # Get detailed logs
            logs = self.sandbox.process.get_session_command_logs(
                session_id=session_id,
                command_id=response.cmd_id
            )
            
            if response.exit_code == 0:
                return self.success_response({
                    "output": logs,
                    "exit_code": response.exit_code,
                    "cwd": cwd
                })
            else:
                error_msg = f"Command failed with exit code {response.exit_code}"
                if logs:
                    error_msg += f": {logs}"
                return self.fail_response(error_msg)
                
        except Exception as e:
            return self.fail_response(f"Error executing command: {str(e)}")

    async def cleanup(self):
        """Clean up all sessions."""
        for session_name in list(self._sessions.keys()):
            await self._cleanup_session(session_name)