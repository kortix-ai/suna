from typing import Optional, Dict, List
from uuid import uuid4
from agentpress.tool import ToolResult, openapi_schema, xml_schema
from sandbox.sandbox import SandboxToolsBase, Sandbox

# TODO: might want to be more granular with the tool names:
# shell_exec - Execute commands in a specified shell session. Use for running code, installing packages, or managing files.
# shell_view - View the content of a specified shell session. Use for checking command execution results or monitoring output.
# shell_wait - Wait for the running process in a specified shell session to return. Use after running commands that require longer runtime.
# shell_write_to_process - Write input to a running process in a specified shell session. Use for responding to interactive command prompts.
# shell_kill_process - Terminate a running process in a specified shell session. Use for stopping long-running processes or handling frozen commands.



class SandboxShellTool(SandboxToolsBase):
    """Tool for executing tasks in a Daytona sandbox with browser-use capabilities. 
    Uses sessions for maintaining state between commands and provides comprehensive process management."""

    def __init__(self, sandbox: Sandbox):
        super().__init__(sandbox)
        self._sessions: Dict[str, str] = {}  # Maps session names to session IDs

    async def _ensure_session(self, session_name: str = "default") -> str:
        """Ensure a session exists and return its ID."""
        if session_name not in self._sessions:
            session_id = str(uuid4())
            try:
                self.sandbox.process.create_session(session_id)
                self._sessions[session_name] = session_id
            except Exception as e:
                raise RuntimeError(f"Failed to create session: {str(e)}")
        return self._sessions[session_name]

    async def _cleanup_session(self, session_name: str):
        """Clean up a session if it exists."""
        if session_name in self._sessions:
            try:
                self.sandbox.process.delete_session(self._sessions[session_name])
                del self._sessions[session_name]
            except Exception as e:
                print(f"Warning: Failed to cleanup session {session_name}: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "execute_command",
            "description": "Execute a shell command in the workspace directory. Uses sessions to maintain state between commands. This tool is essential for running CLI tools, installing packages, and managing system operations. Always verify command outputs before using the data.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "The shell command to execute. Use this for running CLI tools, installing packages, or system operations. Example: 'pdftotext input.pdf -layout'"
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
                        "description": "Optional timeout in seconds. Increase for long-running commands. Defaults to 60.",
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
        <!-- Example 1: Basic command execution -->
        <execute-command>
        ls -l
        </execute-command>

        <!-- Example 2: Command in specific directory -->
        <execute-command folder="data/pdfs">
        pdftotext document.pdf -layout
        </execute-command>

        <!-- Example 3: Using named session for related commands -->
        <execute-command session_name="pdf_processing">
        pdftotext input.pdf -layout > output.txt
        </execute-command>

        <!-- Example 4: Complex command with pipes -->
        <execute-command>
        grep -r "pattern" . | awk '{print $1}' | sort | uniq -c
        </execute-command>

        <!-- Example 5: Command with error handling -->
        <execute-command>
        pdftotext input.pdf -layout 2>&1 || echo "Error processing PDF"
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
            # Ensure session exists
            session_id = await self._ensure_session(session_name)
            
            # Set up working directory
            cwd = self.workspace_path
            if folder:
                folder = folder.strip('/')
                cwd = f"{self.workspace_path}/{folder}"
            
            # Execute command in session
            from sandbox.sandbox import SessionExecuteRequest
            req = SessionExecuteRequest(
                command=command,
                var_async=False
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
                    "cwd": cwd,
                    "session_id": session_id,
                    "command_id": response.cmd_id
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
