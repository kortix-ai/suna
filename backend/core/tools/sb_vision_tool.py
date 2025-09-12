import os
import base64
import mimetypes
from typing import Optional, Tuple
from io import BytesIO
from PIL import Image
from urllib.parse import urlparse
from core.agentpress.tool import ToolResult, openapi_schema, usage_example
from core.sandbox.tool_base import SandboxToolsBase
from core.agentpress.thread_manager import ThreadManager
import json
import requests

# Add common image MIME types if mimetypes module is limited
mimetypes.add_type("image/webp", ".webp")
mimetypes.add_type("image/jpeg", ".jpg")
mimetypes.add_type("image/jpeg", ".jpeg")
mimetypes.add_type("image/png", ".png")
mimetypes.add_type("image/gif", ".gif")

# Maximum file size in bytes (e.g., 10MB for original, 5MB for compressed)
MAX_IMAGE_SIZE = 10 * 1024 * 1024
MAX_COMPRESSED_SIZE = 5 * 1024 * 1024

# Compression settings
DEFAULT_MAX_WIDTH = 1920
DEFAULT_MAX_HEIGHT = 1080
DEFAULT_JPEG_QUALITY = 85
DEFAULT_PNG_COMPRESS_LEVEL = 6

class SandboxVisionTool(SandboxToolsBase):
    """Tool for allowing the agent to 'see' images within the sandbox."""

    def __init__(self, project_id: str, thread_id: str, thread_manager: ThreadManager):
        super().__init__(project_id, thread_manager)
        self.thread_id = thread_id
        # Make thread_manager accessible within the tool instance
        self.thread_manager = thread_manager

    def compress_image(self, image_bytes: bytes, mime_type: str, file_path: str) -> Tuple[bytes, str]:
        """Compress an image to reduce its size while maintaining reasonable quality.
        
        Args:
            image_bytes: Original image bytes
            mime_type: MIME type of the image
            file_path: Path to the image file (for logging)
            
        Returns:
            Tuple of (compressed_bytes, new_mime_type)
        """
        try:
            # Open image from bytes
            img = Image.open(BytesIO(image_bytes))
            
            # Convert RGBA to RGB if necessary (for JPEG)
            if img.mode in ('RGBA', 'LA', 'P'):
                # Create a white background
                background = Image.new('RGB', img.size, (255, 255, 255))
                if img.mode == 'P':
                    img = img.convert('RGBA')
                background.paste(img, mask=img.split()[-1] if img.mode == 'RGBA' else None)
                img = background
            
            # Calculate new dimensions while maintaining aspect ratio
            width, height = img.size
            if width > DEFAULT_MAX_WIDTH or height > DEFAULT_MAX_HEIGHT:
                ratio = min(DEFAULT_MAX_WIDTH / width, DEFAULT_MAX_HEIGHT / height)
                new_width = int(width * ratio)
                new_height = int(height * ratio)
                img = img.resize((new_width, new_height), Image.Resampling.LANCZOS)
                print(f"[SeeImage] Resized image from {width}x{height} to {new_width}x{new_height}")
            
            # Save to bytes with compression
            output = BytesIO()
            
            # Determine output format based on original mime type
            if mime_type == 'image/gif':
                # Keep GIFs as GIFs to preserve animation
                img.save(output, format='GIF', optimize=True)
                output_mime = 'image/gif'
            elif mime_type == 'image/png':
                # Compress PNG
                img.save(output, format='PNG', optimize=True, compress_level=DEFAULT_PNG_COMPRESS_LEVEL)
                output_mime = 'image/png'
            else:
                # Convert everything else to JPEG for better compression
                img.save(output, format='JPEG', quality=DEFAULT_JPEG_QUALITY, optimize=True)
                output_mime = 'image/jpeg'
            
            compressed_bytes = output.getvalue()
            
            # Log compression results
            original_size = len(image_bytes)
            compressed_size = len(compressed_bytes)
            compression_ratio = (1 - compressed_size / original_size) * 100
            print(f"[SeeImage] Compressed '{file_path}' from {original_size / 1024:.1f}KB to {compressed_size / 1024:.1f}KB ({compression_ratio:.1f}% reduction)")
            
            return compressed_bytes, output_mime
            
        except Exception as e:
            print(f"[SeeImage] Failed to compress image: {str(e)}. Using original.")
            return image_bytes, mime_type

    def is_url(self, file_path: str) -> bool:
        """check if the file path is url"""
        parsed_url = urlparse(file_path)
        return parsed_url.scheme in ('http', 'https')
    
    def download_image_from_url(self, url: str) -> Tuple[bytes, str]:
        """Download image from a URL"""
        try:
            headers = {
                "User-Agent": "Mozilla/5.0"  # Some servers block default Python
            }

            # HEAD request to get the image size
            head_response = requests.head(url, timeout=10, headers=headers, stream=True)
            head_response.raise_for_status()
            
            # Check content length
            content_length = int(head_response.headers.get('Content-Length'))
            if content_length and content_length > MAX_IMAGE_SIZE:
                raise Exception(f"Image is too large ({(content_length)/(1024*1024):.2f}MB) for the maximum allowed size of {MAX_IMAGE_SIZE/(1024*1024):.2f}MB")
            
            # Download the image
            response = requests.get(url, timeout=10, headers=headers, stream=True)
            response.raise_for_status()

            image_bytes = response.content
            if len(image_bytes) > MAX_IMAGE_SIZE:
                raise Exception(f"Downloaded image is too large ({(len(image_bytes))/(1024*1024):.2f}MB). Maximum allowed size of {MAX_IMAGE_SIZE/(1024*1024):.2f}MB")

            # Get MIME type
            mime_type = response.headers.get('Content-Type')
            if not mime_type or not mime_type.startswith('image/'):
                raise Exception(f"URL does not point to an image (Content-Type: {mime_type}): {url}")
            
            return image_bytes, mime_type
        except Exception as e:
            return self.fail_response(f"Failed to download image from URL: {str(e)}")
    
    @openapi_schema({
        "type": "function",
        "function": {
            "name": "load_image",
            "description": "Loads an image file into conversation context from the /workspace directory or from a URL. Provide either a relative path to a local image or the URL to an image. The image will be compressed before sending to reduce token usage. IMPORTANT: If you previously loaded an image but cleared context, you can load it again by calling this tool with the same file path - no need to ask user to re-upload.",
            "parameters": {
                "type": "object",
                "properties": {
                    "file_path": {
                        "type": "string",
                        "description": "Either a relative path to the image file within the /workspace directory (e.g., 'screenshots/image.png') or a URL to an image (e.g., 'https://example.com/image.jpg'). Supported formats: JPG, PNG, GIF, WEBP. Max size: 10MB."
                    }
                },
                "required": ["file_path"]
            }
        }
    })
    @usage_example('''
        <!-- Example: Load a local image named 'diagram.png' inside the 'docs' folder into context -->
        <function_calls>
        <invoke name="load_image">
        <parameter name="file_path">docs/diagram.png</parameter>
        </invoke>
        </function_calls>

        <!-- Example: Load an image from a URL into context -->
        <function_calls>
        <invoke name="load_image">
        <parameter name="file_path">https://example.com/image.jpg</parameter>
        </invoke>
        </function_calls>
        ''')
    async def load_image(self, file_path: str) -> ToolResult:
        """Loads an image file from local file system or from a URL, compresses it, converts it to base64, and adds it to conversation context."""
        try:
            is_url = self.is_url(file_path)
            if is_url:
                try:
                    image_bytes, mime_type = self.download_image_from_url(file_path)
                    original_size = len(image_bytes)
                    cleaned_path = file_path
                except Exception as e:
                    return self.fail_response(f"Failed to download image from URL: {str(e)}")
            else:
                # Ensure sandbox is initialized
                await self._ensure_sandbox()

                # Clean and construct full path
                cleaned_path = self.clean_path(file_path)
                full_path = f"{self.workspace_path}/{cleaned_path}"

                # Check if file exists and get info
                try:
                    file_info = await self.sandbox.fs.get_file_info(full_path)
                    if file_info.is_dir:
                        return self.fail_response(f"Path '{cleaned_path}' is a directory, not an image file.")
                except Exception as e:
                    return self.fail_response(f"Image file not found at path: '{cleaned_path}'")

                # Check file size
                if file_info.size > MAX_IMAGE_SIZE:
                    return self.fail_response(f"Image file '{cleaned_path}' is too large ({file_info.size / (1024*1024):.2f}MB). Maximum size is {MAX_IMAGE_SIZE / (1024*1024)}MB.")

                # Read image file content
                try:
                    image_bytes = await self.sandbox.fs.download_file(full_path)
                except Exception as e:
                    return self.fail_response(f"Could not read image file: {cleaned_path}")

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
                
                original_size = file_info.size
            

            # Compress the image
            compressed_bytes, compressed_mime_type = self.compress_image(image_bytes, mime_type, cleaned_path)
            
            # Check if compressed image is still too large
            if len(compressed_bytes) > MAX_COMPRESSED_SIZE:
                return self.fail_response(f"Image file '{cleaned_path}' is still too large after compression ({len(compressed_bytes) / (1024*1024):.2f}MB). Maximum compressed size is {MAX_COMPRESSED_SIZE / (1024*1024)}MB.")

            # Convert to base64
            base64_image = base64.b64encode(compressed_bytes).decode('utf-8')

            # Prepare the temporary message content
            image_context_data = {
                "mime_type": compressed_mime_type,
                "base64": base64_image,
                "file_path": cleaned_path, # Include path for context
                "original_size": original_size,
                "compressed_size": len(compressed_bytes)
            }

            # Add the image context message to the database
            # Use a distinct type like 'image_context'
            await self.thread_manager.add_message(
                thread_id=self.thread_id,
                type="image_context", # Use a specific type for this
                content=image_context_data, # Store the dict directly
                is_llm_message=True # ✅ Include in LLM conversations
            )

            # Inform the agent the image will be available next turn
            return self.success_response(f"Successfully loaded and compressed the image '{cleaned_path}' (reduced from {original_size / 1024:.1f}KB to {len(compressed_bytes) / 1024:.1f}KB).")

        except Exception as e:
            return self.fail_response(f"An unexpected error occurred while trying to see the image: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "clear_images_from_context",
            "description": "Clears all images from conversation memory. Use when done analyzing images or to free up context tokens. IMPORTANT: Files remain accessible - use load_image with the same path to load any image again instead of asking user to re-upload.",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": []
            }
        }
    })
    @usage_example('''
        <!-- Example: Clear all images from conversation context -->
        <function_calls>
        <invoke name="clear_images_from_context">
        </invoke>
        </function_calls>
        ''')
    async def clear_images_from_context(self) -> ToolResult:
        """Removes all image_context messages from the current thread to free up tokens."""
        try:
            await self._ensure_sandbox()
            
            # Get database client
            client = await self.thread_manager.db.client
            
            # Delete all image_context messages from this thread
            result = await client.table('messages').delete().eq('thread_id', self.thread_id).eq('type', 'image_context').execute()
            
            deleted_count = len(result.data) if result.data else 0
            
            if deleted_count > 0:
                return self.success_response(f"Successfully cleared {deleted_count} image(s) from conversation context. Visual memory has been reset.")
            else:
                return self.success_response("No images found in conversation context to clear.")
                
        except Exception as e:
            return self.fail_response(f"Failed to clear images from context: {str(e)}") 