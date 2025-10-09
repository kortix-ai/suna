import asyncio
from typing import Optional, List
from core.agentpress.tool import ToolResult, openapi_schema, tool_metadata
from core.sandbox.tool_base import SandboxToolsBase
from core.agentpress.thread_manager import ThreadManager
from core.utils.config import config
from core.knowledge_base.validation import FileNameValidator, ValidationError
from core.utils.logger import logger

@tool_metadata(
    display_name="Knowledge Base",
    description="Store and retrieve information from your personal knowledge library",
    icon="Brain",
    color="bg-yellow-100 dark:bg-yellow-800/50",
    weight=200,
    visible=True
)
class SandboxKbTool(SandboxToolsBase):
    """Tool for knowledge base operations using kb-fusion binary in a Daytona sandbox.
    Provides search capabilities and maintenance operations for knowledge bases."""

    def __init__(self, project_id: str, thread_manager: ThreadManager):
        super().__init__(project_id, thread_manager)
        self.kb_version = "0.1.1"
        self.kb_download_url = f"https://github.com/kortix-ai/kb-fusion/releases/download/v{self.kb_version}/kb"

    async def _execute_kb_command(self, command: str) -> dict:
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
            "description": "Initialize the kb-fusion binary. Checks if kb exists and installs/updates if needed. Optionally sync global knowledge base files.",
            "parameters": {
                "type": "object",
                "properties": {
                    "sync_global_knowledge_base": {
                        "type": "boolean",
                        "description": "Whether to sync agent's knowledge base files to sandbox after initialization",
                        "default": False
                    }
                },
                "required": []
            }
        }
    })
    async def init_kb(self, sync_global_knowledge_base: bool = False) -> ToolResult:
        try:
            await self._ensure_sandbox()
            
            # Check if kb exists and get version
            check_result = await self._execute_kb_command("kb -v")
            
            if check_result["exit_code"] == 0:
                output = check_result["output"].strip()
                if f"kb-fusion {self.kb_version}" in output:
                    result_data = {
                        "message": f"kb-fusion {self.kb_version} is already installed and up to date.",
                        "version": self.kb_version
                    }
                    
                    # Optionally sync global knowledge base even if KB is already installed
                    if sync_global_knowledge_base:
                        sync_result = await self.global_kb_sync()
                        if sync_result.success:
                            import json
                            sync_data = json.loads(sync_result.output)
                            result_data["sync_result"] = sync_data
                            result_data["message"] += f" Knowledge base synced: {sync_data.get('synced_files', 0)} files."
                        else:
                            result_data["sync_warning"] = f"Knowledge base sync failed: {sync_result.output}"
                    
                    return self.success_response(result_data)
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
            
            result_data = {
                "message": f"{install_msg} completed successfully.",
                "version": self.kb_version,
                "verification": verify_result["output"].strip()
            }
            
            # Optionally sync global knowledge base
            if sync_global_knowledge_base:
                sync_result = await self.global_kb_sync()
                if sync_result.success:
                    import json
                    sync_data = json.loads(sync_result.output)
                    result_data["sync_result"] = sync_data
                    result_data["message"] += f" Knowledge base synced: {sync_data.get('synced_files', 0)} files."
                else:
                    result_data["sync_warning"] = f"Knowledge base sync failed: {sync_result.output}"
            
            return self.success_response(result_data)
            
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
    async def search_files(self, path: str, queries: List[str]) -> ToolResult:
        try:
            if not queries:
                return self.fail_response("At least one query is required for search.")
            
            # Build search command
            query_args = " ".join([f'"{query}"' for query in queries])
            search_command = f'kb search "{path}" {query_args} -k 18 --json'
            
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

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "global_kb_sync",
            "description": "Sync agent's knowledge base files to sandbox ~/knowledge-base-global directory. Downloads all assigned knowledge base files and creates a local copy with proper folder structure.",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": []
            }
        }
    })
    async def global_kb_sync(self) -> ToolResult:
        """Sync all agent's knowledge base files to sandbox ~/knowledge-base-global directory."""
        try:
            await self._ensure_sandbox()
            
            # Get agent ID from thread manager
            agent_id = getattr(self.thread_manager, 'agent_config', {}).get('agent_id') if hasattr(self.thread_manager, 'agent_config') else None
            if not agent_id:
                return self.fail_response("No agent ID found for knowledge base sync")
            
            from core.services.supabase import DBConnection
            db = DBConnection()
            
            # Get agent's knowledge base entries
            client = await db.client
            
            result = await client.from_("agent_knowledge_entry_assignments").select("""
                entry_id,
                enabled,
                knowledge_base_entries (
                    filename,
                    file_path,
                    file_size,
                    mime_type,
                    knowledge_base_folders (
                        name
                    )
                )
            """).eq("agent_id", agent_id).eq("enabled", True).execute()
            
            if not result.data:
                return self.success_response({
                    "message": "No knowledge base files to sync",
                    "synced_files": 0,
                    "kb_directory": "~/knowledge-base-global"
                })
            
            # Create knowledge base directory in sandbox
            kb_dir = "knowledge-base-global"
            await self.sandbox.process.exec(f"mkdir -p ~/{kb_dir}")
            await self.sandbox.process.exec(f"rm -rf ~/{kb_dir}/*")
            
            synced_files = 0
            folder_structure = {}
            
            for assignment in result.data:
                if not assignment.get('knowledge_base_entries'):
                    continue
                    
                entry = assignment['knowledge_base_entries']
                folder_name = entry['knowledge_base_folders']['name']
                filename = entry['filename']
                file_path = entry['file_path']  # S3 path
                
                try:
                    # Download file from S3
                    file_response = await client.storage.from_('file-uploads').download(file_path)
                    
                    if not file_response:
                        continue
                    
                    # Create folder structure in sandbox
                    folder_path = f"~/{kb_dir}/{folder_name}"
                    await self.sandbox.process.exec(f"mkdir -p '{folder_path}'")
                    
                    # Upload file to sandbox
                    file_destination = f"{kb_dir}/{folder_name}/{filename}"
                    await self.sandbox.fs.upload_file(file_response, file_destination)
                    
                    synced_files += 1
                    
                    if folder_name not in folder_structure:
                        folder_structure[folder_name] = []
                    folder_structure[folder_name].append(filename)
                    
                except Exception as e:
                    continue
            
            # Create README
            readme_content = f"""# Global Knowledge Base

This directory contains your agent's knowledge base files, synced from the cloud.

## Structure:
"""
            for folder_name, files in folder_structure.items():
                readme_content += f"\n### {folder_name}/\n"
                for filename in files:
                    readme_content += f"- {filename}\n"
            
            readme_content += f"""
## Usage:
- Files are automatically synced when you run tasks that require knowledge base access
- You can manually sync with the `global_kb_sync` tool
- Total files synced: {synced_files}

## Last Sync:
Agent ID: {agent_id}
"""
            
            await self.sandbox.fs.upload_file(readme_content.encode('utf-8'), f"{kb_dir}/README.md")
            
            return self.success_response({
                "message": f"Successfully synced {synced_files} files to knowledge base",
                "synced_files": synced_files,
                "kb_directory": f"~/{kb_dir}",
                "folder_structure": folder_structure,
                "agent_id": agent_id
            })
            
        except Exception as e:
            return self.fail_response(f"Failed to sync knowledge base: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "global_kb_create_folder",
            "description": "Create a new folder in the global knowledge base. Agent can organize files by creating folders.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Name of the folder to create"
                    },
                    "description": {
                        "type": "string",
                        "description": "Optional description of the folder"
                    }
                },
                "required": ["name"]
            }
        }
    })
    async def global_kb_create_folder(self, name: str, description: str = None) -> ToolResult:
        """Create a new folder in the global knowledge base."""
        try:
            # Validate folder name
            is_valid, error_message = FileNameValidator.validate_name(name, "folder")
            if not is_valid:
                return self.fail_response(f"Invalid folder name: {error_message}")
            
            # Sanitize the name
            sanitized_name = FileNameValidator.sanitize_name(name)
            
            # Get agent ID from thread manager
            agent_id = getattr(self.thread_manager, 'agent_config', {}).get('agent_id') if hasattr(self.thread_manager, 'agent_config') else None
            if not agent_id:
                return self.fail_response("No agent ID found for knowledge base operations")
            
            from core.services.supabase import DBConnection
            from core.knowledge_base.validation import validate_folder_name_unique
            db = DBConnection()
            client = await db.client
            
            # Get agent's account ID
            agent_result = await client.table('agents').select('account_id').eq('agent_id', agent_id).execute()
            if not agent_result.data:
                return self.fail_response("Agent not found")
            
            account_id = agent_result.data[0]['account_id']
            
            # Get existing folder names to avoid conflicts
            existing_result = await client.table('knowledge_base_folders').select('name').eq('account_id', account_id).execute()
            existing_names = [folder['name'] for folder in existing_result.data]
            
            # Generate unique name if there's a conflict
            final_name = FileNameValidator.generate_unique_name(sanitized_name, existing_names, "folder")
            
            # Create folder
            folder_data = {
                'account_id': account_id,
                'name': final_name,
                'description': description.strip() if description else None
            }
            
            result = await client.table('knowledge_base_folders').insert(folder_data).execute()
            
            if not result.data:
                return self.fail_response("Failed to create folder")
            
            folder = result.data[0]
            
            response_data = {
                "message": f"Successfully created folder '{final_name}'",
                "folder_id": folder['folder_id'],
                "name": folder['name'],
                "description": folder['description']
            }
            
            # Add info about name changes
            if final_name != sanitized_name:
                response_data["name_auto_adjusted"] = True
                response_data["requested_name"] = sanitized_name
                response_data["final_name"] = final_name
                response_data["message"] = f"Successfully created folder '{sanitized_name}' as '{final_name}' (name auto-adjusted to avoid conflicts)"
            
            return self.success_response(response_data)
            
        except Exception as e:
            return self.fail_response(f"Failed to create folder: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "global_kb_upload_file",
            "description": "Upload a file from sandbox to the global knowledge base. File must exist in sandbox first.",
            "parameters": {
                "type": "object",
                "properties": {
                    "sandbox_file_path": {
                        "type": "string",
                        "description": "Path to file in sandbox (e.g., 'workspace/document.pdf')"
                    },
                    "folder_name": {
                        "type": "string",
                        "description": "Name of the knowledge base folder to upload to"
                    },
                    "description": {
                        "type": "string",
                        "description": "Optional description of the file content"
                    }
                },
                "required": ["sandbox_file_path", "folder_name"]
            }
        }
    })
    async def global_kb_upload_file(self, sandbox_file_path: str, folder_name: str, description: str = None) -> ToolResult:
        """Upload a file from sandbox to the global knowledge base."""
        try:
            await self._ensure_sandbox()
            
            # Get agent ID
            agent_id = getattr(self.thread_manager, 'agent_config', {}).get('agent_id') if hasattr(self.thread_manager, 'agent_config') else None
            if not agent_id:
                return self.fail_response("No agent ID found for knowledge base operations")
            
            from core.services.supabase import DBConnection
            from core.knowledge_base.file_processor import FileProcessor
            import os
            import mimetypes
            
            db = DBConnection()
            client = await db.client
            
            # Get agent's account ID
            agent_result = await client.table('agents').select('account_id').eq('agent_id', agent_id).execute()
            if not agent_result.data:
                return self.fail_response("Agent not found")
            
            account_id = agent_result.data[0]['account_id']
            
            # Find the folder
            folder_result = await client.table('knowledge_base_folders').select('folder_id').eq(
                'account_id', account_id
            ).eq('name', folder_name).execute()
            
            if not folder_result.data:
                return self.fail_response(f"Folder '{folder_name}' not found. Create it first with global_kb_create_folder.")
            
            folder_id = folder_result.data[0]['folder_id']
            
            # Download file from sandbox
            try:
                file_content = await self.sandbox.fs.download_file(sandbox_file_path)
            except Exception:
                return self.fail_response(f"File '{sandbox_file_path}' not found in sandbox")
            
            # Get filename and mime type
            filename = os.path.basename(sandbox_file_path)
            
            # Validate filename
            is_valid, error_message = FileNameValidator.validate_name(filename, "file")
            if not is_valid:
                return self.fail_response(f"Invalid filename: {error_message}")
            
            mime_type, _ = mimetypes.guess_type(filename)
            if not mime_type:
                mime_type = 'application/octet-stream'
            
            # Check file size limit (50MB total)
            MAX_TOTAL_SIZE = 50 * 1024 * 1024
            current_result = await client.table('knowledge_base_entries').select(
                'file_size'
            ).eq('account_id', account_id).eq('is_active', True).execute()
            
            current_total = sum(entry['file_size'] for entry in current_result.data)
            if current_total + len(file_content) > MAX_TOTAL_SIZE:
                current_mb = current_total / (1024 * 1024)
                new_mb = len(file_content) / (1024 * 1024)
                return self.fail_response(f"File size limit exceeded. Current: {current_mb:.1f}MB, New: {new_mb:.1f}MB, Limit: 50MB")
            
            # Generate unique filename if there's a conflict
            from core.knowledge_base.validation import validate_file_name_unique_in_folder
            final_filename = await validate_file_name_unique_in_folder(filename, folder_id)
            
            # Process file using existing processor
            processor = FileProcessor()
            result = await processor.process_file(
                account_id=account_id,
                folder_id=folder_id,
                file_content=file_content,
                filename=final_filename,
                mime_type=mime_type
            )
            
            # Check if processing was successful
            if not result.get('success', False):
                error_msg = result.get('error', 'Unknown processing error')
                return self.fail_response(f"Failed to process file: {error_msg}")
            
            response_data = {
                "message": f"Successfully uploaded '{final_filename}' to folder '{folder_name}'",
                "entry_id": result['entry_id'],
                "filename": final_filename,
                "folder_name": folder_name,
                "file_size": len(file_content),
                "summary": result.get('summary', 'Processing...')
            }
            
            # Add info about filename changes
            if final_filename != filename:
                response_data["filename_changed"] = True
                response_data["original_filename"] = filename
                response_data["final_filename"] = final_filename
                response_data["message"] = f"Successfully uploaded '{filename}' as '{final_filename}' to folder '{folder_name}' (name was auto-adjusted to avoid conflicts)"
            
            return self.success_response(response_data)
            
        except Exception as e:
            return self.fail_response(f"Failed to upload file: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "global_kb_delete_item",
            "description": "Delete a file or folder from the global knowledge base using its ID.",
            "parameters": {
                "type": "object",
                "properties": {
                    "item_type": {
                        "type": "string",
                        "enum": ["file", "folder"],
                        "description": "Type of item to delete"
                    },
                    "item_id": {
                        "type": "string",
                        "description": "ID of the file (file_id) or folder (folder_id) to delete. Get these IDs from list_kb_contents."
                    }
                },
                "required": ["item_type", "item_id"]
            }
        }
    })
    async def global_kb_delete_item(self, item_type: str, item_id: str) -> ToolResult:
        """Delete a file or folder from the global knowledge base using its ID."""
        try:
            # Get agent ID
            agent_id = getattr(self.thread_manager, 'agent_config', {}).get('agent_id') if hasattr(self.thread_manager, 'agent_config') else None
            if not agent_id:
                return self.fail_response("No agent ID found for knowledge base operations")
            
            from core.services.supabase import DBConnection
            db = DBConnection()
            client = await db.client
            
            # Get agent's account ID
            agent_result = await client.table('agents').select('account_id').eq('agent_id', agent_id).execute()
            if not agent_result.data:
                return self.fail_response("Agent not found")
            
            account_id = agent_result.data[0]['account_id']
            
            if item_type == "folder":
                # Delete folder (will cascade delete all files in it)
                folder_result = await client.table('knowledge_base_folders').delete().eq(
                    'account_id', account_id
                ).eq('folder_id', item_id).execute()
                
                if not folder_result.data:
                    return self.fail_response(f"Folder with ID '{item_id}' not found")
                
                deleted_folder = folder_result.data[0]
                return self.success_response({
                    "message": f"Successfully deleted folder '{deleted_folder.get('name', 'Unknown')}' and all its files",
                    "deleted_type": "folder",
                    "deleted_id": item_id,
                    "deleted_name": deleted_folder.get('name', 'Unknown')
                })
                
            elif item_type == "file":
                # Delete the file directly using its ID
                file_result = await client.table('knowledge_base_entries').delete().eq(
                    'entry_id', item_id
                ).execute()
                
                if not file_result.data:
                    return self.fail_response(f"File with ID '{item_id}' not found")
                
                deleted_file = file_result.data[0]
                return self.success_response({
                    "message": f"Successfully deleted file '{deleted_file.get('filename', 'Unknown')}'",
                    "deleted_type": "file",
                    "deleted_id": item_id,
                    "deleted_name": deleted_file.get('filename', 'Unknown')
                })
            
            else:
                return self.fail_response("item_type must be 'file' or 'folder'")
            
        except Exception as e:
            return self.fail_response(f"Failed to delete item: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "global_kb_enable_item",
            "description": "Enable or disable a knowledge base file for this agent. Only enabled items are synced and available.",
            "parameters": {
                "type": "object",
                "properties": {
                    "item_type": {
                        "type": "string",
                        "enum": ["file"],
                        "description": "Type of item to enable/disable (only 'file' supported)"
                    },
                    "item_id": {
                        "type": "string",
                        "description": "ID of the file (file_id) to enable/disable. Get this ID from list_kb_contents."
                    },
                    "enabled": {
                        "type": "boolean",
                        "description": "True to enable the item for this agent, False to disable it"
                    }
                },
                "required": ["item_type", "item_id", "enabled"]
            }
        }
    })
    async def global_kb_enable_item(self, item_type: str, item_id: str, enabled: bool) -> ToolResult:
        """Enable or disable a knowledge base file for this agent."""
        try:
            # Get agent ID
            agent_id = getattr(self.thread_manager, 'agent_config', {}).get('agent_id') if hasattr(self.thread_manager, 'agent_config') else None
            if not agent_id:
                return self.fail_response("No agent ID found for knowledge base operations")
            
            if item_type != "file":
                return self.fail_response("Only 'file' type is supported for enable/disable operations")
            
            from core.services.supabase import DBConnection
            db = DBConnection()
            client = await db.client
            
            # Get agent's account ID
            agent_result = await client.table('agents').select('account_id').eq('agent_id', agent_id).execute()
            if not agent_result.data:
                return self.fail_response("Agent not found")
            
            account_id = agent_result.data[0]['account_id']
            
            # Check if file exists and belongs to this account
            file_result = await client.table('knowledge_base_entries').select(
                'entry_id, filename'
            ).eq('entry_id', item_id).eq('account_id', account_id).execute()
            
            if not file_result.data:
                return self.fail_response(f"File with ID '{item_id}' not found")
            
            filename = file_result.data[0]['filename']
            
            # Check if assignment already exists
            assignment_result = await client.table('agent_knowledge_entry_assignments').select(
                'enabled'
            ).eq('agent_id', agent_id).eq('entry_id', item_id).execute()
            
            if assignment_result.data:
                # Update existing assignment
                await client.table('agent_knowledge_entry_assignments').update({
                    'enabled': enabled
                }).eq('agent_id', agent_id).eq('entry_id', item_id).execute()
            else:
                # Create new assignment
                await client.table('agent_knowledge_entry_assignments').insert({
                    'agent_id': agent_id,
                    'entry_id': item_id,
                    'account_id': account_id,
                    'enabled': enabled
                }).execute()
            
            status = "enabled" if enabled else "disabled"
            return self.success_response({
                "message": f"Successfully {status} file '{filename}' for this agent",
                "item_type": "file",
                "item_id": item_id,
                "filename": filename,
                "enabled": enabled
            })
            
        except Exception as e:
            return self.fail_response(f"Failed to enable/disable item: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "global_kb_list_contents",
            "description": "List all folders and files in the global knowledge base.",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": []
            }
        }
    })
    async def global_kb_list_contents(self) -> ToolResult:
        """List all folders and files in the global knowledge base."""
        try:
            # Get agent ID
            agent_id = getattr(self.thread_manager, 'agent_config', {}).get('agent_id') if hasattr(self.thread_manager, 'agent_config') else None
            if not agent_id:
                return self.fail_response("No agent ID found for knowledge base operations")
            
            from core.services.supabase import DBConnection
            db = DBConnection()
            client = await db.client
            
            # Get agent's account ID
            agent_result = await client.table('agents').select('account_id').eq('agent_id', agent_id).execute()
            if not agent_result.data:
                return self.fail_response("Agent not found")
            
            account_id = agent_result.data[0]['account_id']
            
            # Get all folders
            folders_result = await client.table('knowledge_base_folders').select(
                'folder_id, name, description, created_at'
            ).eq('account_id', account_id).order('name').execute()
            
            # Get all files with folder info
            files_result = await client.table('knowledge_base_entries').select('''
                entry_id, filename, file_size, created_at, summary, folder_id,
                knowledge_base_folders (name)
            ''').eq('account_id', account_id).eq('is_active', True).order('created_at').execute()
            
            # Organize data
            kb_structure = {}
            
            # Add all folders (even empty ones)
            for folder in folders_result.data:
                kb_structure[folder['name']] = {
                    "folder_id": folder['folder_id'],
                    "description": folder['description'],
                    "created_at": folder['created_at'],
                    "files": []
                }
            
            # Add files to their folders
            for file in files_result.data:
                folder_name = file['knowledge_base_folders']['name']
                if folder_name in kb_structure:
                    kb_structure[folder_name]['files'].append({
                        "file_id": file['entry_id'],
                        "filename": file['filename'],
                        "file_size": file['file_size'],
                        "created_at": file['created_at'],
                        "summary": file['summary'][:100] + "..." if len(file['summary']) > 100 else file['summary']
                    })
            
            total_files = len(files_result.data)
            total_folders = len(folders_result.data)
            total_size = sum(file['file_size'] for file in files_result.data)
            
            return self.success_response({
                "message": f"Knowledge base contains {total_folders} folders and {total_files} files",
                "total_folders": total_folders,
                "total_files": total_files,
                "total_size_mb": round(total_size / (1024 * 1024), 2),
                "structure": kb_structure
            })
            
        except Exception as e:
            return self.fail_response(f"Failed to list knowledge base contents: {str(e)}")