import asyncio
from typing import Optional, List
from core.agentpress.tool import ToolResult, openapi_schema, usage_example
from core.sandbox.tool_base import SandboxToolsBase
from core.agentpress.thread_manager import ThreadManager
from core.utils.config import config

class SandboxKbTool(SandboxToolsBase):
    """Tool for knowledge base operations using kb-fusion binary in a Daytona sandbox.
    Provides search capabilities and maintenance operations for knowledge bases."""

    def __init__(self, project_id: str, thread_manager: ThreadManager):
        super().__init__(project_id, thread_manager)
        self.kb_version = "0.1.0"
        self.kb_download_url = f"https://github.com/kortix-ai/kb-fusion/releases/download/v{self.kb_version}/kb"

    async def _execute_kb_command(self, command: str) -> dict:
        """Execute a kb command with OPENAI_API_KEY environment variable set."""
        await self._ensure_sandbox()
        
        env = {"OPENAI_API_KEY": config.OPENAI_API_KEY} if config.OPENAI_API_KEY else {}
        
        response = await self.sandbox.process.exec(command, env=env)
        
        return {
            "output": response.result,
            "exit_code": response.exit_code
        }

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "init_kb",
            "description": "Initialize the kb-fusion binary. Checks if kb exists and installs/updates if needed.",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": []
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="init_kb">
        </invoke>
        </function_calls>
        ''')
    async def init_kb(self) -> ToolResult:
        try:
            await self._ensure_sandbox()
            
            # Check if kb exists and get version
            check_result = await self._execute_kb_command("kb -v")
            
            if check_result["exit_code"] == 0:
                output = check_result["output"].strip()
                if f"kb-fusion {self.kb_version}" in output:
                    return self.success_response({
                        "message": f"kb-fusion {self.kb_version} is already installed and up to date.",
                        "version": self.kb_version
                    })
                else:
                    # Update needed
                    install_msg = f"Updating kb-fusion to version {self.kb_version}"
            else:
                # Install needed
                install_msg = f"Installing kb-fusion version {self.kb_version}"
            
            # Download and install kb binary
            install_commands = [
                f"curl -L {self.kb_download_url} -o /usr/local/bin/kb",
                "chmod +x /usr/local/bin/kb"
            ]
            
            for cmd in install_commands:
                result = await self._execute_kb_command(cmd)
                if result["exit_code"] != 0:
                    return self.fail_response(f"Failed to install kb: {result['output']}")
            
            # Verify installation
            verify_result = await self._execute_kb_command("kb -v")
            if verify_result["exit_code"] != 0:
                return self.fail_response(f"kb installation verification failed: {verify_result['output']}")
            
            return self.success_response({
                "message": f"{install_msg} completed successfully.",
                "version": self.kb_version,
                "verification": verify_result["output"].strip()
            })
            
        except Exception as e:
            return self.fail_response(f"Error installing kb: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "search_files",
            "description": "Perform semantic search on files using kb-fusion. Searches for multiple queries in a specified full file path.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Full Path to the file or directory to search in."
                    },
                    "queries": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "List of search queries to execute."
                    }
                },
                "required": ["path", "queries"]
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="search_files">
        <parameter name="path"> /workspace/documents/dataset.txt</parameter>
        <parameter name="queries">["What is the atomic number of oxygen?", "What color is oxygen when liquid?"]</parameter>
        </invoke>
        </function_calls>
        ''')
    async def search_files(self, path: str, queries: List[str]) -> ToolResult:
        try:
            if not queries:
                return self.fail_response("At least one query is required for search.")
            
            # Build search command
            query_args = " ".join([f'"{query}"' for query in queries])
            search_command = f'kb search {path} {query_args} -k 18 --json'
            
            result = await self._execute_kb_command(search_command)
            
            if result["exit_code"] != 0:
                return self.fail_response(f"Search failed: {result['output']}")
            
            return self.success_response({
                "search_results": result["output"],
                "path": path,
                "queries": queries,
                "command": search_command
            })
            
        except Exception as e:
            return self.fail_response(f"Error performing search: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "cleanup_kb",
            "description": "Perform maintenance and cleanup operations on the knowledge base.",
            "parameters": {
                "type": "object",
                "properties": {
                    "operation": {
                        "type": "string",
                        "enum": ["default", "remove_files", "clear_embeddings", "clear_all"],
                        "description": "Type of cleanup operation: 'default' (missing files + orphan cleanup), 'remove_files' (remove specific files), 'clear_embeddings' (clear embedding cache), 'clear_all' (nuke everything)."
                    },
                    "file_paths": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "List of file paths to remove (only used with 'remove_files' operation)."
                    },
                    "days": {
                        "type": "integer",
                        "description": "Days for embedding retention (only used with 'clear_embeddings'). Use 0 to clear all embeddings."
                    },
                    "retention_days": {
                        "type": "integer",
                        "description": "Retention window for default sweep operation (default 30 days).",
                        "default": 30
                    }
                },
                "required": ["operation"]
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="cleanup_kb">
        <parameter name="operation">default</parameter>
        </invoke>
        </function_calls>
        
        <function_calls>
        <invoke name="cleanup_kb">
        <parameter name="operation">remove_files</parameter>
        <parameter name="file_paths">["/workspace/old_dataset.txt", "/workspace/temp.pdf"]</parameter>
        </invoke>
        </function_calls>
        
        <function_calls>
        <invoke name="cleanup_kb">
        <parameter name="operation">clear_embeddings</parameter>
        <parameter name="days">7</parameter>
        </invoke>
        </function_calls>
        ''')
    async def cleanup_kb(self, operation: str, file_paths: Optional[List[str]] = None, days: Optional[int] = None, retention_days: int = 30) -> ToolResult:
        try:
            if operation == "default":
                command = f"kb sweep --retention-days {retention_days}"
            elif operation == "remove_files":
                if not file_paths:
                    return self.fail_response("file_paths is required for remove_files operation.")
                paths_str = " ".join([f'"{path}"' for path in file_paths])
                command = f"kb sweep --remove {paths_str}"
            elif operation == "clear_embeddings":
                if days is not None:
                    command = f"kb sweep --clear-embeddings {days}"
                else:
                    command = "kb sweep --clear-embeddings 0"
            elif operation == "clear_all":
                command = "kb sweep --clear-all"
            else:
                return self.fail_response(f"Unknown operation: {operation}")
            
            result = await self._execute_kb_command(command)
            
            if result["exit_code"] != 0:
                return self.fail_response(f"Cleanup operation failed: {result['output']}")
            
            return self.success_response({
                "message": f"Cleanup operation '{operation}' completed successfully.",
                "output": result["output"],
                "command": command
            })
            
        except Exception as e:
            return self.fail_response(f"Error performing cleanup: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "ls_kb",
            "description": "List indexed files in the knowledge base. Shows file status, size, modification time, and paths.",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": []
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="ls_kb">
        </invoke>
        </function_calls>
        ''')
    async def ls_kb(self) -> ToolResult:
        try:
            result = await self._execute_kb_command("kb ls")
            
            if result["exit_code"] != 0:
                return self.fail_response(f"List operation failed: {result['output']}")
            
            return self.success_response({
                "message": "Successfully listed indexed files.",
                "output": result["output"],
                "command": "kb ls"
            })
            
        except Exception as e:
            return self.fail_response(f"Error listing files: {str(e)}")