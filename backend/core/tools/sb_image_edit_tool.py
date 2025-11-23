from typing import Optional
from core.agentpress.tool import ToolResult, openapi_schema, tool_metadata
from core.sandbox.tool_base import SandboxToolsBase
from core.agentpress.thread_manager import ThreadManager
import httpx
from io import BytesIO
import uuid
from litellm import aimage_generation, aimage_edit
import base64

@tool_metadata(
    display_name="Image Editor",
    description="Generate and edit images with AI assistance",
    icon="Wand",
    color="bg-purple-100 dark:bg-purple-800/50",
    weight=50,
    visible=True
)
class SandboxImageEditTool(SandboxToolsBase):
    """Tool for generating or editing images using OpenAI GPT Image 1 via OpenAI SDK (no mask support)."""

    TOOL_INSTRUCTIONS = """### IMAGE GENERATION & EDITING (GENERAL)
                    - Use the 'image_edit_or_generate' tool to generate new images from a prompt or to edit an existing image file (no mask support)
                    
                    **CRITICAL: USE EDIT MODE FOR MULTI-TURN IMAGE MODIFICATIONS**
                    * **When user wants to modify an existing image:** ALWAYS use mode="edit" with the image_path parameter
                    * **When user wants to create a new image:** Use mode="generate" without image_path
                    * **MULTI-TURN WORKFLOW:** If you've generated an image and user asks for ANY follow-up changes, ALWAYS use edit mode
                    * **ASSUME FOLLOW-UPS ARE EDITS:** When user says "change this", "add that", "make it different", etc. - use edit mode
                    * **Image path sources:** Can be a workspace file path (e.g., "generated_image_abc123.png") OR a full URL
                    
                    **GENERATE MODE (Creating new images):**
                    * Set mode="generate" and provide a descriptive prompt
                    * Example:
                        <function_calls>
                        <invoke name="image_edit_or_generate">
                        <parameter name="mode">generate</parameter>
                        <parameter name="prompt">A futuristic cityscape at sunset with neon lights</parameter>
                        </invoke>
                        </function_calls>
                    
                    **EDIT MODE (Modifying existing images):**
                    * Set mode="edit", provide editing prompt, and specify the image_path
                    * Use this when user asks to: modify, change, add to, remove from, or alter existing images
                    * Example with workspace file:
                        <function_calls>
                        <invoke name="image_edit_or_generate">
                        <parameter name="mode">edit</parameter>
                        <parameter name="prompt">Add a red hat to the person in the image</parameter>
                        <parameter name="image_path">generated_image_abc123.png</parameter>
                        </invoke>
                        </function_calls>
                    * Example with URL:
                        <function_calls>
                        <invoke name="image_edit_or_generate">
                        <parameter name="mode">edit</parameter>
                        <parameter name="prompt">Change the background to a mountain landscape</parameter>
                        <parameter name="image_path">https://example.com/images/photo.png</parameter>
                        </invoke>
                        </function_calls>
                    
                    **MULTI-TURN WORKFLOW EXAMPLE:**
                    * Step 1 - User: "Create a logo for my company"
                        → Use generate mode: creates "generated_image_abc123.png"
                    * Step 2 - User: "Can you make it more colorful?"
                        → Use edit mode with "generated_image_abc123.png" (AUTOMATIC - this is a follow-up)
                    * Step 3 - User: "Add some text to it"
                        → Use edit mode with the most recent image (AUTOMATIC - this is another follow-up)
                    
                    **MANDATORY USAGE RULES:**
                    * ALWAYS use this tool for any image creation or editing tasks
                    * NEVER attempt to generate or edit images by any other means
                    * MUST use edit mode when user asks to edit, modify, change, or alter an existing image
                    * MUST use generate mode when user asks to create a new image from scratch
                    * **MULTI-TURN CONVERSATION RULE:** If you've created an image and user provides ANY follow-up feedback or requests changes, AUTOMATICALLY use edit mode with the previous image
                    * **FOLLOW-UP DETECTION:** User phrases like "can you change...", "make it more...", "add a...", "remove the...", "make it different" = EDIT MODE
                    * After image generation/editing, ALWAYS display the result using the ask tool with the image attached
                    * The tool automatically saves images to the workspace with unique filenames
                    * **REMEMBER THE LAST IMAGE:** Always use the most recently generated image filename for follow-up edits
                    * **OPTIONAL CLOUD SHARING:** Ask user if they want to upload images: "Would you like me to upload this image to secure cloud storage for sharing?"
                    * **CLOUD WORKFLOW (if requested):** Generate/Edit → Save to workspace → Ask user → Upload to "file-uploads" bucket if requested → Share public URL with user
                """

    def __init__(self, project_id: str, thread_id: str, thread_manager: ThreadManager):
        super().__init__(project_id, thread_manager)
        self.thread_id = thread_id
        self.thread_manager = thread_manager


    @openapi_schema(
        {
            "type": "function",
            "function": {
                "name": "image_edit_or_generate",
                "description": "Generate a new image from a prompt, or edit an existing image (no mask support) using OpenAI GPT Image 1 via OpenAI SDK. Stores the result in the thread context.",
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
                            "description": "(edit mode only) Path to the image file to edit. Can be: 1) Relative path to /workspace (e.g., 'generated_image_abc123.png'), or 2) Full URL (e.g., 'https://example.com/image.png'). Required when mode='edit'.",
                        },
                    },
                    "required": ["mode", "prompt"],
                },
            },
        }
    )
    async def image_edit_or_generate(
        self,
        mode: str,
        prompt: str,
        image_path: Optional[str] = None,
    ) -> ToolResult:
        """Generate or edit images using OpenAI GPT Image 1 via OpenAI SDK (no mask support)."""
        try:
            await self._ensure_sandbox()
            model="gpt-image-1"

            if mode == "generate":
                response = await aimage_generation(
                    model=model,
                    prompt=prompt,
                    n=1,
                    size="1024x1024",
                )
            elif mode == "edit":
                if not image_path:
                    return self.fail_response("'image_path' is required for edit mode.")
 
                image_bytes = await self._get_image_bytes(image_path)
                if isinstance(image_bytes, ToolResult):  # Error occurred
                    return image_bytes

                # Create BytesIO object with proper filename to set MIME type
                image_io = BytesIO(image_bytes)
                image_io.name = (
                    "image.png"  # Set filename to ensure proper MIME type detection
                )

                response = await aimage_edit(
                    image=[image_io],  # Type in the LiteLLM SDK is wrong
                    prompt=prompt,
                    model=model,
                    n=1,
                    size="1024x1024",
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
            file_info = await self.sandbox.fs.get_file_info(full_path)
            if file_info.is_dir:
                return self.fail_response(
                    f"Path '{cleaned_path}' is a directory, not an image file."
                )

            return await self.sandbox.fs.download_file(full_path)

        except Exception as e:
            return self.fail_response(
                f"Could not read image file from sandbox: {image_path} - {str(e)}"
            )

    async def _process_image_response(self, response) -> str | ToolResult:
        """Download generated image and save to sandbox with random name."""
        try:
            original_b64_str = response.data[0].b64_json
            # Decode base64 image data
            image_data = base64.b64decode(original_b64_str)

            # Generate random filename
            random_filename = f"generated_image_{uuid.uuid4().hex[:8]}.png"
            sandbox_path = f"{self.workspace_path}/{random_filename}"

            # Save image to sandbox
            await self.sandbox.fs.upload_file(image_data, sandbox_path)
            return random_filename

        except Exception as e:
            return self.fail_response(f"Failed to download and save image: {str(e)}")
