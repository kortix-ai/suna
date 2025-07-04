from agentpress.tool import ToolResult, openapi_schema, xml_schema
from sandbox.tool_base import SandboxToolsBase    
from utils.files_utils import should_exclude_file, clean_path
from agentpress.thread_manager import ThreadManager
from utils.logger import logger
import os

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
    @xml_schema(
        tag_name="create-file",
        mappings=[
            {"param_name": "file_path", "node_type": "attribute", "path": "."},
            {"param_name": "file_contents", "node_type": "content", "path": "."}
        ],
        example='''
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
        '''
    )
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
            "description": "Replace specific text in a file. The file path must be relative to /workspace (e.g., 'src/main.py' for /workspace/src/main.py). Use this when you need to replace a unique string that appears exactly once in the file.",
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
    @xml_schema(
        tag_name="str-replace",
        mappings=[
            {"param_name": "file_path", "node_type": "attribute", "path": "."},
            {"param_name": "old_str", "node_type": "element", "path": "old_str"},
            {"param_name": "new_str", "node_type": "element", "path": "new_str"}
        ],
        example='''
        <function_calls>
        <invoke name="str_replace">
        <parameter name="file_path">src/main.py</parameter>
        <parameter name="old_str">text to replace (must appear exactly once in the file)</parameter>
        <parameter name="new_str">replacement text that will be inserted instead</parameter>
        </invoke>
        </function_calls>
        '''
    )
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
            "description": "Completely rewrite an existing file with new content. The file path must be relative to /workspace (e.g., 'src/main.py' for /workspace/src/main.py). Use this when you need to replace the entire file content or make extensive changes throughout the file.",
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
    @xml_schema(
        tag_name="full-file-rewrite",
        mappings=[
            {"param_name": "file_path", "node_type": "attribute", "path": "."},
            {"param_name": "file_contents", "node_type": "content", "path": "."}
        ],
        example='''
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
        '''
    )
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
    @xml_schema(
        tag_name="delete-file",
        mappings=[
            {"param_name": "file_path", "node_type": "attribute", "path": "."}
        ],
        example='''
        <function_calls>
        <invoke name="delete_file">
        <parameter name="file_path">src/main.py</parameter>
        </invoke>
        </function_calls>
        '''
    )
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

