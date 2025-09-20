from core.agentpress.tool import ToolResult, openapi_schema, usage_example
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
from typing import Optional

class SandboxFilesTool(SandboxToolsBase):
    """Tool for executing file system operations in a Daytona sandbox. All operations are performed relative to the /workspace directory."""

    def __init__(self, project_id: str, thread_manager: ThreadManager):
        super().__init__(project_id, thread_manager)
        self.SNIPPET_LINES = 4  # Number of context lines to show around edits
        self.workspace_path = "/workspace"  # Ensure we're always operating in /workspace

    def clean_path(self, path: str) -> str:
        """Clean and normalize a path to be relative to /workspace"""
        return clean_path(path, self.workspace_path)

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
                    full_path = f"{self.workspace_path}/{rel_path}"
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
            "description": "Create a new file with the provided contents at a given path in the workspace. The path must be relative to /workspace (e.g., 'src/main.py' for /workspace/src/main.py)",
            "parameters": {
                "type": "object",
                "properties": {
                    "file_path": {
                        "type": "string",
                        "description": "Path to the file to be created, relative to /workspace (e.g., 'src/main.py')"
                    },
                    "file_contents": {
                        "type": "string",
                        "description": "The content to write to the file"
                    },
                    "permissions": {
                        "type": "string",
                        "description": "File permissions in octal format (e.g., '644')",
                        "default": "644"
                    }
                },
                "required": ["file_path", "file_contents"]
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="create_file">
        <parameter name="file_path">src/main.py</parameter>
        <parameter name="file_contents">
        # This is the file content
        def main():
            print("Hello, World!")
        
        if __name__ == "__main__":
            main()
        </parameter>
        </invoke>
        </function_calls>
        ''')
    async def create_file(self, file_path: str, file_contents: str, permissions: str = "644") -> ToolResult:
        try:
            # Ensure sandbox is initialized
            await self._ensure_sandbox()
            
            file_path = self.clean_path(file_path)
            full_path = f"{self.workspace_path}/{file_path}"
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
            
            # Check if index.html was created and add 8080 server info (only in root workspace)
            if file_path.lower() == 'index.html':
                try:
                    website_link = await self.sandbox.get_preview_link(8080)
                    website_url = website_link.url if hasattr(website_link, 'url') else str(website_link).split("url='")[1].split("'")[0]
                    message += f"\n\n[Auto-detected index.html - HTTP server available at: {website_url}]"
                    message += "\n[Note: Use the provided HTTP server URL above instead of starting a new server]"
                except Exception as e:
                    logger.warning(f"Failed to get website URL for index.html: {str(e)}")
            
            return self.success_response(message)
        except Exception as e:
            return self.fail_response(f"Error creating file: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "str_replace",
            "description": "Replace specific text in a file. The file path must be relative to /workspace (e.g., 'src/main.py' for /workspace/src/main.py). IMPORTANT: Prefer using edit_file for faster, shorter edits to avoid repetition. Only use this tool when you need to replace a unique string that appears exactly once in the file and edit_file is not suitable.",
            "parameters": {
                "type": "object",
                "properties": {
                    "file_path": {
                        "type": "string",
                        "description": "Path to the target file, relative to /workspace (e.g., 'src/main.py')"
                    },
                    "old_str": {
                        "type": "string",
                        "description": "Text to be replaced (must appear exactly once)"
                    },
                    "new_str": {
                        "type": "string",
                        "description": "Replacement text"
                    }
                },
                "required": ["file_path", "old_str", "new_str"]
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="str_replace">
        <parameter name="file_path">src/main.py</parameter>
        <parameter name="old_str">text to replace (must appear exactly once in the file)</parameter>
        <parameter name="new_str">replacement text that will be inserted instead</parameter>
        </invoke>
        </function_calls>
        ''')
    async def str_replace(self, file_path: str, old_str: str, new_str: str) -> ToolResult:
        try:
            # Ensure sandbox is initialized
            await self._ensure_sandbox()
            
            file_path = self.clean_path(file_path)
            full_path = f"{self.workspace_path}/{file_path}"
            if not await self._file_exists(full_path):
                return self.fail_response(f"File '{file_path}' does not exist")
            
            content = (await self.sandbox.fs.download_file(full_path)).decode()
            old_str = old_str.expandtabs()
            new_str = new_str.expandtabs()
            
            occurrences = content.count(old_str)
            if occurrences == 0:
                return self.fail_response(f"String '{old_str}' not found in file")
            if occurrences > 1:
                lines = [i+1 for i, line in enumerate(content.split('\n')) if old_str in line]
                return self.fail_response(f"Multiple occurrences found in lines {lines}. Please ensure string is unique")
            
            # Perform replacement
            new_content = content.replace(old_str, new_str)
            await self.sandbox.fs.upload_file(new_content.encode(), full_path)
            
            # Show snippet around the edit
            replacement_line = content.split(old_str)[0].count('\n')
            start_line = max(0, replacement_line - self.SNIPPET_LINES)
            end_line = replacement_line + self.SNIPPET_LINES + new_str.count('\n')
            snippet = '\n'.join(new_content.split('\n')[start_line:end_line + 1])
            
            # Get preview URL if it's an HTML file
            # preview_url = self._get_preview_url(file_path)
            message = f"Replacement successful."
            # if preview_url:
            #     message += f"\n\nYou can preview this HTML file at: {preview_url}"
            
            return self.success_response(message)
            
        except Exception as e:
            return self.fail_response(f"Error replacing string: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "full_file_rewrite",
            "description": "Completely rewrite an existing file with new content. The file path must be relative to /workspace (e.g., 'src/main.py' for /workspace/src/main.py). IMPORTANT: Always prefer using edit_file for making changes to code. Only use this tool when edit_file fails or when you need to replace the entire file content.",
            "parameters": {
                "type": "object",
                "properties": {
                    "file_path": {
                        "type": "string",
                        "description": "Path to the file to be rewritten, relative to /workspace (e.g., 'src/main.py')"
                    },
                    "file_contents": {
                        "type": "string",
                        "description": "The new content to write to the file, replacing all existing content"
                    },
                    "permissions": {
                        "type": "string",
                        "description": "File permissions in octal format (e.g., '644')",
                        "default": "644"
                    }
                },
                "required": ["file_path", "file_contents"]
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="full_file_rewrite">
        <parameter name="file_path">src/main.py</parameter>
        <parameter name="file_contents">
        This completely replaces the entire file content.
        Use when making major changes to a file or when the changes
        are too extensive for str-replace.
        All previous content will be lost and replaced with this text.
        </parameter>
        </invoke>
        </function_calls>
        ''')
    async def full_file_rewrite(self, file_path: str, file_contents: str, permissions: str = "644") -> ToolResult:
        try:
            # Ensure sandbox is initialized
            await self._ensure_sandbox()
            
            file_path = self.clean_path(file_path)
            full_path = f"{self.workspace_path}/{file_path}"
            if not await self._file_exists(full_path):
                return self.fail_response(f"File '{file_path}' does not exist. Use create_file to create a new file.")
            
            await self.sandbox.fs.upload_file(file_contents.encode(), full_path)
            await self.sandbox.fs.set_file_permissions(full_path, permissions)
            
            message = f"File '{file_path}' completely rewritten successfully."
            
            # Check if index.html was rewritten and add 8080 server info (only in root workspace)
            if file_path.lower() == 'index.html':
                try:
                    website_link = await self.sandbox.get_preview_link(8080)
                    website_url = website_link.url if hasattr(website_link, 'url') else str(website_link).split("url='")[1].split("'")[0]
                    message += f"\n\n[Auto-detected index.html - HTTP server available at: {website_url}]"
                    message += "\n[Note: Use the provided HTTP server URL above instead of starting a new server]"
                except Exception as e:
                    logger.warning(f"Failed to get website URL for index.html: {str(e)}")
            
            return self.success_response(message)
        except Exception as e:
            return self.fail_response(f"Error rewriting file: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "delete_file",
            "description": "Delete a file at the given path. The path must be relative to /workspace (e.g., 'src/main.py' for /workspace/src/main.py)",
            "parameters": {
                "type": "object",
                "properties": {
                    "file_path": {
                        "type": "string",
                        "description": "Path to the file to be deleted, relative to /workspace (e.g., 'src/main.py')"
                    }
                },
                "required": ["file_path"]
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="delete_file">
        <parameter name="file_path">src/main.py</parameter>
        </invoke>
        </function_calls>
        ''')
    async def delete_file(self, file_path: str) -> ToolResult:
        try:
            # Ensure sandbox is initialized
            await self._ensure_sandbox()
            
            file_path = self.clean_path(file_path)
            full_path = f"{self.workspace_path}/{file_path}"
            if not await self._file_exists(full_path):
                return self.fail_response(f"File '{file_path}' does not exist")
            
            await self.sandbox.fs.delete_file(full_path)
            return self.success_response(f"File '{file_path}' deleted successfully.")
        except Exception as e:
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
                    timeout=30.0
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
            "description": "Use this tool to make an edit to an existing file.\n\nThis will be read by a less intelligent model, which will quickly apply the edit. You should make it clear what the edit is, while also minimizing the unchanged code you write.\nWhen writing the edit, you should specify each edit in sequence, with the special comment // ... existing code ... to represent unchanged code in between edited lines.\n\nFor example:\n\n// ... existing code ...\nFIRST_EDIT\n// ... existing code ...\nSECOND_EDIT\n// ... existing code ...\nTHIRD_EDIT\n// ... existing code ...\n\nYou should still bias towards repeating as few lines of the original file as possible to convey the change.\nBut, each edit should contain sufficient context of unchanged lines around the code you're editing to resolve ambiguity.\nDO NOT omit spans of pre-existing code (or comments) without using the // ... existing code ... comment to indicate its absence. If you omit the existing code comment, the model may inadvertently delete these lines.\nIf you plan on deleting a section, you must provide context before and after to delete it. If the initial code is ```code \\n Block 1 \\n Block 2 \\n Block 3 \\n code```, and you want to remove Block 2, you would output ```// ... existing code ... \\n Block 1 \\n  Block 3 \\n // ... existing code ...```.\nMake sure it is clear what the edit should be, and where it should be applied.\nALWAYS make all edits to a file in a single edit_file instead of multiple edit_file calls to the same file. The apply model can handle many distinct edits at once.",
            "parameters": {
                "type": "object",
                "properties": {
                    "target_file": {
                        "type": "string",
                        "description": "The target file to modify"
                    },
                    "instructions": {
                        "type": "string", 
                        "description": "A single sentence written in the first person describing what you're changing. Used to help disambiguate uncertainty in the edit."
                    },
                    "code_edit": {
                        "type": "string",
                        "description": "Specify ONLY the precise lines of code that you wish to edit. Use // ... existing code ... for unchanged sections."
                    }
                },
                "required": ["target_file", "instructions", "code_edit"]
            }
        }
    })
    @usage_example('''
        <!-- Example: Mark multiple scattered tasks as complete in a todo list -->
        <function_calls>
        <invoke name="edit_file">
        <parameter name="target_file">todo.md</parameter>
        <parameter name="instructions">I am marking the research and setup tasks as complete in my todo list.</parameter>
        <parameter name="code_edit">
// ... existing code ...
- [x] Research topic A
- [ ] Research topic B
- [x] Research topic C
// ... existing code ...
- [x] Setup database
- [x] Configure server
// ... existing code ...
        </parameter>
        </invoke>
        </function_calls>

        <!-- Example: Add error handling and logging to a function -->
        <function_calls>
        <invoke name="edit_file">
        <parameter name="target_file">src/main.py</parameter>
        <parameter name="instructions">I am adding error handling and logging to the user authentication function</parameter>
        <parameter name="code_edit">
// ... existing imports ...
from my_app.logging import logger
from my_app.exceptions import DatabaseError
// ... existing code ...
def authenticate_user(username, password):
    try:
        user = get_user(username)
        if user and verify_password(password, user.password_hash):
            return user
        return None
    except DatabaseError as e:
        logger.error(f"Database error during authentication: {e}")
        return None
    except Exception as e:
        logger.error(f"Unexpected error during authentication: {e}")
        return None
// ... existing code ...
        </parameter>
        </invoke>
        </function_calls>
        ''')
    async def edit_file(self, target_file: str, instructions: str, code_edit: str) -> ToolResult:
        try:
            await self._ensure_sandbox()
            
            target_file = self.clean_path(target_file)
            full_path = f"{self.workspace_path}/{target_file}"
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

    # @openapi_schema({
    #     "type": "function",
    #     "function": {
    #         "name": "read_file",
    #         "description": "Read and return the contents of a file. This tool is essential for verifying data, checking file contents, and analyzing information. Always use this tool to read file contents before processing or analyzing data. The file path must be relative to /workspace.",
    #         "parameters": {
    #             "type": "object",
    #             "properties": {
    #                 "file_path": {
    #                     "type": "string",
    #                     "description": "Path to the file to read, relative to /workspace (e.g., 'src/main.py' for /workspace/src/main.py). Must be a valid file path within the workspace."
    #                 },
    #                 "start_line": {
    #                     "type": "integer",
    #                     "description": "Optional starting line number (1-based). Use this to read specific sections of large files. If not specified, reads from the beginning of the file.",
    #                     "default": 1
    #                 },
    #                 "end_line": {
    #                     "type": "integer",
    #                     "description": "Optional ending line number (inclusive). Use this to read specific sections of large files. If not specified, reads to the end of the file.",
    #                     "default": None
    #                 }
    #             },
    #             "required": ["file_path"]
    #         }
    #     }
    # })
    # @xml_schema(
    #     tag_name="read-file",
    #     mappings=[
    #         {"param_name": "file_path", "node_type": "attribute", "path": "."},
    #         {"param_name": "start_line", "node_type": "attribute", "path": ".", "required": False},
    #         {"param_name": "end_line", "node_type": "attribute", "path": ".", "required": False}
    #     ],
    #     example='''
    #     <!-- Example 1: Read entire file -->
    #     <read-file file_path="src/main.py">
    #     </read-file>

    #     <!-- Example 2: Read specific lines (lines 10-20) -->
    #     <read-file file_path="src/main.py" start_line="10" end_line="20">
    #     </read-file>

    #     <!-- Example 3: Read from line 5 to end -->
    #     <read-file file_path="config.json" start_line="5">
    #     </read-file>

    #     <!-- Example 4: Read last 10 lines -->
    #     <read-file file_path="logs/app.log" start_line="-10">
    #     </read-file>
    #     '''
    # )
    # async def read_file(self, file_path: str, start_line: int = 1, end_line: Optional[int] = None) -> ToolResult:
    #     """Read file content with optional line range specification.
        
    #     Args:
    #         file_path: Path to the file relative to /workspace
    #         start_line: Starting line number (1-based), defaults to 1
    #         end_line: Ending line number (inclusive), defaults to None (end of file)
            
    #     Returns:
    #         ToolResult containing:
    #         - Success: File content and metadata
    #         - Failure: Error message if file doesn't exist or is binary
    #     """
    #     try:
    #         file_path = self.clean_path(file_path)
    #         full_path = f"{self.workspace_path}/{file_path}"
            
    #         if not await self._file_exists(full_path):
    #             return self.fail_response(f"File '{file_path}' does not exist")
            
    #         # Download and decode file content
    #         content = await self.sandbox.fs.download_file(full_path).decode()
            
    #         # Split content into lines
    #         lines = content.split('\n')
    #         total_lines = len(lines)
            
    #         # Handle line range if specified
    #         if start_line > 1 or end_line is not None:
    #             # Convert to 0-based indices
    #             start_idx = max(0, start_line - 1)
    #             end_idx = end_line if end_line is not None else total_lines
    #             end_idx = min(end_idx, total_lines)  # Ensure we don't exceed file length
                
    #             # Extract the requested lines
    #             content = '\n'.join(lines[start_idx:end_idx])
            
    #         return self.success_response({
    #             "content": content,
    #             "file_path": file_path,
    #             "start_line": start_line,
    #             "end_line": end_line if end_line is not None else total_lines,
    #             "total_lines": total_lines
    #         })
            
    #     except UnicodeDecodeError:
    #         return self.fail_response(f"File '{file_path}' appears to be binary and cannot be read as text")
    #     except Exception as e:
    #         return self.fail_response(f"Error reading file: {str(e)}")