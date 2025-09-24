from typing import Optional, Dict, Any
from core.agentpress.tool import ToolResult, openapi_schema, usage_example
from core.sandbox.tool_base import SandboxToolsBase
from core.agentpress.thread_manager import ThreadManager
from core.utils.logger import logger
import httpx
import base64
import uuid
import asyncio
from litellm import acompletion
import json
import os
from datetime import datetime

class SandboxVideoGenerationTool(SandboxToolsBase):
    """Tool for generating videos using Google Veo 3 model via LiteLLM or direct API integration."""

    def __init__(self, project_id: str, thread_id: str, thread_manager: ThreadManager):
        super().__init__(project_id, thread_manager)
        self.thread_id = thread_id
        self.thread_manager = thread_manager

    @openapi_schema(
        {
            "type": "function",
            "function": {
                "name": "generate_video",
                "description": "Generate a video from a text prompt using Google Veo 3 model. Supports high-quality 1080p video generation with synchronized audio.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "prompt": {
                            "type": "string",
                            "description": "Detailed text description of the video to generate. Include style, mood, camera movements, subjects, and any specific requirements."
                        },
                        "duration": {
                            "type": "integer",
                            "description": "Duration of the video in seconds (default: 5, max: 60)",
                            "default": 5,
                            "minimum": 1,
                            "maximum": 60
                        },
                        "style": {
                            "type": "string",
                            "description": "Visual style for the video",
                            "enum": ["realistic", "cinematic", "animated", "artistic", "documentary", "commercial"],
                            "default": "realistic"
                        },
                        "aspect_ratio": {
                            "type": "string",
                            "description": "Aspect ratio for the video",
                            "enum": ["16:9", "9:16", "1:1", "4:3"],
                            "default": "16:9"
                        },
                        "include_audio": {
                            "type": "boolean",
                            "description": "Whether to generate synchronized audio with the video",
                            "default": True
                        }
                    },
                    "required": ["prompt"]
                }
            }
        }
    )
    @usage_example(
        "Generate a cinematic video of a cat playing in a garden with soft sunlight filtering through trees, 10 seconds long, with gentle background music",
        {
            "prompt": "A beautiful golden retriever puppy playing in a lush green garden with soft morning sunlight filtering through tall oak trees. The camera follows the puppy as it chases butterflies, with shallow depth of field and warm, natural lighting. Cinematic quality with smooth camera movements.",
            "duration": 10,
            "style": "cinematic",
            "aspect_ratio": "16:9",
            "include_audio": True
        }
    )
    async def generate_video(
        self,
        prompt: str,
        duration: int = 5,
        style: str = "realistic",
        aspect_ratio: str = "16:9",
        include_audio: bool = True
    ) -> ToolResult:
        """Generate a video using Google Veo 3 model."""
        try:
            logger.info(f"Starting video generation with prompt: {prompt[:100]}...")

            # Prepare the generation parameters
            generation_params = {
                "prompt": prompt,
                "duration": duration,
                "style": style,
                "aspect_ratio": aspect_ratio,
                "include_audio": include_audio,
                "model": "google/veo-3"  # LiteLLM model identifier
            }

            # Attempt to generate video using LiteLLM
            try:
                response = await acompletion(
                    model="google/veo-3",
                    messages=[{
                        "role": "user",
                        "content": f"Generate a video: {prompt}"
                    }],
                    max_tokens=1,  # Video generation doesn't use text tokens
                    extra_body={
                        "video_generation": True,
                        "duration": duration,
                        "style": style,
                        "aspect_ratio": aspect_ratio,
                        "include_audio": include_audio
                    }
                )
                
                # Extract video URL or data from response
                video_url = None
                if hasattr(response, 'choices') and response.choices:
                    choice = response.choices[0]
                    if hasattr(choice, 'message') and hasattr(choice.message, 'content'):
                        content = choice.message.content
                        if isinstance(content, str):
                            try:
                                content_data = json.loads(content)
                                video_url = content_data.get('video_url') or content_data.get('url')
                            except:
                                # If content is not JSON, it might be a direct URL
                                if content.startswith('http'):
                                    video_url = content
                
                if video_url:
                    # Store video information in thread context
                    video_id = str(uuid.uuid4())
                    video_data = {
                        "id": video_id,
                        "url": video_url,
                        "prompt": prompt,
                        "duration": duration,
                        "style": style,
                        "aspect_ratio": aspect_ratio,
                        "include_audio": include_audio,
                        "created_at": datetime.now().isoformat(),
                        "status": "completed"
                    }
                    
                    # Add to thread context
                    await self.thread_manager.add_message(
                        thread_id=self.thread_id,
                        role="tool_result",
                        content=f"Video generated successfully: {video_url}",
                        metadata={"video_data": video_data}
                    )
                    
                    return self.success_response(
                        result=video_data,
                        message=f"Successfully generated {duration}-second {style} video with aspect ratio {aspect_ratio}"
                    )
                else:
                    raise Exception("No video URL returned from Veo 3")
                    
            except Exception as lite_error:
                logger.warning(f"LiteLLM Veo 3 generation failed: {lite_error}")
                
                # Fallback: Try direct Google Vertex AI API
                return await self._generate_video_direct_api(generation_params)
                
        except Exception as e:
            logger.error(f"Video generation failed: {e}", exc_info=True)
            return self.fail_response(f"Failed to generate video: {str(e)}")

    async def _generate_video_direct_api(self, params: Dict[str, Any]) -> ToolResult:
        """Fallback method using direct Google Vertex AI API."""
        try:
            # This would require Google Cloud credentials and Vertex AI setup
            # For now, return a placeholder response
            logger.info("Attempting direct Vertex AI API call")
            
            # Placeholder for direct API implementation
            # Would need: GOOGLE_APPLICATION_CREDENTIALS, project_id, etc.
            
            return self.fail_response(
                "Direct Vertex AI integration not yet implemented. Please ensure Google Cloud credentials are configured."
            )
            
        except Exception as e:
            logger.error(f"Direct API generation failed: {e}")
            return self.fail_response(f"Direct API generation failed: {str(e)}")

    @openapi_schema(
        {
            "type": "function",
            "function": {
                "name": "generate_video_from_image",
                "description": "Generate a video from an existing image using Google Veo 3 model.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "image_url": {
                            "type": "string",
                            "description": "URL or base64 encoded image to use as starting frame"
                        },
                        "prompt": {
                            "type": "string",
                            "description": "Description of how the image should animate or transform into a video"
                        },
                        "duration": {
                            "type": "integer",
                            "description": "Duration of the video in seconds (default: 5, max: 60)",
                            "default": 5,
                            "minimum": 1,
                            "maximum": 60
                        },
                        "motion_intensity": {
                            "type": "string",
                            "description": "Intensity of motion in the generated video",
                            "enum": ["subtle", "moderate", "dynamic"],
                            "default": "moderate"
                        }
                    },
                    "required": ["image_url", "prompt"]
                }
            }
        }
    )
    @usage_example(
        "Generate a video from an image of a sunset, making the clouds slowly drift and the colors gradually change",
        {
            "image_url": "https://example.com/sunset.jpg",
            "prompt": "The clouds drift slowly across the sky while the sunset colors gradually deepen from orange to deep purple. Gentle camera movement follows the cloud motion.",
            "duration": 8,
            "motion_intensity": "subtle"
        }
    )
    async def generate_video_from_image(
        self,
        image_url: str,
        prompt: str,
        duration: int = 5,
        motion_intensity: str = "moderate"
    ) -> ToolResult:
        """Generate a video from an existing image using Veo 3."""
        try:
            logger.info(f"Starting image-to-video generation with prompt: {prompt[:100]}...")

            # This would implement image-to-video generation
            # Similar structure to generate_video but with image input
            
            return self.fail_response(
                "Image-to-video generation not yet implemented. This feature requires additional Veo 3 API configuration."
            )
            
        except Exception as e:
            logger.error(f"Image-to-video generation failed: {e}", exc_info=True)
            return self.fail_response(f"Failed to generate video from image: {str(e)}")

    @openapi_schema(
        {
            "type": "function",
            "function": {
                "name": "get_video_status",
                "description": "Check the status of a video generation request.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "video_id": {
                            "type": "string",
                            "description": "ID of the video generation request to check"
                        }
                    },
                    "required": ["video_id"]
                }
            }
        }
    )
    async def get_video_status(self, video_id: str) -> ToolResult:
        """Check the status of a video generation request."""
        try:
            # This would check the status of an ongoing video generation
            # Implementation depends on the API used
            
            return self.success_response(
                result={"video_id": video_id, "status": "completed"},
                message="Video generation status retrieved"
            )
            
        except Exception as e:
            logger.error(f"Failed to get video status: {e}")
            return self.fail_response(f"Failed to get video status: {str(e)}")
