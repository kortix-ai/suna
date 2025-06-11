from typing import Optional
from agentpress.tool import ToolResult, openapi_schema, xml_schema
from sandbox.tool_base import SandboxToolsBase
from agentpress.thread_manager import ThreadManager
from openai import OpenAI
import httpx
import os
from io import BytesIO
import uuid


class SandboxImageEditTool(SandboxToolsBase):
    """Tool for generating or editing images using OpenAI DALL-E via OpenAI SDK (no mask support)."""

    def __init__(self, project_id: str, thread_id: str, thread_manager: ThreadManager):
        super().__init__(project_id, thread_manager)
        self.thread_id = thread_id
        self.thread_manager = thread_manager
        self.client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

    @openapi_schema(
        {
            "type": "function",
            "function": {
                "name": "image_edit_or_generate",
                "description": "Generate a new image from a prompt, or edit an existing image (no mask support) using OpenAI DALL-E via OpenAI SDK. Stores the result in the thread context.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "mode": {
                            "type": "string",
                            "enum": ["generate", "edit"],
                            "description": "'generate' to create a new image from a prompt, 'edit' to edit an existing image.",
                        },
                        "prompt": {
                            "type": "string",
                            "description": "Text prompt describing the desired image or edit.",
                        },
                        "image_path": {
                            "type": "string",
                            "description": "(edit mode only) Path to the image file to edit, relative to /workspace. Required for 'edit'.",
                        },
                    },
                    "required": ["mode", "prompt"],
                },
            },
        }
    )
    @xml_schema(
        tag_name="image-edit-or-generate",
        mappings=[
            {"param_name": "mode", "node_type": "attribute", "path": "."},
            {"param_name": "prompt", "node_type": "attribute", "path": "."},
            {"param_name": "image_path", "node_type": "attribute", "path": "."},
        ],
        example="""
        <function_calls>
        <invoke name="image_edit_or_generate">
        <parameter name="mode">generate</parameter>
        <parameter name="prompt">A futuristic cityscape at sunset</parameter>
        </invoke>
        </function_calls>
        """,
    )
    async def image_edit_or_generate(
        self,
        mode: str,
        prompt: str,
        image_path: Optional[str] = None,
    ) -> ToolResult:
        """Generate or edit images using OpenAI DALL-E via OpenAI SDK (no mask support)."""
        try:
            await self._ensure_sandbox()

            if mode == "generate":
                response = self.client.images.generate(
                    prompt=prompt, n=1, size="1024x1024"
                )
            elif mode == "edit":
                if not image_path:
                    return self.fail_response("'image_path' is required for edit mode.")

                image_bytes = await self._get_image_bytes(image_path)
                if isinstance(image_bytes, ToolResult):  # Error occurred
                    return image_bytes

                # Create BytesIO object with proper filename to set MIME type
                image_io = BytesIO(image_bytes)
                image_io.name = "image.png"  # Set filename to ensure proper MIME type detection
                
                response = self.client.images.edit(
                    image=image_io, prompt=prompt, n=1, size="1024x1024"
                )
            else:
                return self.fail_response("Invalid mode. Use 'generate' or 'edit'.")

            # Download and save the generated image to sandbox
            image_filename = await self._process_image_response(response)
            if isinstance(image_filename, ToolResult):  # Error occurred
                return image_filename

            return self.success_response(
                f"Successfully generated image using mode '{mode}'. Image saved as: {image_filename}. You can use the ask tool to display the image."
            )

        except Exception as e:
            return self.fail_response(
                f"An error occurred during image generation/editing: {str(e)}"
            )

    async def _get_image_bytes(self, image_path: str) -> bytes | ToolResult:
        """Get image bytes from URL or local file path."""
        if image_path.startswith(("http://", "https://")):
            return await self._download_image_from_url(image_path)
        else:
            return await self._read_image_from_sandbox(image_path)

    async def _download_image_from_url(self, url: str) -> bytes | ToolResult:
        """Download image from URL."""
        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(url)
                response.raise_for_status()
                return response.content
        except Exception:
            return self.fail_response(f"Could not download image from URL: {url}")

    async def _read_image_from_sandbox(self, image_path: str) -> bytes | ToolResult:
        """Read image from sandbox filesystem."""
        try:
            cleaned_path = self.clean_path(image_path)
            full_path = f"{self.workspace_path}/{cleaned_path}"

            # Check if file exists and is not a directory
            file_info = self.sandbox.fs.get_file_info(full_path)
            if file_info.is_dir:
                return self.fail_response(
                    f"Path '{cleaned_path}' is a directory, not an image file."
                )

            return self.sandbox.fs.download_file(full_path)

        except Exception as e:
            return self.fail_response(
                f"Could not read image file from sandbox: {image_path} - {str(e)}"
            )

    async def _process_image_response(self, response) -> str | ToolResult:
        """Download generated image and save to sandbox with random name."""
        try:
            original_url = response.data[0].url

            async with httpx.AsyncClient() as client:
                img_response = await client.get(original_url)
                img_response.raise_for_status()

            # Generate random filename

            random_filename = f"generated_image_{uuid.uuid4().hex[:8]}.png"
            sandbox_path = f"{self.workspace_path}/{random_filename}"

            # Save image to sandbox
            self.sandbox.fs.upload_file(sandbox_path, img_response.content)
            return random_filename

        except Exception as e:
            return self.fail_response(f"Failed to download and save image: {str(e)}")
