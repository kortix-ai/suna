import os
import tempfile
import mimetypes
import asyncio
from urllib.parse import urlparse
from typing import Optional, Tuple
import requests
import aiohttp
import logging
from core.agentpress.tool import ToolResult, openapi_schema, tool_metadata
from core.utils.config import config
from core.sandbox.tool_base import SandboxToolsBase
from core.agentpress.thread_manager import ThreadManager
import json

logger = logging.getLogger(__name__)

# Supported file extensions
SUPPORTED_IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.gif', '.webp'}
SUPPORTED_AUDIO_EXTENSIONS = {'.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.alac'}
SUPPORTED_VIDEO_EXTENSIONS = {'.mp4', '.mov'}

# File size limits (in bytes)
MAX_IMAGE_SIZE = 10 * 1024 * 1024  # 10MB
MAX_AUDIO_SIZE = 20 * 1024 * 1024  # 20MB
MAX_VIDEO_SIZE = 250 * 1024 * 1024  # 250MB

@tool_metadata(
    display_name="Deepfake Detection",
    description="Analyze images, audio, and video files for AI-generated or manipulated content using Reality Defender",
    icon="Shield",
    color="bg-purple-100 dark:bg-purple-800/50",
    weight=50,
    visible=True,
    usage_guide="""
### DEEPFAKE DETECTION CAPABILITIES

**CRITICAL: IMMEDIATE USAGE**
When a user asks you to check if an image, audio, or video is a deepfake, manipulated, or AI-generated:
1. **IMMEDIATELY** use detect_deepfake with file_path parameter - NO need to initialize tools first
2. The tool is ready to use directly - just provide the file path or URL
3. Analyze the results and explain the findings to the user

**CORE FUNCTIONALITY:**
- Detect AI-generated or manipulated content in images, audio, and video files
- Analyze files from the sandbox workspace or from URLs
- Get detailed confidence scores and explainable indicators
- Identify potential deepfakes, synthetic media, or AI-generated content

**SUPPORTED MEDIA TYPES:**
- **Images:** JPG, JPEG, PNG, GIF, WEBP (max 10MB)
- **Audio:** MP3, WAV, M4A, AAC, OGG, FLAC, ALAC (max 20MB)
- **Video:** MP4, MOV (max 250MB)

**USAGE EXAMPLES:**
- User: "Is this image real?" → IMMEDIATELY use detect_deepfake with file_path "image.jpg"
- User: "Check if this video is fake" → IMMEDIATELY use detect_deepfake with file_path "video.mp4"
- User: "Verify this audio file" → IMMEDIATELY use detect_deepfake with file_path "audio.mp3"
- File paths: Use relative paths like 'images/suspect.jpg' or URLs like 'https://example.com/video.mp4'

**RESULT INTERPRETATION:**
- **is_deepfake: true** - File is likely manipulated/AI-generated
- **confidence** - Score from 0.0 to 1.0 indicating detection confidence (higher = more reliable)
- **verdict** - One of: 'likely_authentic', 'likely_manipulated', 'uncertain'
- **indicators** - List of specific detection signals with descriptions explaining what was detected

**BEST PRACTICES:**
- **IMMEDIATELY use detect_deepfake** when users ask about media authenticity - don't hesitate
- Check confidence scores - higher scores (0.7+) indicate more reliable detection
- Review indicators to understand what triggered the detection (facial artifacts, metadata anomalies, etc.)
- Consider file quality - low quality files may produce uncertain results
- Always explain results clearly to users with the confidence level and key indicators
"""
)
class RealityDefenderTool(SandboxToolsBase):
    """Tool for detecting deepfakes and AI-generated content using Reality Defender."""

    def __init__(self, project_id: str, thread_manager: ThreadManager):
        super().__init__(project_id, thread_manager)
        self.api_key = config.REALITY_DEFENDER_API_KEY
        
        if not self.api_key:
            logger.warning("REALITY_DEFENDER_API_KEY not configured - Reality Defender Tool will not be available")

    def is_url(self, file_path: str) -> bool:
        """Check if the file path is a URL."""
        parsed_url = urlparse(file_path)
        return parsed_url.scheme in ('http', 'https')

    def get_media_type(self, file_path: str, mime_type: Optional[str] = None) -> Optional[str]:
        """Determine media type from file extension or MIME type."""
        ext = os.path.splitext(file_path.lower())[1]
        
        if ext in SUPPORTED_IMAGE_EXTENSIONS or (mime_type and mime_type.startswith('image/')):
            return 'image'
        elif ext in SUPPORTED_AUDIO_EXTENSIONS or (mime_type and mime_type.startswith('audio/')):
            return 'audio'
        elif ext in SUPPORTED_VIDEO_EXTENSIONS or (mime_type and mime_type.startswith('video/')):
            return 'video'
        return None

    def get_max_size(self, media_type: str) -> int:
        """Get maximum file size for a media type."""
        if media_type == 'image':
            return MAX_IMAGE_SIZE
        elif media_type == 'audio':
            return MAX_AUDIO_SIZE
        elif media_type == 'video':
            return MAX_VIDEO_SIZE
        return MAX_IMAGE_SIZE  # Default

    async def download_file_from_url(self, url: str) -> Tuple[bytes, str, Optional[str]]:
        """Download a file from a URL (async using aiohttp to avoid blocking event loop)."""
        try:
            headers = {
                "User-Agent": "Mozilla/5.0"
            }
            timeout = aiohttp.ClientTimeout(total=30)

            async with aiohttp.ClientSession(timeout=timeout) as session:
                # HEAD request to get file info
                async with session.head(url, headers=headers, allow_redirects=True) as head_response:
                    head_response.raise_for_status()
                    
                    # Get content type and size
                    mime_type = head_response.headers.get('Content-Type', '')
                    content_length = head_response.headers.get('Content-Length')
                
                # Download the file
                async with session.get(url, headers=headers, allow_redirects=True) as response:
                    response.raise_for_status()

                    file_bytes = await response.read()
                    
                    # Update mime type from actual response if available
                    if response.headers.get('Content-Type'):
                        mime_type = response.headers.get('Content-Type')
                    
                    # Determine media type
                    media_type = self.get_media_type(url, mime_type)
                    if not media_type:
                        raise Exception(f"Unsupported file type. URL must point to an image, audio, or video file.")
                    
                    # Check file size
                    max_size = self.get_max_size(media_type)
                    if len(file_bytes) > max_size:
                        raise Exception(f"File is too large ({len(file_bytes) / (1024*1024):.2f}MB). Maximum size for {media_type} is {max_size / (1024*1024)}MB")
            
            return file_bytes, mime_type, media_type
            
        except Exception as e:
            raise Exception(f"Failed to download file from URL: {str(e)}")

    async def get_file_from_sandbox(self, file_path: str) -> Tuple[bytes, str, Optional[str]]:
        """Get a file from the sandbox workspace."""
        await self._ensure_sandbox()
        
        # Clean and construct full path
        cleaned_path = self.clean_path(file_path)
        full_path = f"{self.workspace_path}/{cleaned_path}"
        
        # Check if file exists
        try:
            file_info = await self.sandbox.fs.get_file_info(full_path)
            if file_info.is_dir:
                raise Exception(f"Path '{cleaned_path}' is a directory, not a file.")
        except Exception as e:
            raise Exception(f"File not found at path: '{cleaned_path}'")
        
        # Determine media type
        media_type = self.get_media_type(cleaned_path)
        if not media_type:
            raise Exception(f"Unsupported file type. File must be an image, audio, or video file.")
        
        # Check file size
        max_size = self.get_max_size(media_type)
        if file_info.size > max_size:
            raise Exception(f"File '{cleaned_path}' is too large ({file_info.size / (1024*1024):.2f}MB). Maximum size for {media_type} is {max_size / (1024*1024)}MB")
        
        # Read file content
        try:
            file_bytes = await self.sandbox.fs.download_file(full_path)
        except Exception as e:
            raise Exception(f"Could not read file: {cleaned_path}")
        
        # Determine MIME type
        mime_type, _ = mimetypes.guess_type(full_path)
        if not mime_type:
            # Fallback based on extension
            ext = os.path.splitext(cleaned_path)[1].lower()
            if ext in SUPPORTED_IMAGE_EXTENSIONS:
                mime_type = 'image/jpeg' if ext in ['.jpg', '.jpeg'] else f'image/{ext[1:]}'
            elif ext in SUPPORTED_AUDIO_EXTENSIONS:
                mime_type = 'audio/mpeg' if ext == '.mp3' else f'audio/{ext[1:]}'
            elif ext in SUPPORTED_VIDEO_EXTENSIONS:
                mime_type = 'video/mp4' if ext == '.mp4' else 'video/quicktime'
        
        return file_bytes, mime_type or 'application/octet-stream', media_type

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "detect_deepfake",
            "description": """Analyze an image, audio, or video file for AI-generated or manipulated content using Reality Defender's deepfake detection technology.

This tool can detect:
- AI-generated images (deepfakes, synthetic faces, manipulated photos)
- AI-generated audio (voice cloning, synthetic speech)
- AI-generated or manipulated video content

Provide either a file path relative to /workspace (e.g., 'images/suspect.jpg') or a URL to a media file.""",
            "parameters": {
                "type": "object",
                "properties": {
                    "file_path": {
                        "type": "string",
                        "description": "Either a relative path to a file within the /workspace directory (e.g., 'images/suspect.jpg') or a URL to a media file (e.g., 'https://example.com/video.mp4'). Supported formats: Images (JPG, PNG, GIF, WEBP), Audio (MP3, WAV, M4A, AAC, OGG, FLAC, ALAC), Video (MP4, MOV)."
                    }
                },
                "required": ["file_path"]
            }
        }
    })
    async def detect_deepfake(self, file_path: str) -> ToolResult:
        """Analyze a file for deepfake/AI-generated content using Reality Defender."""
        try:
            # Check if API key is configured
            if not self.api_key:
                return self.fail_response("Deepfake detection is not available. REALITY_DEFENDER_API_KEY is not configured.")
            
            # Get file content
            is_url = self.is_url(file_path)
            
            if is_url:
                try:
                    file_bytes, mime_type, media_type = await self.download_file_from_url(file_path)
                    cleaned_path = file_path
                except Exception as e:
                    return self.fail_response(f"Failed to download file from URL: {str(e)}")
            else:
                try:
                    file_bytes, mime_type, media_type = await self.get_file_from_sandbox(file_path)
                    cleaned_path = file_path
                except Exception as e:
                    return self.fail_response(str(e))
            
            if not media_type:
                return self.fail_response(f"Could not determine media type for file: {cleaned_path}")
            
            # Import Reality Defender SDK
            try:
                from realitydefender import RealityDefender, RealityDefenderError
            except ImportError:
                return self.fail_response("Reality Defender SDK not installed. Please install it with: pip install realitydefender")
            
            # Save file to temporary location for analysis
            temp_file = None
            temp_file_path = None
            try:
                # Create temporary file with appropriate extension
                ext = os.path.splitext(cleaned_path)[1] or ('.jpg' if media_type == 'image' else ('.mp3' if media_type == 'audio' else '.mp4'))
                with tempfile.NamedTemporaryFile(delete=False, suffix=ext) as temp_file:
                    temp_file.write(file_bytes)
                    temp_file_path = temp_file.name
                
                # Initialize Reality Defender client
                client = RealityDefender(api_key=self.api_key)
                
                try:
                    # Analyze file using Reality Defender async API
                    logger.info(f"Analyzing {media_type} file '{cleaned_path}' for deepfake detection...")
                    
                    # Upload file
                    upload_response = await client.upload(temp_file_path)
                    request_id = upload_response.get('request_id')
                    
                    if not request_id:
                        return self.fail_response("Failed to upload file to Reality Defender - no request_id returned")
                    
                    # Poll for results until completion
                    max_polling_time = 60
                    polling_interval = 2
                    elapsed = 0
                    result = None
                    
                    while elapsed < max_polling_time:
                        try:
                            result = await client.get_result(request_id)
                            
                            if not isinstance(result, dict):
                                return self.fail_response(f"Unexpected result format from Reality Defender: {type(result)}")
                            
                            status = result.get('status') or ''
                            status_upper = status.upper()
                            
                            if status_upper != 'ANALYZING':
                                break
                            
                            await asyncio.sleep(polling_interval)
                            elapsed += polling_interval
                        except RealityDefenderError as e:
                            # Handle various error codes that indicate we should retry
                            if e.code == "not_found":
                                # Result not ready yet, continue polling
                                await asyncio.sleep(polling_interval)
                                elapsed += polling_interval
                                continue
                            elif e.code == "server_error" or "504" in str(e) or "timeout" in str(e).lower():
                                # Server timeout/error - retry if we have time
                                if elapsed < max_polling_time - polling_interval:
                                    logger.warning(f"Reality Defender API returned error (will retry): {e}")
                                    await asyncio.sleep(polling_interval)
                                    elapsed += polling_interval
                                    continue
                                else:
                                    # Out of time, return error
                                    return self.fail_response(f"Reality Defender API timeout - analysis is taking longer than expected. Please try again later.")
                            else:
                                # Other errors should be raised
                                raise
                    
                    # Check timeout
                    if result is None:
                        return self.fail_response("Analysis timed out - no result received")
                    
                    status = (result.get('status') or '').upper()
                    if status == 'ANALYZING':
                        return self.fail_response("Analysis timed out - still analyzing")
                    
                    # Extract score safely
                    score_value = result.get('score')
                    if score_value is None:
                        score = 0.5
                    else:
                        try:
                            score = float(score_value)
                        except (ValueError, TypeError):
                            score = 0.5
                    
                    # Determine verdict
                    is_deepfake = status == 'MANIPULATED' or (score > 0.5 and status != 'AUTHENTIC')
                    
                    if status == 'MANIPULATED' or (score >= 0.7 and status != 'AUTHENTIC'):
                        verdict = 'likely_manipulated'
                    elif status == 'AUTHENTIC' or score <= 0.3:
                        verdict = 'likely_authentic'
                    else:
                        verdict = 'uncertain'
                    
                    # Extract indicators
                    indicators = []
                    models = result.get('models', [])
                    if isinstance(models, list):
                        for model in models:
                            if not isinstance(model, dict):
                                continue
                            model_name = model.get('name', 'unknown')
                            model_status = model.get('status', '')
                            model_score_value = model.get('score')
                            try:
                                model_score = float(model_score_value) if model_score_value is not None else 0.5
                            except (ValueError, TypeError):
                                model_score = 0.5
                            
                            indicators.append({
                                "name": model_name.lower().replace(' ', '_'),
                                "score": model_score,
                                "description": f"{model_name} model: {model_status} (confidence: {model_score:.2f})"
                            })
                    
                    # Build response
                    response_data = {
                        "file_path": cleaned_path,
                        "media_type": media_type,
                        "is_deepfake": bool(is_deepfake),
                        "confidence": round(score, 3),
                        "verdict": verdict,
                        "indicators": indicators,
                        "analysis_id": request_id,
                    }
                    
                    logger.info(f"Deepfake detection completed: verdict={verdict}, confidence={score:.3f}")
                    return self.success_response(response_data)
                    
                finally:
                    # Clean up client
                    try:
                        await client.cleanup()
                    except Exception:
                        pass
                
            except Exception as e:
                logger.error(f"Error during deepfake detection: {e}", exc_info=True)
                return self.fail_response(f"Failed to analyze file: {str(e)}")
            finally:
                # Clean up temporary file
                if temp_file and os.path.exists(temp_file_path):
                    try:
                        os.unlink(temp_file_path)
                    except Exception:
                        pass
        
        except Exception as e:
            logger.error(f"Unexpected error in detect_deepfake: {e}", exc_info=True)
            return self.fail_response(f"An unexpected error occurred: {str(e)}")
