from core.agentpress.tool import ToolResult, openapi_schema, tool_metadata
from core.sandbox.tool_base import SandboxToolsBase
from core.utils.files_utils import should_exclude_file, clean_path
from core.agentpress.thread_manager import ThreadManager
from core.utils.logger import logger
from core.utils.config import config
import os
import json
import litellm
import openai
import asyncio
import re
from typing import Optional

@tool_metadata(
    display_name="Write & Edit",
    description="Write and edit files in the workspace. Create new files or modify existing ones",
    icon="FolderOpen",
    color="bg-blue-100 dark:bg-blue-800/50",
    is_core=True,
    weight=10,
    visible=True,
    usage_guide="""
## Write & Edit - File system operations in the workspace

Provides file system operations relative to /workspace directory.

### Available Tools
- **create_file** (Write): Create new files with content
- **edit_file**: Performs exact string replacements in files (PREFERRED for modifications)
- **str_replace**: Exact string replacement (alternative to edit_file)
- **full_file_rewrite**: Complete file replacement (use sparingly)
- **delete_file**: Delete files
- **export_to_pdf**: Export HTML files to PDF (use this instead of npx html-pdf or wkhtmltopdf)

### Usage Guidelines

**Write (create_file):**
- This tool will overwrite the existing file if there is one at the provided path
- If this is an existing file, you MUST use read_file first to read the file's contents
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required
- NEVER proactively create documentation files (*.md) or README files unless explicitly requested

**Edit (edit_file):**
- You MUST use read_file at least once before editing a file
- When editing text from read_file output, preserve the exact indentation (tabs/spaces)
- ALWAYS prefer editing existing files. NEVER write new files unless explicitly required
- The edit will FAIL if `old_string` is not unique in the file. Provide more context or use `replace_all`
- Use `replace_all` for replacing and renaming strings across the file (e.g., renaming variables)

### File Editing Strategy
1. **Always read before editing**: Use read_file first to understand current content
2. **Use edit_file for modifications**: Handles complex refactoring with context
3. **Use str_replace for precise changes**: When you need exact string replacement
4. **Use full_file_rewrite sparingly**: Only when complete replacement is necessary

### edit_file Format
When using edit_file, specify changes with the `// ... existing code ...` pattern:
```
// ... existing code ...
FIRST_EDIT
// ... existing code ...
SECOND_EDIT
// ... existing code ...
```
- Include 3-5 lines of context around each change
- DO NOT omit code without using the marker
- Make ALL edits to a file in a SINGLE edit_file call

### Important Rules
- All paths are relative to /workspace (e.g., "src/main.py")
- NEVER create files unless absolutely necessary - prefer editing existing files
- NEVER use echo/heredoc/cat via Bash to create files - use create_file instead
- NEVER use sed/awk via Bash to edit files - use edit_file instead
- One comprehensive file is better than multiple fragmented files
- Only use emojis if the user explicitly requests it
"""
)
class SandboxFilesTool(SandboxToolsBase):
    """Tool for executing file system operations in a Daytona sandbox. All operations are performed relative to the /workspace directory."""

    def __init__(self, project_id: str, thread_manager: ThreadManager):
        super().__init__(project_id, thread_manager)
        self.SNIPPET_LINES = 4  # Number of context lines to show around edits

    def clean_path(self, path: str) -> str:
        """Clean and normalize a path to be relative to /workspace"""
        return clean_path(path, self.workspace_path)
    
    def _get_full_path(self, path: str) -> str:
        """Get full absolute path relative to /workspace"""
        cleaned = self.clean_path(path)
        return f"{self.workspace_path}/{cleaned}"

    def _should_exclude_file(self, rel_path: str) -> bool:
        """Check if a file should be excluded based on path, name, or extension"""
        return should_exclude_file(rel_path)

    async def _file_exists(self, path: str) -> bool:
        """Check if a file exists in the sandbox"""
        try:
            await self.sandbox.fs.get_file_info(path)
            return True
        except Exception:
            return False

    async def get_workspace_state(self) -> dict:
        """Get the current workspace state by reading all files"""
        files_state = {}
        try:
            # Ensure sandbox is initialized
            await self._ensure_sandbox()
            
            files = await self.sandbox.fs.list_files(self.workspace_path)
            for file_info in files:
                rel_path = file_info.name
                
                # Skip excluded files and directories
                if self._should_exclude_file(rel_path) or file_info.is_dir:
                    continue

                try:
                    full_path = self._get_full_path(rel_path)
                    content = (await self.sandbox.fs.download_file(full_path)).decode()
                    files_state[rel_path] = {
                        "content": content,
                        "is_dir": file_info.is_dir,
                        "size": file_info.size,
                        "modified": file_info.mod_time
                    }
                except Exception as e:
                    print(f"Error reading file {rel_path}: {e}")
                except UnicodeDecodeError:
                    print(f"Skipping binary file: {rel_path}")

            return files_state
        
        except Exception as e:
            print(f"Error getting workspace state: {str(e)}")
            return {}

    # def _get_preview_url(self, file_path: str) -> Optional[str]:
    #     """Get the preview URL for a file if it's an HTML file."""
    #     if file_path.lower().endswith('.html') and self._sandbox_url:
    #         return f"{self._sandbox_url}/{(file_path.replace('/workspace/', ''))}"
    #     return None

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "create_file",
            "description": """Writes a file to the workspace.

Usage:
- This tool will overwrite the existing file if there is one at the provided path.
- If this is an existing file, you MUST use read_file first to read the file's contents. This tool will fail if you did not read the file first.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.
- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.""",
            "parameters": {
                "type": "object",
                "properties": {
                    "file_path": {
                        "type": "string",
                        "description": "**REQUIRED** - Path to the file to write, relative to /workspace. Example: 'src/main.py' creates /workspace/src/main.py."
                    },
                    "file_contents": {
                        "type": "string",
                        "description": "**REQUIRED** - The content to write to the file."
                    },
                    "permissions": {
                        "type": "string",
                        "description": "**OPTIONAL** - File permissions in octal format. Default: '644'. Example: '755' for executable files.",
                        "default": "644"
                    }
                },
                "required": ["file_path", "file_contents"],
                "additionalProperties": False
            }
        }
    })
    async def create_file(self, file_path: str, file_contents: str, permissions: str = "644") -> ToolResult:
        try:
            # Ensure sandbox is initialized
            await self._ensure_sandbox()
            
            full_path = self._get_full_path(file_path)
            if await self._file_exists(full_path):
                return self.fail_response(f"File '{file_path}' already exists. Use update_file to modify existing files.")
            
            # Create parent directories if needed
            parent_dir = '/'.join(full_path.split('/')[:-1])
            if parent_dir:
                await self.sandbox.fs.create_folder(parent_dir, "755")

            # convert to json string if file_contents is a dict
            if isinstance(file_contents, dict):
                file_contents = json.dumps(file_contents, indent=4)

            # Write the file content
            await self.sandbox.fs.upload_file(file_contents.encode(), full_path)
            await self.sandbox.fs.set_file_permissions(full_path, permissions)
            
            message = f"File '{file_path}' created successfully."
            
            if file_path.lower().endswith('.html'):
                try:
                    website_link = await self.sandbox.get_preview_link(8080)
                    website_url = website_link.url if hasattr(website_link, 'url') else str(website_link).split("url='")[1].split("'")[0]
                    if not website_url.endswith('/'):
                        website_url += '/'
                    full_preview_url = f"{website_url}{file_path}"
                    message += f"\n\n✓ HTML file preview available at: {full_preview_url}"
                    message += "\n[Note: Port 8080 is auto-exposed. Just share this URL with the user - no need to start servers or expose ports manually]"
                except Exception as e:
                    logger.warning(f"Failed to get preview URL for HTML file: {str(e)}")
            
            return self.success_response(message)
        except Exception as e:
            return self.fail_response(f"Error creating file: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "str_replace",
            "description": """Performs exact string replacements in files.

Usage:
- You must use read_file at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file.
- When editing text from read_file output, ensure you preserve the exact indentation (tabs/spaces).
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- Only use emojis if the user explicitly requests it.
- The edit will FAIL if `old_str` is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use `replace_all` to change every instance.
- Use `replace_all` for replacing and renaming strings across the file (useful for renaming variables).""",
            "parameters": {
                "type": "object",
                "properties": {
                    "file_path": {
                        "type": "string",
                        "description": "**REQUIRED** - The path to the file to modify, relative to /workspace."
                    },
                    "old_str": {
                        "type": "string",
                        "description": "**REQUIRED** - The text to replace. Must be unique in the file unless using replace_all."
                    },
                    "new_str": {
                        "type": "string",
                        "description": "**REQUIRED** - The text to replace it with (must be different from old_str)."
                    },
                    "replace_all": {
                        "type": "boolean",
                        "description": "**OPTIONAL** - Replace all occurrences of old_str (default false).",
                        "default": False
                    }
                },
                "required": ["file_path", "old_str", "new_str"],
                "additionalProperties": False
            }
        }
    })
    async def str_replace(self, file_path: str, old_str: str, new_str: str, replace_all: bool = False) -> ToolResult:
        try:
            # Ensure sandbox is initialized
            await self._ensure_sandbox()

            full_path = self._get_full_path(file_path)
            if not await self._file_exists(full_path):
                return self.fail_response(f"File '{file_path}' does not exist")

            content = (await self.sandbox.fs.download_file(full_path)).decode()
            old_str = old_str.expandtabs()
            new_str = new_str.expandtabs()

            occurrences = content.count(old_str)
            if occurrences == 0:
                return self.fail_response(f"String '{old_str}' not found in file")
            if occurrences > 1 and not replace_all:
                lines = [i+1 for i, line in enumerate(content.split('\n')) if old_str in line]
                return self.fail_response(f"Multiple occurrences found in lines {lines}. Use replace_all=true or provide more context to make it unique")

            new_content = content.replace(old_str, new_str)
            await self.sandbox.fs.upload_file(new_content.encode(), full_path)
            
            return ToolResult(success=True, output=json.dumps({
                "message": f"Replacement successful.",
                "file_path": file_path,
                "original_content": content,
                "updated_content": new_content
            }))
            
        except Exception as e:
            return self.fail_response(f"Error replacing string: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "full_file_rewrite",
            "description": "Completely rewrite an existing file with new content. **FOR PRESENTATIONS**: This tool is MANDATORY for template-based presentations - use it to rewrite existing slide HTML files that came from the template. When rewriting template slides, you MUST preserve the original template structure, styling, and layout - only update the content with research data. Do NOT use create_slide for template-based presentations. **FOR OTHER FILES**: The file path must be relative to /workspace (e.g., 'src/main.py' for /workspace/src/main.py). Always prefer using edit_file for making changes to code. Only use this tool when edit_file fails or when you need to replace the entire file content. **🚨 PARAMETER NAMES**: Use EXACTLY these parameter names: `file_path` (REQUIRED), `file_contents` (REQUIRED), `permissions` (optional).",
            "parameters": {
                "type": "object",
                "properties": {
                    "file_path": {
                        "type": "string",
                        "description": "**REQUIRED** - Path to the file to be rewritten, relative to /workspace. Example: 'src/main.py' for /workspace/src/main.py. File must already exist."
                    },
                    "file_contents": {
                        "type": "string",
                        "description": "**REQUIRED** - The new content to write to the file, replacing all existing content. This completely overwrites the file."
                    },
                    "permissions": {
                        "type": "string",
                        "description": "**OPTIONAL** - File permissions in octal format. Default: '644'. Example: '755' for executable files.",
                        "default": "644"
                    }
                },
                "required": ["file_path", "file_contents"],
                "additionalProperties": False
            }
        }
    })
    async def full_file_rewrite(self, file_path: str, file_contents: str, permissions: str = "644") -> ToolResult:
        try:
            # Ensure sandbox is initialized
            await self._ensure_sandbox()
            
            full_path = self._get_full_path(file_path)
            if not await self._file_exists(full_path):
                return self.fail_response(f"File '{file_path}' does not exist. Use create_file to create a new file.")

            await self.sandbox.fs.upload_file(file_contents.encode(), full_path)
            await self.sandbox.fs.set_file_permissions(full_path, permissions)
            
            message = f"File '{file_path}' completely rewritten successfully."
            
            if file_path.lower().endswith('.html'):
                try:
                    website_link = await self.sandbox.get_preview_link(8080)
                    website_url = website_link.url if hasattr(website_link, 'url') else str(website_link).split("url='")[1].split("'")[0]
                    if not website_url.endswith('/'):
                        website_url += '/'
                    full_preview_url = f"{website_url}{file_path}"
                    message += f"\n\n✓ HTML file preview available at: {full_preview_url}"
                    message += "\n[Note: Port 8080 is auto-exposed. Just share this URL with the user - no need to start servers or expose ports manually]"
                except Exception as e:
                    logger.warning(f"Failed to get preview URL for HTML file: {str(e)}")
            
            return self.success_response(message)
        except Exception as e:
            return self.fail_response(f"Error rewriting file: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "delete_file",
            "description": "Delete a file at the given path. The path must be relative to /workspace (e.g., 'src/main.py' for /workspace/src/main.py). **🚨 PARAMETER NAMES**: Use EXACTLY this parameter name: `file_path` (REQUIRED).",
            "parameters": {
                "type": "object",
                "properties": {
                    "file_path": {
                        "type": "string",
                        "description": "**REQUIRED** - Path to the file to be deleted, relative to /workspace. Example: 'src/main.py' for /workspace/src/main.py."
                    }
                },
                "required": ["file_path"],
                "additionalProperties": False
            }
        }
    })
    async def delete_file(self, file_path: str) -> ToolResult:
        try:
            await self._ensure_sandbox()
            
            full_path = self._get_full_path(file_path)
            logger.debug(f"Attempting to delete file: '{file_path}' (full path: '{full_path}')")
            
            if not await self._file_exists(full_path):
                return self.fail_response(f"File '{file_path}' does not exist")
            
            # Delete the file
            await self.sandbox.fs.delete_file(full_path)
            
            # Verify the file was actually deleted
            await asyncio.sleep(0.1)  # Small delay to ensure deletion is processed
            if await self._file_exists(full_path):
                logger.warning(f"File '{file_path}' still exists after delete_file call. Attempting alternative deletion method.")
                # Try alternative: use shell command as fallback
                try:
                    result = await self.sandbox.process.exec("rm", "-f", full_path)
                    if result.exit_code != 0:
                        return self.fail_response(f"Failed to delete file '{file_path}'. File still exists after deletion attempt. Exit code: {result.exit_code}, stderr: {result.stderr}")
                    # Verify again
                    await asyncio.sleep(0.1)
                    if await self._file_exists(full_path):
                        return self.fail_response(f"Failed to delete file '{file_path}'. File still exists after deletion attempt.")
                except Exception as shell_error:
                    return self.fail_response(f"Failed to delete file '{file_path}'. File still exists and shell deletion also failed: {str(shell_error)}")
            
            logger.debug(f"Successfully deleted file: '{file_path}'")
            return self.success_response(f"File '{file_path}' deleted successfully.")
        except Exception as e:
            logger.error(f"Error deleting file '{file_path}': {str(e)}", exc_info=True)
            return self.fail_response(f"Error deleting file: {str(e)}")

    async def _call_morph_api(self, file_content: str, code_edit: str, instructions: str, file_path: str) -> tuple[Optional[str], Optional[str]]:
        """
        Call Morph API to apply edits to file content.
        Returns a tuple (new_content, error_message).
        On success, error_message is None.
        On failure, new_content is None.
        """
        try:
            morph_api_key = getattr(config, 'MORPH_API_KEY', None) or os.getenv('MORPH_API_KEY')
            openrouter_key = getattr(config, 'OPENROUTER_API_KEY', None) or os.getenv('OPENROUTER_API_KEY')
            
            messages = [{
                "role": "user", 
                "content": f"<instruction>{instructions}</instruction>\n<code>{file_content}</code>\n<update>{code_edit}</update>"
            }]

            response = None
            if morph_api_key:
                logger.debug("Using direct Morph API for file editing.")
                client = openai.AsyncOpenAI(
                    api_key=morph_api_key,
                    base_url="https://api.morphllm.com/v1"
                )
                response = await client.chat.completions.create(
                    model="morph-v3-large",
                    messages=messages,
                    temperature=0.0,
                    timeout=30.0
                )
            elif openrouter_key:
                logger.debug("Morph API key not set, falling back to OpenRouter for file editing via litellm.")
                response = await litellm.acompletion(
                    model="openrouter/morph/morph-v3-large",
                    messages=messages,
                    api_key=openrouter_key,
                    api_base="https://openrouter.ai/api/v1",
                    temperature=0.0,
                    timeout=30.0,
                    extra_body={"app": "Kortix.com"}
                )
            else:
                error_msg = "No Morph or OpenRouter API key found, cannot perform AI edit."
                logger.warning(error_msg)
                return None, error_msg
            
            if response and response.choices and len(response.choices) > 0:
                content = response.choices[0].message.content.strip()

                # Extract code block if wrapped in markdown
                if content.startswith("```") and content.endswith("```"):
                    lines = content.split('\n')
                    if len(lines) > 2:
                        content = '\n'.join(lines[1:-1])
                
                return content, None
            else:
                error_msg = f"Invalid response from Morph/OpenRouter API: {response}"
                logger.error(error_msg)
                return None, error_msg
                
        except Exception as e:
            error_message = f"AI model call for file edit failed. Exception: {str(e)}"
            # Try to get more details from the exception if it's an API error
            if hasattr(e, 'response') and hasattr(e.response, 'text'):
                error_message += f"\n\nAPI Response Body:\n{e.response.text}"
            elif hasattr(e, 'body'): # litellm sometimes puts it in body
                error_message += f"\n\nAPI Response Body:\n{e.body}"
            logger.error(f"Error calling Morph/OpenRouter API: {error_message}", exc_info=True)
            return None, error_message

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "edit_file",
            "description": "Use this tool to make an edit to an existing file.\n\nThis will be read by a less intelligent model, which will quickly apply the edit. You should make it clear what the edit is, while also minimizing the unchanged code you write.\nWhen writing the edit, you should specify each edit in sequence, with the special comment // ... existing code ... to represent unchanged code in between edited lines.\n\nFor example:\n\n// ... existing code ...\nFIRST_EDIT\n// ... existing code ...\nSECOND_EDIT\n// ... existing code ...\nTHIRD_EDIT\n// ... existing code ...\n\nYou should still bias towards repeating as few lines of the original file as possible to convey the change.\nBut, each edit should contain sufficient context of unchanged lines around the code you're editing to resolve ambiguity.\nDO NOT omit spans of pre-existing code (or comments) without using the // ... existing code ... comment to indicate its absence. If you omit the existing code comment, the model may inadvertently delete these lines.\nIf you plan on deleting a section, you must provide context before and after to delete it. If the initial code is ```code \\n Block 1 \\n Block 2 \\n Block 3 \\n code```, and you want to remove Block 2, you would output ```// ... existing code ... \\n Block 1 \\n  Block 3 \\n // ... existing code ...```.\nMake sure it is clear what the edit should be, and where it should be applied.\nALWAYS make all edits to a file in a single edit_file instead of multiple edit_file calls to the same file. The apply model can handle many distinct edits at once. **🚨 PARAMETER NAMES**: Use EXACTLY these parameter names: `target_file` (REQUIRED), `instructions` (REQUIRED), `code_edit` (REQUIRED).",
            "parameters": {
                "type": "object",
                "properties": {
                    "target_file": {
                        "type": "string",
                        "description": "**REQUIRED** - The target file to modify, relative to /workspace. Example: 'src/main.py' for /workspace/src/main.py."
                    },
                    "instructions": {
                        "type": "string", 
                        "description": "**REQUIRED** - A single sentence written in the first person describing what you're changing. Used to help disambiguate uncertainty in the edit. Example: 'I'm adding error handling to the login function'."
                    },
                    "code_edit": {
                        "type": "string",
                        "description": "**REQUIRED** - Specify ONLY the precise lines of code that you wish to edit. Use // ... existing code ... for unchanged sections. Include sufficient context around edits."
                    }
                },
                "required": ["target_file", "instructions", "code_edit"],
                "additionalProperties": False
            }
        }
    })
    async def edit_file(self, target_file: str, instructions: str, code_edit: str) -> ToolResult:
        try:
            await self._ensure_sandbox()
            
            target_file = self.clean_path(target_file)
            full_path = self._get_full_path(target_file)
            if not await self._file_exists(full_path):
                return self.fail_response(f"File '{target_file}' does not exist")
            
            original_content = (await self.sandbox.fs.download_file(full_path)).decode()
            
            is_tiptap_doc = False
            original_wrapper = None
            if target_file.startswith("docs/") and target_file.endswith(".doc"):
                try:
                    original_wrapper = json.loads(original_content)
                    if original_wrapper.get("type") == "tiptap_document":
                        is_tiptap_doc = True
                except json.JSONDecodeError:
                    pass
            
            logger.debug(f"Attempting AI-powered edit for file '{target_file}' with instructions: {instructions[:100]}...")
            new_content, error_message = await self._call_morph_api(original_content, code_edit, instructions, target_file)

            if error_message:
                if is_tiptap_doc and original_wrapper:
                    logger.debug(f"Morph AI edit failed for TipTap doc: {error_message}, attempting fallback manual update")
                    
                    if "title" in instructions:
                        import re
                        title_match = re.search(r'"title"\s*field\s*to\s*"([^"]+)"', instructions)
                        if title_match:
                            original_wrapper["title"] = title_match.group(1)
                    
                    if "content" in instructions and "content" in code_edit:
                        content_match = re.search(r'"content":\s*([^,}]+)', code_edit)
                        if content_match:
                            try:
                                new_html_content = json.loads(content_match.group(1).strip())
                                original_wrapper["content"] = new_html_content
                            except:
                                pass
                    
                    if "metadata" in instructions:
                        metadata_match = re.search(r'"metadata":\s*({[^}]+})', code_edit)
                        if metadata_match:
                            try:
                                new_metadata = json.loads(metadata_match.group(1))
                                original_wrapper["metadata"] = new_metadata
                            except:
                                pass
                    
                    if "updated_at" in instructions:
                        from datetime import datetime
                        original_wrapper["updated_at"] = datetime.now().isoformat()
                    
                    new_content = json.dumps(original_wrapper, indent=2)
                else:
                    return ToolResult(success=False, output=json.dumps({
                        "message": f"AI editing failed: {error_message}",
                        "file_path": target_file,
                        "original_content": original_content,
                        "updated_content": None
                    }))

            if new_content is None:
                return ToolResult(success=False, output=json.dumps({
                    "message": "AI editing failed for an unknown reason. The model returned no content.",
                    "file_path": target_file,
                    "original_content": original_content,
                    "updated_content": None
                }))

            if new_content == original_content:
                return ToolResult(success=True, output=json.dumps({
                    "message": f"AI editing resulted in no changes to the file '{target_file}'.",
                    "file_path": target_file,
                    "original_content": original_content,
                    "updated_content": original_content
                }))

            await self.sandbox.fs.upload_file(new_content.encode(), full_path)
            
            return ToolResult(success=True, output=json.dumps({
                "message": f"File '{target_file}' edited successfully.",
                "file_path": target_file,
                "original_content": original_content,
                "updated_content": new_content
            }))
                    
        except Exception as e:
            logger.error(f"Unhandled error in edit_file: {str(e)}", exc_info=True)
            # Try to get original_content if possible
            original_content_on_error = None
            try:
                full_path_on_error = f"{self.workspace_path}/{self.clean_path(target_file)}"
                if await self._file_exists(full_path_on_error):
                    original_content_on_error = (await self.sandbox.fs.download_file(full_path_on_error)).decode()
            except:
                pass
            
            return ToolResult(success=False, output=json.dumps({
                "message": f"Error editing file: {str(e)}",
                "file_path": target_file,
                "original_content": original_content_on_error,
                "updated_content": None
            }))

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "export_to_pdf",
            "description": "Export an HTML file to PDF format using high-quality Playwright/Chromium rendering. Use this instead of shell commands like 'npx html-pdf' or 'wkhtmltopdf' for better quality output.",
            "parameters": {
                "type": "object",
                "properties": {
                    "file_path": {
                        "type": "string",
                        "description": "Path to the HTML file to export (e.g., 'index.html' or 'output/report.html')"
                    }
                },
                "required": ["file_path"]
            }
        }
    })
    async def export_to_pdf(self, file_path: str) -> ToolResult:
        """Export an HTML file to PDF using sandbox Playwright rendering."""
        try:
            await self._ensure_sandbox()

            cleaned_path = self.clean_path(file_path)
            full_path = self._get_full_path(file_path)

            # Check file exists
            if not await self._file_exists(full_path):
                return self.fail_response(f"File '{file_path}' does not exist")

            # Check it's an HTML file
            if not cleaned_path.lower().endswith(('.html', '.htm')):
                return self.fail_response(f"File '{file_path}' is not an HTML file. Only .html/.htm files can be exported to PDF.")

            # Determine output filename
            base_name = cleaned_path.rsplit('.', 1)[0] if '.' in cleaned_path else cleaned_path
            output_filename = f"{base_name.replace('/', '_')}.pdf"

            logger.info(f"[export_to_pdf] Exporting {cleaned_path} to PDF")

            # Call sandbox html-to-pdf endpoint
            from core.services.http_client import get_http_client
            async with get_http_client() as client:
                response = await client.post(
                    f"{self.sandbox_url}/presentation/html-to-pdf",
                    json={
                        "file_path": cleaned_path,
                        "file_name": base_name.replace('/', '_')
                    },
                    timeout=120.0
                )

                if response.status_code == 200:
                    pdf_bytes = response.content

                    # Save to downloads folder
                    downloads_path = f"{self.workspace_path}/downloads"
                    output_path = f"{downloads_path}/{output_filename}"

                    # Ensure downloads directory exists
                    try:
                        await self.sandbox.fs.upload_file(pdf_bytes, output_path)
                    except Exception:
                        # Directory might not exist, create it
                        await self.sandbox.process.start(f"mkdir -p {downloads_path}")
                        await self.sandbox.fs.upload_file(pdf_bytes, output_path)

                    logger.info(f"[export_to_pdf] Success: {output_path}")

                    return self.success_response({
                        "message": f"Successfully exported '{file_path}' to PDF",
                        "output_file": f"downloads/{output_filename}",
                        "format": "pdf"
                    })
                else:
                    error_text = response.text
                    logger.error(f"[export_to_pdf] Failed: {response.status_code} - {error_text}")
                    return self.fail_response(f"PDF export failed: {error_text}")

        except Exception as e:
            logger.error(f"[export_to_pdf] Error: {str(e)}")
            return self.fail_response(f"PDF export failed: {str(e)}")
            