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
    visible=True,
    usage_guide="""
### KNOWLEDGE BASE - FILE STORAGE & RETRIEVAL

**IMPORTANT: These are TOOL FUNCTIONS - invoke them as tool calls, NOT as bash commands!**

**QUICK START - ACCESS KB FILES:**
1. `global_kb_enable_all` - Enable all KB files for this agent (required first time!)
2. `global_kb_sync` - Download enabled files to `/workspace/downloads/global-knowledge/`
3. Read files using standard file tools at the synced paths

**WHY FILES DON'T SYNC:**
Files must be ENABLED for this agent before they can sync. Use:
- `global_kb_list_contents` - Shows all files and their `enabled_for_agent` status
- `global_kb_enable_all` - Enables ALL files at once (easiest)
- `global_kb_enable_item` - Enable specific files by ID

**AVAILABLE FUNCTIONS:**
- `global_kb_enable_all` - Enable ALL KB files for this agent (run this first!)
- `global_kb_sync` - Download enabled files to sandbox
- `global_kb_list_contents` - List all files with enabled status
- `global_kb_enable_item` - Enable/disable specific file
- `global_kb_create_folder` - Create new folder
- `global_kb_upload_file` - Upload file from sandbox to KB
- `global_kb_delete_item` - Delete file/folder
- `semantic_search` - Search content with natural language
- `ls_kb` - List indexed files
- `cleanup_kb` - Maintenance operations

**TYPICAL WORKFLOW:**
1. `global_kb_list_contents` - See what files exist
2. `global_kb_enable_all` - Enable all files for this agent
3. `global_kb_sync` - Download to `/workspace/downloads/global-knowledge/`
4. Read files at `/workspace/downloads/global-knowledge/{FolderName}/{filename}`
5. Or use `semantic_search` to search content

**FILE LOCATIONS:**
- Synced files: `/workspace/downloads/global-knowledge/{FolderName}/{filename}`
- System prompt shows SUMMARIES only - sync and read for full content

**REMEMBER:** All KB operations are TOOL FUNCTIONS, not bash commands!
"""
)
class SandboxKbTool(SandboxToolsBase):
    """Tool for knowledge base operations using kb-fusion binary in a Daytona sandbox.
    Provides search capabilities and maintenance operations for knowledge bases."""

    def __init__(self, project_id: str, thread_manager: ThreadManager):
        super().__init__(project_id, thread_manager)
        self.kb_version = "0.1.2"
        self.kb_download_url = f"https://github.com/kortix-ai/kb-fusion/releases/download/v{self.kb_version}/kb"
        self._kb_synced = False  # Track if KB has been synced this session

    async def _auto_sync_kb_if_needed(self) -> bool:
        """Auto-sync KB files from S3 to sandbox if not already synced this session."""
        if self._kb_synced:
            return True

        try:
            # Check if KB directory already exists with files
            kb_dir = f"{self.workspace_path}/downloads/global-knowledge"
            check = await self.sandbox.process.exec(f"test -d {kb_dir} && ls -A {kb_dir} | head -1")
            if check.exit_code == 0 and check.result.strip():
                # KB directory exists and has files
                self._kb_synced = True
                logger.debug("[KB] Auto-sync skipped: KB directory already has files")
                return True

            # Try to sync KB files
            logger.info("[KB] Auto-syncing knowledge base files...")
            result = await self.global_kb_sync()

            if result.success:
                self._kb_synced = True
                synced_count = result.output.get("synced_files", 0) if isinstance(result.output, dict) else 0
                if synced_count > 0:
                    logger.info(f"[KB] Auto-synced {synced_count} knowledge base files")
                else:
                    logger.debug("[KB] No knowledge base files to sync")
                return True
            else:
                logger.warning(f"[KB] Auto-sync failed: {result.output}")
                return False

        except Exception as e:
            logger.warning(f"[KB] Auto-sync error: {e}")
            return False

    async def _execute_kb_command(self, command: str, cwd: str = None) -> dict:
        await self._ensure_sandbox()

        env = {}
        if config.OPENAI_API_KEY:
            env["OPENAI_API_KEY"] = config.OPENAI_API_KEY
        
        # Let kb use its default location (~/.config/kb/ or ~/knowledge-base/)
        # Don't force KB_DIR so file watcher and direct commands use same DB
        
        response = await self.sandbox.process.exec(command, env=env, cwd=cwd or self.workspace_path)
        
        return {
            "output": response.result,
            "exit_code": response.exit_code
        }

    async def _ensure_kb_initialized(self) -> dict:
        """Internal method to ensure kb-fusion is installed and up to date."""
        try:
            await self._ensure_sandbox()
            
            # kb will create its default directory automatically when first used
            
            # Check if kb exists and get version using _execute_kb_command (has OPENAI_API_KEY)
            check_result = await self._execute_kb_command("kb -v 2>&1")
            
            if check_result["exit_code"] == 0:
                output = check_result["output"].strip()
                if f"kb-fusion {self.kb_version}" in output:
                    # Already installed and up to date
                    return {"success": True, "already_installed": True}
            
            # Need to install or update - download doesn't need env vars
            download_result = await self.sandbox.process.exec(
                f"curl -L -f {self.kb_download_url} -o /tmp/kb && chmod +x /tmp/kb && mv /tmp/kb /usr/local/bin/kb"
            )
            
            if download_result.exit_code != 0:
                return {"success": False, "error": f"Failed to download kb: {download_result.result}"}
            
            # Verify installation using _execute_kb_command (has OPENAI_API_KEY)
            verify_result = await self._execute_kb_command("kb -v")
            if verify_result["exit_code"] != 0:
                return {"success": False, "error": f"kb installation verification failed: {verify_result['output']}"}
            
            return {"success": True, "installed": True, "version": self.kb_version}
            
        except Exception as e:
            return {"success": False, "error": f"Error installing kb: {str(e)}"}

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "semantic_search",
            "description": "Perform semantic search on files using natural language queries. Searches /workspace by default, or specify a file path for targeted search. NOTE: Only searches already-indexed files. Files are indexed automatically in the background, but large codebases may take time. If no results found, files might still be indexing - use ls_kb to check indexing status. **🚨 PARAMETER NAMES**: Use `query` (single string) OR `queries` (array of strings), and optional `path`.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Single natural language question to search for. Example: 'How does authentication work?'"
                    },
                    "queries": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Multiple natural language questions to search for. Example: ['How does authentication work?', 'Where is the database configured?']"
                    },
                    "path": {
                        "type": "string",
                        "description": "**OPTIONAL** - Path to specific file or directory to search. Defaults to /workspace if not provided."
                    }
                },
                "required": [],
                "additionalProperties": False
            }
        }
    })
    async def semantic_search(self, queries: Optional[List[str]] = None, query: Optional[str] = None, path: Optional[str] = None) -> ToolResult:
        import json

        try:
            # Handle both 'query' (single string) and 'queries' (array) parameters
            # This provides flexibility for different calling conventions
            if query and not queries:
                # Single query string provided
                queries = [query]
            elif isinstance(queries, str):
                # Handle case where queries might be passed as a JSON string instead of a list
                try:
                    queries = json.loads(queries)
                except json.JSONDecodeError:
                    # If it's a plain string, wrap it in a list
                    queries = [queries]

            if not queries:
                return self.fail_response("At least one query is required for search. Use 'query' for a single search or 'queries' for multiple searches.")

            # Ensure all queries are strings
            queries = [str(q) for q in queries]

            # Ensure kb-fusion is initialized
            init_result = await self._ensure_kb_initialized()
            if not init_result.get("success"):
                return self.fail_response(f"Failed to initialize kb-fusion: {init_result.get('error', 'Unknown error')}")

            # Auto-sync KB files from cloud storage if not already done
            await self._auto_sync_kb_if_needed()
            
            # Default to workspace_path if no path provided
            search_path = path or self.workspace_path
            
            # Verify path exists in sandbox
            check_path = await self.sandbox.process.exec(f"test -e {search_path} && echo 'exists' || echo 'not_found'")
            if "not_found" in check_path.result:
                return self.fail_response(f"Path not found: {search_path}")
            
            # Build search command with proper escaping
            # kb-fusion will auto-index files on first search
            query_args = " ".join([f'"{query}"' for query in queries])
            search_command = f'kb search "{search_path}" {query_args} -k 18 --json'
            
            result = await self._execute_kb_command(search_command)
            
            if result["exit_code"] != 0:
                return self.fail_response(f"Search failed: {result['output']}")
            
            # Parse results to check if any hits were found
            try:
                results_data = json.loads(result["output"])
                total_hits = sum(len(query_result.get("hits", [])) for query_result in results_data)
                
                response = {"results": result["output"]}
                
                if total_hits == 0:
                    response["note"] = "No results found. Files may still be indexing in the background. Use ls_kb to check which files are currently indexed."
                
                return self.success_response(response)
            except json.JSONDecodeError:
                # If parsing fails, just return raw results
                return self.success_response({
                    "results": result["output"]
                })
            
        except Exception as e:
            return self.fail_response(f"Error performing search: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "cleanup_kb",
            "description": "Perform maintenance and cleanup operations on the knowledge base. **🚨 PARAMETER NAMES**: Use EXACTLY these parameter names: `operation` (REQUIRED), `file_paths` (optional), `days` (optional), `retention_days` (optional).",
            "parameters": {
                "type": "object",
                "properties": {
                    "operation": {
                        "type": "string",
                        "enum": ["default", "remove_files", "clear_embeddings", "clear_all"],
                        "description": "**REQUIRED** - Type of cleanup operation: 'default' (missing files + orphan cleanup), 'remove_files' (remove specific files), 'clear_embeddings' (clear embedding cache), 'clear_all' (nuke everything)."
                    },
                    "file_paths": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "**OPTIONAL** - List of file paths to remove (only used with 'remove_files' operation)."
                    },
                    "days": {
                        "type": "integer",
                        "description": "**OPTIONAL** - Days for embedding retention (only used with 'clear_embeddings'). Use 0 to clear all embeddings."
                    },
                    "retention_days": {
                        "type": "integer",
                        "description": "**OPTIONAL** - Retention window for default sweep operation. Default: 30 days.",
                        "default": 30
                    }
                },
                "required": ["operation"],
                "additionalProperties": False
            }
        }
    })
    async def cleanup_kb(self, operation: str, file_paths: Optional[List[str]] = None, days: Optional[int] = None, retention_days: int = 30) -> ToolResult:
        try:
            # Ensure kb-fusion is initialized
            init_result = await self._ensure_kb_initialized()
            if not init_result.get("success"):
                return self.fail_response(f"Failed to initialize kb-fusion: {init_result.get('error', 'Unknown error')}")
            
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
            "description": "List all indexed files in the knowledge base with their status, size, modification time, and paths. Use this to verify which files are indexed and available for semantic_search. If files are missing, they may still be indexing in the background. **🚨 PARAMETER NAMES**: This function takes no parameters.",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": [],
                "additionalProperties": False
            }
        }
    })
    async def ls_kb(self) -> ToolResult:
        try:
            # Ensure kb-fusion is initialized
            init_result = await self._ensure_kb_initialized()
            if not init_result.get("success"):
                return self.fail_response(f"Failed to initialize kb-fusion: {init_result.get('error', 'Unknown error')}")
            
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

    def _sanitize_for_filesystem(self, name: str) -> str:
        """Sanitize a name for use in filesystem paths."""
        import re
        # Remove or replace problematic characters
        safe_name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', name)
        # Replace spaces and other whitespace
        safe_name = re.sub(r'\s+', '_', safe_name)
        # Remove quotes
        safe_name = safe_name.replace("'", "").replace('"', '')
        # Remove multiple underscores
        safe_name = re.sub(r'_+', '_', safe_name)
        # Remove leading/trailing underscores and dots
        safe_name = safe_name.strip('_.')
        # Ensure non-empty
        return safe_name if safe_name else 'file'

    async def _download_with_retry(self, client, file_path: str, max_retries: int = 3) -> Optional[bytes]:
        """Download file from S3 with retry logic."""
        last_error = None
        for attempt in range(max_retries):
            try:
                file_response = await client.storage.from_('file-uploads').download(file_path)
                if file_response and len(file_response) > 0:
                    return file_response
                logger.warning(f"[KB_SYNC] Empty response on attempt {attempt + 1} for {file_path}")
            except Exception as e:
                last_error = e
                logger.warning(f"[KB_SYNC] Download attempt {attempt + 1} failed for {file_path}: {e}")
                if attempt < max_retries - 1:
                    await asyncio.sleep(1 * (attempt + 1))  # Exponential backoff

        if last_error:
            logger.error(f"[KB_SYNC] All {max_retries} download attempts failed for {file_path}: {last_error}")
        return None

    async def _upload_file_with_retry(self, file_content: bytes, destination: str, max_retries: int = 3) -> bool:
        """Upload file to sandbox with retry logic and verification."""
        for attempt in range(max_retries):
            try:
                # Ensure parent directory exists using SDK method (not shell exec)
                parent_dir = '/'.join(destination.split('/')[:-1])
                if parent_dir:
                    try:
                        await self.sandbox.fs.create_folder(parent_dir, "755")
                        logger.debug(f"[KB_SYNC] Created/verified directory: {parent_dir}")
                    except Exception as dir_err:
                        # Directory might already exist, which is fine
                        logger.debug(f"[KB_SYNC] Directory create note: {dir_err}")

                # Upload the file using SDK method
                await self.sandbox.fs.upload_file(file_content, destination)
                logger.debug(f"[KB_SYNC] Upload call completed for: {destination}")

                # Small delay to ensure filesystem sync
                await asyncio.sleep(0.3)

                # Verify using SDK's get_file_info method first
                try:
                    file_info = await self.sandbox.fs.get_file_info(destination)
                    if file_info and not file_info.is_dir:
                        logger.info(f"[KB_SYNC] Upload verified via SDK: {destination}")
                        return True
                except Exception as info_err:
                    logger.debug(f"[KB_SYNC] SDK verification failed, trying shell: {info_err}")

                # Fallback: verify with shell command
                verify_cmd = f'test -f "{destination}" && wc -c < "{destination}"'
                verify_result = await self.sandbox.process.exec(verify_cmd)

                if verify_result.exit_code == 0:
                    try:
                        actual_size = int(verify_result.result.strip())
                        expected_size = len(file_content)
                        if actual_size == expected_size:
                            logger.info(f"[KB_SYNC] Upload verified via shell: {destination} ({actual_size} bytes)")
                            return True
                        else:
                            logger.warning(f"[KB_SYNC] Size mismatch for {destination}: expected {expected_size}, got {actual_size}")
                    except ValueError:
                        logger.warning(f"[KB_SYNC] Could not parse size from: {verify_result.result}")
                else:
                    logger.warning(f"[KB_SYNC] Shell verification failed for {destination}: {verify_result.result}")

                if attempt < max_retries - 1:
                    logger.info(f"[KB_SYNC] Retrying upload for {destination} (attempt {attempt + 2}/{max_retries})")
                    await asyncio.sleep(0.5 * (attempt + 1))

            except Exception as e:
                logger.error(f"[KB_SYNC] Upload attempt {attempt + 1} failed for {destination}: {e}", exc_info=True)
                if attempt < max_retries - 1:
                    await asyncio.sleep(0.5 * (attempt + 1))

        return False

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "global_kb_sync",
            "description": "Sync agent's knowledge base files to /workspace/downloads/global-knowledge/. Downloads all assigned knowledge base files and creates a local copy with proper folder structure. Files are automatically searchable via semantic_search and readable with standard file tools. **🚨 PARAMETER NAMES**: This function takes no parameters.",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": [],
                "additionalProperties": False
            }
        }
    })
    async def global_kb_sync(self) -> ToolResult:
        """Sync all agent's knowledge base files to /workspace/downloads/global-knowledge/."""
        logger.info("[KB_SYNC] Starting knowledge base sync...")
        try:
            await self._ensure_sandbox()
            logger.info(f"[KB_SYNC] Sandbox ready: {self.sandbox_id}")

            # Get agent ID from thread manager
            agent_id = getattr(self.thread_manager, 'agent_config', {}).get('agent_id') if hasattr(self.thread_manager, 'agent_config') else None
            if not agent_id:
                return self.fail_response("No agent ID found for knowledge base sync")

            # Get agent's knowledge base entries
            client = await self.thread_manager.db.client

            result = await client.from_("agent_knowledge_entry_assignments").select("""
                entry_id,
                enabled,
                knowledge_base_entries (
                    entry_id,
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
                # Check if there are ANY KB entries for the account (to help debug)
                agent_result = await client.table('agents').select('account_id').eq('agent_id', agent_id).execute()
                account_id = agent_result.data[0]['account_id'] if agent_result.data else None

                # Check total KB entries for account
                total_entries = 0
                unassigned_info = ""
                if account_id:
                    entries_result = await client.table('knowledge_base_entries').select(
                        'entry_id, filename'
                    ).eq('account_id', account_id).eq('is_active', True).execute()
                    total_entries = len(entries_result.data) if entries_result.data else 0

                    if total_entries > 0:
                        # Check assignments for this agent
                        assignments = await client.table('agent_knowledge_entry_assignments').select(
                            'entry_id, enabled'
                        ).eq('agent_id', agent_id).execute()

                        assigned_count = len(assignments.data) if assignments.data else 0
                        enabled_count = sum(1 for a in (assignments.data or []) if a.get('enabled'))

                        unassigned_info = f" Your account has {total_entries} KB files, but {assigned_count} are assigned to this agent ({enabled_count} enabled). Use global_kb_list_contents to see available files, then use global_kb_enable_item to enable them for this agent."

                logger.info(f"[KB_SYNC] No files to sync for agent {agent_id}. Account {account_id} has {total_entries} total KB entries.{unassigned_info}")

                return self.success_response({
                    "message": f"No knowledge base files assigned and enabled for this agent.{unassigned_info}",
                    "synced_files": 0,
                    "failed_files": 0,
                    "kb_directory": f"{self.workspace_path}/downloads/global-knowledge",
                    "agent_id": agent_id,
                    "account_id": account_id,
                    "total_account_kb_files": total_entries,
                    "hint": "Files must be assigned to this agent with enabled=true. Use global_kb_list_contents to see all files, then global_kb_enable_item to enable them."
                })

            # Create knowledge base directory in sandbox - in workspace so it's searchable
            kb_dir = f"{self.workspace_path}/downloads/global-knowledge"

            # Use SDK method to create directory structure
            try:
                await self.sandbox.fs.create_folder(f"{self.workspace_path}/downloads", "755")
            except Exception:
                pass  # May already exist
            try:
                await self.sandbox.fs.create_folder(kb_dir, "755")
            except Exception:
                pass  # May already exist

            # Clear existing files using shell (SDK doesn't have delete recursive)
            await self.sandbox.process.exec(f"rm -rf {kb_dir}/*")
            logger.info(f"[KB_SYNC] KB directory prepared: {kb_dir}")

            synced_files = 0
            failed_files = []
            folder_structure = {}
            file_paths = {}  # Map entry_id to local path for easy reference

            for assignment in result.data:
                if not assignment.get('knowledge_base_entries'):
                    continue

                entry = assignment['knowledge_base_entries']
                folder_name = entry['knowledge_base_folders']['name']
                filename = entry['filename']
                file_path = entry['file_path']  # S3 path
                entry_id = entry['entry_id']

                # Sanitize names for filesystem
                safe_folder_name = self._sanitize_for_filesystem(folder_name)
                safe_filename = self._sanitize_for_filesystem(filename)
                # Preserve file extension
                if '.' in filename:
                    ext = filename.rsplit('.', 1)[-1]
                    if not safe_filename.endswith(f'.{ext}'):
                        safe_filename = f"{safe_filename}.{ext}"

                try:
                    # Download file from S3 with retry
                    logger.info(f"[KB_SYNC] Downloading {file_path} from S3...")
                    file_response = await self._download_with_retry(client, file_path)

                    if not file_response:
                        failed_files.append({
                            "filename": filename,
                            "folder": folder_name,
                            "error": "Failed to download from storage after retries"
                        })
                        continue

                    logger.info(f"[KB_SYNC] Downloaded {len(file_response)} bytes for {filename}")

                    # Create folder structure in sandbox using SDK method
                    folder_path = f"{kb_dir}/{safe_folder_name}"
                    try:
                        await self.sandbox.fs.create_folder(folder_path, "755")
                        logger.debug(f"[KB_SYNC] Created folder: {folder_path}")
                    except Exception as folder_err:
                        # Folder might already exist, try to verify
                        try:
                            folder_info = await self.sandbox.fs.get_file_info(folder_path)
                            if not folder_info.is_dir:
                                failed_files.append({
                                    "filename": filename,
                                    "folder": folder_name,
                                    "error": f"Path exists but is not a directory: {folder_path}"
                                })
                                continue
                        except Exception:
                            failed_files.append({
                                "filename": filename,
                                "folder": folder_name,
                                "error": f"Failed to create folder: {folder_err}"
                            })
                            continue

                    # Upload file to sandbox with retry and verification
                    file_destination = f"{kb_dir}/{safe_folder_name}/{safe_filename}"
                    logger.info(f"[KB_SYNC] Uploading {len(file_response)} bytes to: {file_destination}")

                    upload_success = await self._upload_file_with_retry(file_response, file_destination)
                    if not upload_success:
                        failed_files.append({
                            "filename": filename,
                            "folder": folder_name,
                            "error": "Failed to upload file to sandbox after retries"
                        })
                        continue

                    synced_files += 1
                    logger.info(f"[KB_SYNC] Successfully synced: {safe_folder_name}/{safe_filename}")

                    # Track file paths
                    file_paths[entry_id] = file_destination

                    # Use original folder name for output structure
                    if folder_name not in folder_structure:
                        folder_structure[folder_name] = []
                    folder_structure[folder_name].append({
                        "original": filename,
                        "synced_as": safe_filename,
                        "path": file_destination
                    })

                except Exception as e:
                    logger.error(f"[KB_SYNC] Error syncing {folder_name}/{filename}: {e}", exc_info=True)
                    failed_files.append({
                        "filename": filename,
                        "folder": folder_name,
                        "error": str(e)
                    })
                    continue

            # Create README with file paths
            readme_content = f"""# Global Knowledge Base

This directory contains your agent's knowledge base files, synced from the cloud.

**Location:** `/workspace/downloads/global-knowledge/`

## Synced Files:
"""
            for folder_name, files in folder_structure.items():
                safe_folder = self._sanitize_for_filesystem(folder_name)
                readme_content += f"\n### {folder_name}/\n"
                for file_info in files:
                    readme_content += f"- `{file_info['synced_as']}` (original: {file_info['original']})\n"
                    readme_content += f"  Path: `{file_info['path']}`\n"

            if failed_files:
                readme_content += f"\n## Failed to Sync ({len(failed_files)} files):\n"
                for fail in failed_files:
                    readme_content += f"- {fail['folder']}/{fail['filename']}: {fail['error']}\n"

            readme_content += f"""
## Usage:
- Read files directly: Use file read tools with paths above
- Search files: Use semantic_search tool (files are in /workspace)
- Re-sync: Use `global_kb_sync` tool to refresh

## Sync Summary:
- Synced: {synced_files} files
- Failed: {len(failed_files)} files
- Agent ID: {agent_id}
"""

            # Upload README with retry
            readme_path = f"{kb_dir}/README.md"
            await self._upload_file_with_retry(readme_content.encode('utf-8'), readme_path)

            # Build a flat list of all synced file paths for easy access
            all_file_paths = []
            for folder_files in folder_structure.values():
                for file_info in folder_files:
                    all_file_paths.append(file_info['path'])

            # Final verification: list all files in the KB directory
            verify_ls = await self.sandbox.process.exec(f'find "{kb_dir}" -type f 2>/dev/null')
            verified_files = []
            if verify_ls.exit_code == 0 and verify_ls.result.strip():
                verified_files = [f.strip() for f in verify_ls.result.strip().split('\n') if f.strip()]
                logger.info(f"[KB_SYNC] Final verification - files in KB directory: {verified_files}")

            # Check if any expected files are missing
            missing_files = []
            for expected_path in all_file_paths:
                if expected_path not in verified_files:
                    missing_files.append(expected_path)
                    logger.warning(f"[KB_SYNC] Expected file not found in verification: {expected_path}")

            # Build a simple string summary of synced files (frontend-friendly)
            files_summary = []
            for folder_name, folder_files in folder_structure.items():
                for file_info in folder_files:
                    files_summary.append(f"{folder_name}/{file_info['synced_as']}")

            response = {
                "message": f"Synced {synced_files} files to knowledge base" + (f" ({len(failed_files)} failed)" if failed_files else ""),
                "synced_files": synced_files,
                "failed_files": len(failed_files),
                "kb_directory": kb_dir,
                "files": files_summary,  # Simple string list for frontend
                "file_paths": all_file_paths,  # Full paths for agent use
                "agent_id": agent_id,
                "usage_hint": f"Read files using: read_file with paths like '{all_file_paths[0] if all_file_paths else kb_dir}'"
            }

            if failed_files:
                # Convert to simple strings for frontend
                response["failure_messages"] = [f"{f['folder']}/{f['filename']}: {f['error']}" for f in failed_files]

            if missing_files:
                response["warning"] = f"Some files may not have synced correctly"
                logger.warning(f"[KB_SYNC] Missing files after sync: {missing_files}")

            if synced_files == 0 and failed_files:
                return self.fail_response(f"Failed to sync any files. Errors: {failed_files}")

            return self.success_response(response)

        except Exception as e:
            logger.error(f"[KB_SYNC] Fatal error: {e}", exc_info=True)
            return self.fail_response(f"Failed to sync knowledge base: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "global_kb_create_folder",
            "description": "Create a new folder in the global knowledge base. Agent can organize files by creating folders. **🚨 PARAMETER NAMES**: Use EXACTLY these parameter names: `name` (REQUIRED), `description` (optional).",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "**REQUIRED** - Name of the folder to create."
                    },
                    "description": {
                        "type": "string",
                        "description": "**OPTIONAL** - Description of the folder."
                    }
                },
                "required": ["name"],
                "additionalProperties": False
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
            
            from core.knowledge_base.validation import validate_folder_name_unique
            client = await self.thread_manager.db.client
            
            # Get agent's account ID
            agent_result = await client.table('agents').select('account_id').eq('agent_id', agent_id).execute()
            if not agent_result.data:
                return self.fail_response("Worker not found")
            
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
            "description": "Upload a file from sandbox to the global knowledge base. File must exist in sandbox first. **🚨 PARAMETER NAMES**: Use EXACTLY these parameter names: `sandbox_file_path` (REQUIRED), `folder_name` (REQUIRED), `description` (optional).",
            "parameters": {
                "type": "object",
                "properties": {
                    "sandbox_file_path": {
                        "type": "string",
                        "description": "**REQUIRED** - Path to file in sandbox. Example: 'workspace/document.pdf'"
                    },
                    "folder_name": {
                        "type": "string",
                        "description": "**REQUIRED** - Name of the knowledge base folder to upload to."
                    },
                    "description": {
                        "type": "string",
                        "description": "**OPTIONAL** - Description of the file content."
                    }
                },
                "required": ["sandbox_file_path", "folder_name"],
                "additionalProperties": False
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
            
            client = await self.thread_manager.db.client
            
            # Get agent's account ID
            agent_result = await client.table('agents').select('account_id').eq('agent_id', agent_id).execute()
            if not agent_result.data:
                return self.fail_response("Worker not found")
            
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
            "description": "Delete a file or folder from the global knowledge base using its ID. **🚨 PARAMETER NAMES**: Use EXACTLY these parameter names: `item_type` (REQUIRED), `item_id` (REQUIRED).",
            "parameters": {
                "type": "object",
                "properties": {
                    "item_type": {
                        "type": "string",
                        "enum": ["file", "folder"],
                        "description": "**REQUIRED** - Type of item to delete: 'file' or 'folder'."
                    },
                    "item_id": {
                        "type": "string",
                        "description": "**REQUIRED** - ID of the file (file_id) or folder (folder_id) to delete. Get these IDs from list_kb_contents."
                    }
                },
                "required": ["item_type", "item_id"],
                "additionalProperties": False
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
            
            client = await self.thread_manager.db.client
            
            # Get agent's account ID
            agent_result = await client.table('agents').select('account_id').eq('agent_id', agent_id).execute()
            if not agent_result.data:
                return self.fail_response("Worker not found")
            
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
            "description": "Enable or disable a knowledge base file for this agent. Only enabled items are synced and available. **🚨 PARAMETER NAMES**: Use EXACTLY these parameter names: `item_type` (REQUIRED), `item_id` (REQUIRED), `enabled` (REQUIRED).",
            "parameters": {
                "type": "object",
                "properties": {
                    "item_type": {
                        "type": "string",
                        "enum": ["file"],
                        "description": "**REQUIRED** - Type of item to enable/disable (only 'file' supported)."
                    },
                    "item_id": {
                        "type": "string",
                        "description": "**REQUIRED** - ID of the file (file_id) to enable/disable. Get this ID from list_kb_contents."
                    },
                    "enabled": {
                        "type": "boolean",
                        "description": "**REQUIRED** - True to enable the item for this agent, False to disable it."
                    }
                },
                "required": ["item_type", "item_id", "enabled"],
                "additionalProperties": False
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
            
            client = await self.thread_manager.db.client
            
            # Get agent's account ID
            agent_result = await client.table('agents').select('account_id').eq('agent_id', agent_id).execute()
            if not agent_result.data:
                return self.fail_response("Worker not found")
            
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
            "name": "global_kb_enable_all",
            "description": "Enable ALL knowledge base files for this agent. Use this to quickly make all KB files available for syncing. **🚨 PARAMETER NAMES**: This function takes no parameters.",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": [],
                "additionalProperties": False
            }
        }
    })
    async def global_kb_enable_all(self) -> ToolResult:
        """Enable all knowledge base files for this agent."""
        try:
            # Get agent ID
            agent_id = getattr(self.thread_manager, 'agent_config', {}).get('agent_id') if hasattr(self.thread_manager, 'agent_config') else None
            if not agent_id:
                return self.fail_response("No agent ID found for knowledge base operations")

            client = await self.thread_manager.db.client

            # Get agent's account ID
            agent_result = await client.table('agents').select('account_id').eq('agent_id', agent_id).execute()
            if not agent_result.data:
                return self.fail_response("Worker not found")

            account_id = agent_result.data[0]['account_id']

            # Get all KB entries for this account
            entries_result = await client.table('knowledge_base_entries').select(
                'entry_id, filename'
            ).eq('account_id', account_id).eq('is_active', True).execute()

            if not entries_result.data:
                return self.success_response({
                    "message": "No knowledge base files found to enable",
                    "enabled_count": 0
                })

            # Get existing assignments
            existing_result = await client.table('agent_knowledge_entry_assignments').select(
                'entry_id'
            ).eq('agent_id', agent_id).execute()
            existing_entries = {a['entry_id'] for a in (existing_result.data or [])}

            # Enable all files
            enabled_count = 0
            for entry in entries_result.data:
                entry_id = entry['entry_id']
                try:
                    if entry_id in existing_entries:
                        # Update existing assignment
                        await client.table('agent_knowledge_entry_assignments').update({
                            'enabled': True
                        }).eq('agent_id', agent_id).eq('entry_id', entry_id).execute()
                    else:
                        # Create new assignment
                        await client.table('agent_knowledge_entry_assignments').insert({
                            'agent_id': agent_id,
                            'entry_id': entry_id,
                            'account_id': account_id,
                            'enabled': True
                        }).execute()
                    enabled_count += 1
                except Exception as e:
                    logger.warning(f"[KB] Failed to enable entry {entry_id}: {e}")

            return self.success_response({
                "message": f"Successfully enabled {enabled_count} knowledge base files for this agent. Now call global_kb_sync to download them.",
                "enabled_count": enabled_count,
                "total_files": len(entries_result.data),
                "next_step": "Call global_kb_sync to download the files to /workspace/downloads/global-knowledge/"
            })

        except Exception as e:
            return self.fail_response(f"Failed to enable all files: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "global_kb_list_contents",
            "description": "List all folders and files in the global knowledge base. **🚨 PARAMETER NAMES**: This function takes no parameters.",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": [],
                "additionalProperties": False
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
            
            client = await self.thread_manager.db.client
            
            # Get agent's account ID
            agent_result = await client.table('agents').select('account_id').eq('agent_id', agent_id).execute()
            if not agent_result.data:
                return self.fail_response("Worker not found")
            
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

            # Get assignments for this agent to show enabled status
            assignments_result = await client.table('agent_knowledge_entry_assignments').select(
                'entry_id, enabled'
            ).eq('agent_id', agent_id).execute()

            # Build a map of entry_id -> enabled status
            assignment_map = {}
            for assignment in (assignments_result.data or []):
                assignment_map[assignment['entry_id']] = assignment['enabled']

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

            # Add files to their folders with enabled status
            enabled_count = 0
            for file in files_result.data:
                folder_name = file['knowledge_base_folders']['name']
                entry_id = file['entry_id']
                is_enabled = assignment_map.get(entry_id, False)
                if is_enabled:
                    enabled_count += 1

                if folder_name in kb_structure:
                    kb_structure[folder_name]['files'].append({
                        "file_id": entry_id,
                        "filename": file['filename'],
                        "file_size": file['file_size'],
                        "created_at": file['created_at'],
                        "summary": file['summary'][:100] + "..." if file.get('summary') and len(file['summary']) > 100 else (file.get('summary') or ''),
                        "enabled_for_agent": is_enabled  # Shows if this file will sync for this agent
                    })

            total_files = len(files_result.data)
            total_folders = len(folders_result.data)
            total_size = sum(file['file_size'] for file in files_result.data)

            return self.success_response({
                "message": f"Knowledge base contains {total_folders} folders and {total_files} files ({enabled_count} enabled for this agent)",
                "total_folders": total_folders,
                "total_files": total_files,
                "enabled_for_agent": enabled_count,
                "total_size_mb": round(total_size / (1024 * 1024), 2),
                "structure": kb_structure,
                "agent_id": agent_id,
                "hint": "Files with enabled_for_agent=false won't sync. Use global_kb_enable_item to enable them."
            })
            
        except Exception as e:
            return self.fail_response(f"Failed to list knowledge base contents: {str(e)}")