import os
import base64
import mimetypes
from typing import Optional
import datetime

from agentpress.tool import ToolResult, openapi_schema, xml_schema
from sandbox.tool_base import SandboxToolsBase
from agentpress.thread_manager import ThreadManager
from utils.logger import logger
import json

# Add common image MIME types if mimetypes module is limited
mimetypes.add_type("image/webp", ".webp")
mimetypes.add_type("image/jpeg", ".jpg")
mimetypes.add_type("image/jpeg", ".jpeg")
mimetypes.add_type("image/png", ".png")
mimetypes.add_type("image/gif", ".gif")

# Maximum file size in bytes (e.g., 5MB)
MAX_IMAGE_SIZE = 10 * 1024 * 1024

class SandboxVisionTool(SandboxToolsBase):
    """Tool for allowing the agent to 'see' images within the sandbox."""

    def __init__(self, project_id: str, thread_id: str, thread_manager: ThreadManager):
        super().__init__(project_id, thread_manager)
        self.thread_id = thread_id
        self.thread_manager = thread_manager
        self.memory_tool = None
        self._initialized = False

    async def _ensure_initialized(self):
        """Ensure the memory tool is initialized."""
        if not self._initialized:
            try:
                # Get memory tool from thread manager's tool registry
                from agent.tools.memory_tool import MemoryTool  # Import here to avoid circular imports
                tool_info = self.thread_manager.tool_registry.get_tool("save-memory")  # Get tool by function name
                if tool_info and 'instance' in tool_info:
                    self.memory_tool = tool_info['instance']
                    logger.info("Successfully initialized memory tool")
                else:
                    logger.warning("Memory tool not available for vision operations")
                self._initialized = True
            except Exception as e:
                logger.error(f"Failed to initialize memory tool: {e}")
                # Continue without memory tool
                self._initialized = True  # Mark as initialized to prevent repeated attempts

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "see_image",
            "description": "Allows the agent to 'see' an image file located in the /workspace directory. Provide the relative path to the image. The image content will be made available in the next turn's context.",
            "parameters": {
                "type": "object",
                "properties": {
                    "file_path": {
                        "type": "string",
                        "description": "The relative path to the image file within the /workspace directory (e.g., 'screenshots/image.png'). Supported formats: JPG, PNG, GIF, WEBP. Max size: 5MB."
                    }
                },
                "required": ["file_path"]
            }
        }
    })
    @xml_schema(
        tag_name="see-image",
        mappings=[
            {"param_name": "file_path", "node_type": "attribute", "path": "."}
        ],
        example='''
        <!-- Example: Request to see an image named 'diagram.png' inside the 'docs' folder -->
        <see-image file_path="docs/diagram.png"></see-image>
        '''
    )
    async def see_image(self, file_path: str) -> ToolResult:
        """Reads an image file, converts it to base64, and adds it as a temporary message."""
        try:
            # Ensure tools are initialized
            await self._ensure_sandbox()
            await self._ensure_initialized()

            # Clean and construct full path
            cleaned_path = self.clean_path(file_path)
            full_path = f"{self.workspace_path}/{cleaned_path}"

            # Check if file exists and get info
            try:
                file_info = self.sandbox.fs.get_file_info(full_path)
                if file_info.is_dir:
                    return self.fail_response(f"Path '{cleaned_path}' is a directory, not an image file.")
            except Exception as e:
                return self.fail_response(f"Image file not found at path: '{cleaned_path}'")

            # Check file size
            if file_info.size > MAX_IMAGE_SIZE:
                return self.fail_response(f"Image file '{cleaned_path}' is too large ({file_info.size / (1024*1024):.2f}MB). Maximum size is {MAX_IMAGE_SIZE / (1024*1024)}MB.")

            # Read image file content
            try:
                image_bytes = self.sandbox.fs.download_file(full_path)
            except Exception as e:
                return self.fail_response(f"Could not read image file: {cleaned_path}")

            # Convert to base64
            base64_image = base64.b64encode(image_bytes).decode('utf-8')

            # Determine MIME type
            mime_type, _ = mimetypes.guess_type(full_path)
            if not mime_type or not mime_type.startswith('image/'):
                # Basic fallback based on extension if mimetypes fails
                ext = os.path.splitext(cleaned_path)[1].lower()
                if ext == '.jpg' or ext == '.jpeg': mime_type = 'image/jpeg'
                elif ext == '.png': mime_type = 'image/png'
                elif ext == '.gif': mime_type = 'image/gif'
                elif ext == '.webp': mime_type = 'image/webp'
                else:
                    return self.fail_response(f"Unsupported or unknown image format for file: '{cleaned_path}'. Supported: JPG, PNG, GIF, WEBP.")

            # Prepare the temporary message content
            image_context_data = {
                "mime_type": mime_type,
                "base64": base64_image,
                "file_path": cleaned_path,
                "file_size": file_info.size,
                "timestamp": datetime.datetime.now().isoformat()
            }

            # Store image information in memory if memory tool is available
            if self.memory_tool:
                try:
                    # Create a memory of the image
                    memory_content = f"Image Analysis: {cleaned_path}\n"
                    memory_content += f"Type: {mime_type}\n"
                    memory_content += f"Size: {file_info.size / (1024*1024):.2f}MB\n"
                    memory_content += f"Path: {cleaned_path}\n\n"
                    
                    # Add image metadata if available
                    if hasattr(file_info, 'metadata'):
                        memory_content += "Image Metadata:\n"
                        for key, value in file_info.metadata.items():
                            memory_content += f"- {key}: {value}\n"
                    
                    # Save to memory with high importance for large or important images
                    importance_score = 0.6  # Default
                    if file_info.size > 5 * 1024 * 1024:  # > 5MB
                        importance_score = 0.8
                    
                    await self.memory_tool.save_memory(
                        thread_id=self.thread_manager.current_thread_id,
                        content=memory_content,
                        memory_type="episodic",  # Image analysis is episodic memory
                        importance_score=importance_score,
                        tags=["vision", "image", mime_type.split('/')[-1], "analysis"],
                        metadata={
                            "file_path": cleaned_path,
                            "mime_type": mime_type,
                            "file_size": file_info.size,
                            "timestamp": datetime.datetime.now().isoformat(),
                            "has_metadata": hasattr(file_info, 'metadata')
                        }
                    )
                except Exception as e:
                    logger.error(f"Failed to store image information in memory: {e}")

            # Add the temporary message using the thread_manager callback
            await self.thread_manager.add_message(
                thread_id=self.thread_id,
                type="image_context",
                content=image_context_data,
                is_llm_message=False
            )

            return self.success_response(f"Successfully loaded the image '{cleaned_path}'.")

        except Exception as e:
            return self.fail_response(f"An unexpected error occurred while trying to see the image: {str(e)}") 