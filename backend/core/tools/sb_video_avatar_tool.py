import httpx
import json
import asyncio
import os
from typing import Optional, Dict, Any, List
from datetime import datetime
from agentpress.tool import Tool, ToolResult, openapi_schema, usage_example
from sandbox.tool_base import SandboxToolsBase
from agentpress.thread_manager import ThreadManager
from core.utils.logger import logger
from core.utils.config import config


class SandboxVideoAvatarTool(SandboxToolsBase):
    """
    A tool for creating and generating videos with AI avatars using HeyGen.
    
    This tool provides functionality to:
    - Generate MP4 video files with AI avatars speaking custom text
    - Create interactive avatar sessions with customizable settings
    - Make avatars speak with text or conversational responses
    - Manage avatar states (listening, speaking, idle)
    - Handle voice chat interactions
    - Configure avatar appearance and voice settings
    
    Use this tool whenever users want to: create videos, make avatar videos, generate content with AI presenters, 
    create talking avatars, make AI spokespersons, or produce video content with virtual humans.
    """

    name: str = "sb_video_avatar_tool"
    
    # Keywords that should trigger this tool: video, avatar, generate, create, speech, presentation, content
    # Enhanced video download reliability: 2025-01-27T15:30:00
    
    # Avatar configuration options
    AVATAR_OPTIONS = {
        "kristin_professional": {
            "avatar_id": "Kristin_public_3_20240108",
            "name": "Kristin (Professional Female)",
            "description": "Professional businesswoman",
            "category": "professional",
            "gender": "female"
        },
        "josh_casual": {
            "avatar_id": "josh_lite3_20230714",
            "name": "Josh (Casual Male)",
            "description": "Casual young professional",
            "category": "casual",
            "gender": "male"
        },
        "anna_professional": {
            "avatar_id": "anna_costume1_cameraA_20220818",
            "name": "Anna (Professional Female)", 
            "description": "Professional businesswoman",
            "category": "professional",
            "gender": "female"
        },
        "monica_casual": {
            "avatar_id": "Monica_public_20230807",
            "name": "Monica (Casual Female)",
            "description": "Casual friendly woman",
            "category": "casual",
            "gender": "female"
        },
        "wayne_business": {
            "avatar_id": "Wayne_public_20230807",
            "name": "Wayne (Business Male)",
            "description": "Professional businessman",
            "category": "professional",
            "gender": "male"
        }
    }

    def __init__(self, project_id: str, thread_manager: ThreadManager):
        super().__init__(project_id, thread_manager)
        self.heygen_api_key = config.HEYGEN_API_KEY
        self.heygen_base_url = "https://api.heygen.com"
        self.active_sessions: Dict[str, str] = {}  # Maps session names to session IDs
        
        if not self.heygen_api_key:
            logger.warning("HeyGen API key not configured. Video avatar functionality will be limited.")
        else:
            # Log key info for debugging (first/last chars only for security)
            key_preview = f"{self.heygen_api_key[:8]}...{self.heygen_api_key[-8:]}" if len(self.heygen_api_key) > 16 else "short_key"
            logger.info(f"HeyGen API key configured successfully: {key_preview}")
    
    def _get_heygen_headers(self) -> Dict[str, str]:
        """Get standard headers for HeyGen API requests."""
        return {
            "X-API-KEY": self.heygen_api_key,
            "Content-Type": "application/json"
        }

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "generate_avatar_video",
            "description": "Generate and create a downloadable MP4 video file with an AI avatar speaking the provided text. Use this for: making videos, creating content, video generation, avatar videos, AI presenters, virtual speakers, talking avatars, video creation, and content production. This creates an actual video file that can be downloaded and shared.",
            "parameters": {
                "type": "object",
                "properties": {
                    "text": {
                        "type": "string",
                        "description": "Text for the avatar to speak in the video"
                    },
                    "preserve_exact_text": {
                        "type": "boolean",
                        "description": "Force HeyGen to use exact text without AI modifications or improvements",
                        "default": False
                    },
                    "avatar_id": {
                        "type": "string",
                        "description": "HeyGen avatar ID to use. Use 'default' or specific avatar IDs from HeyGen",
                        "default": "default"
                    },
                    "voice_id": {
                        "type": "string", 
                        "description": "Voice ID for the avatar's speech. Use 'default' to auto-select first available voice, or use list_available_voices to see all options",
                        "default": "default"
                    },
                    "video_title": {
                        "type": "string",
                        "description": "Optional title for the video file",
                        "default": "Avatar Video"
                    },
                    "background_color": {
                        "type": "string",
                        "description": "Background color in hex format (e.g., '#ffffff' for white)",
                        "default": "#ffffff"
                    },
                    "video_quality": {
                        "type": "string",
                        "enum": ["low", "medium", "high"],
                        "description": "Video quality setting",
                        "default": "medium"
                    },
                    "async_polling": {
                        "type": "boolean",
                        "description": "Use smart async polling - starts generation, polls intelligently, downloads to sandbox when ready",
                        "default": True
                    },
                    "wait_for_completion": {
                        "type": "boolean", 
                        "description": "Whether to wait for video generation to complete before returning (blocking approach)",
                        "default": False
                    },
                    "max_wait_time": {
                        "type": "integer",
                        "description": "Maximum time in seconds to wait for video completion (default: 300 seconds for async polling)",
                        "default": 300
                    }
                },
                "required": ["text"]
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="generate_avatar_video">
        <parameter name="text">Hello! Welcome to our new AI-powered customer service. How can I help you today?</parameter>
        <parameter name="avatar_id">Kristin_public_3_20240108</parameter>
        <parameter name="voice_id">professional_female_1</parameter>
        <parameter name="video_title">Customer Service Introduction</parameter>
        <parameter name="background_color">#f0f8ff</parameter>
        <parameter name="async_polling">true</parameter>
        </invoke>
        </function_calls>
    ''')
    async def generate_avatar_video(
        self,
        text: str,
        preserve_exact_text: bool = False,
        avatar_id: str = "default",
        voice_id: str = "default",
        video_title: str = "Avatar Video",
        background_color: str = "#ffffff",
        video_quality: str = "medium",
        async_polling: bool = True,
        wait_for_completion: bool = False,
        max_wait_time: int = 300
    ) -> ToolResult:
        """Generate a downloadable MP4 video with an avatar speaking the provided text."""
        try:
            if not self.heygen_api_key:
                return self.fail_response("HeyGen API key not configured. Please add HEYGEN_API_KEY to your environment variables.")
            
            # Debug: Log the API key format being used
            key_preview = f"{self.heygen_api_key[:8]}...{self.heygen_api_key[-8:]}" if len(self.heygen_api_key) > 16 else self.heygen_api_key
            logger.info(f"Starting avatar video generation with key: {key_preview}")
            logger.info(f"Starting avatar video generation: {video_title}")
            
            # Prepare video generation request
            voice_config = {
                "type": "text",
                "input_text": text,
                "voice_id": voice_id if voice_id != "default" else "1bd001e7e50f421d891986aad5158bc8"
            }
            
            # Add exact text preservation settings if requested
            if preserve_exact_text:
                voice_config.update({
                    "speed": 1.0,  # Normal speed
                    "emotion": "neutral",  # Neutral emotion to avoid text changes
                    "pause": 0,  # No extra pauses
                    "emphasis": False  # No emphasis changes
                })
                logger.info(f"🔒 Exact text preservation enabled for: '{text}'")
            
            video_data = {
                "video_inputs": [{
                    "character": {
                        "type": "avatar",
                        "avatar_id": avatar_id if avatar_id != "default" else "Kristin_public_3_20240108",
                        "avatar_style": "normal"
                    },
                    "voice": voice_config,
                    "background": {
                        "type": "color",
                        "value": background_color
                    }
                }],
                "dimension": {
                    "width": 1280,
                    "height": 720
                },
                "aspect_ratio": "16:9",
                "test": False,
                "caption": False
            }
            
            # Add quality settings
            quality_settings = {
                "low": {"fps": 24, "bitrate": 1000},
                "medium": {"fps": 30, "bitrate": 2000}, 
                "high": {"fps": 30, "bitrate": 4000}
            }
            video_data.update(quality_settings.get(video_quality, quality_settings["medium"]))
            
            # Make request to HeyGen API
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    f"{self.heygen_base_url}/v2/video/generate",
                    headers=self._get_heygen_headers(),
                    json=video_data,
                    timeout=30.0
                )
                
                if response.status_code != 200:
                    error_msg = f"HeyGen API error: {response.status_code} - {response.text}"
                    logger.error(error_msg)
                    return self.fail_response(error_msg)
                
                result = response.json()
                video_id = result.get("data", {}).get("video_id")
                
                if not video_id:
                    return self.fail_response("Failed to get video ID from HeyGen response")
                
                # Enhanced job ID logging
                logger.info(f"🎬 ===== VIDEO GENERATION STARTED =====")
                logger.info(f"📋 JOB ID: {video_id}")
                logger.info(f"📝 TEXT: '{text}'")
                logger.info(f"👤 AVATAR: {avatar_id}")
                logger.info(f"🔒 EXACT TEXT: {preserve_exact_text}")
                logger.info(f"=========================================")
                
                # Smart async polling approach
                if async_polling:
                    logger.info(f"🎬 Starting async video generation for '{video_title}' (ID: {video_id})")
                    return await self._async_poll_and_download(video_id, video_title, text, avatar_id, voice_id, max_wait_time)
                    
                elif wait_for_completion:
                    # Traditional blocking approach 
                    video_url = await self._wait_for_video_completion(video_id, max_wait_time)
                    if video_url:
                        download_path = await self._download_video(video_url, video_title, video_id)
                        if download_path:
                            # Save metadata
                            await self._save_video_metadata(video_id, video_title, text, avatar_id, voice_id, download_path)
                            
                            logger.info(f"Successfully generated and downloaded video: {download_path}")
                            return self.success_response(
                                f"Avatar video generated successfully! Video saved as: {download_path}\n"
                                f"Video ID: {video_id}\n"
                                f"Title: {video_title}\n"
                                f"Avatar: {avatar_id}\n"
                                f"Text: {text[:100]}{'...' if len(text) > 100 else ''}",
                                attachments=[download_path]
                            )
                        else:
                            logger.error(f"Video {video_id} generation completed but download failed")
                            return self.fail_response("Video generation completed but download failed")
                    else:
                        return self.fail_response("Video generation timed out or failed")
                else:
                    # Quick return approach - ALWAYS show job ID prominently
                    return self.success_response(
                        f"🎬 **AVATAR VIDEO GENERATION STARTED!**\n\n"
                        f"📋 **JOB ID**: `{video_id}` ⭐\n"
                        f"📝 **REQUESTED TEXT**: \"{text}\"\n"
                        f"👤 **AVATAR**: {avatar_id}\n"
                        f"🎙️ **VOICE**: {voice_id}\n\n" 
                        f"📹 **STATUS**: Processing (typically 30-60 seconds)\n"
                        f"🔍 **TRACK PROGRESS**: Use `check_video_status('{video_id}')` to check and download\n\n"
                        f"**⚠️ IMPORTANT**: HeyGen may slightly modify your text for natural speech. The exact text above was requested."
                    )
                    
        except Exception as e:
            error_msg = f"Failed to generate avatar video: {str(e)}"
            logger.error(error_msg, exc_info=True)
            return self.fail_response(error_msg)

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "create_avatar_session",
            "description": "Create a new interactive video avatar session with customizable settings. This sets up the avatar with specified appearance, voice, and behavioral parameters.",
            "parameters": {
                "type": "object",
                "properties": {
                    "session_name": {
                        "type": "string",
                        "description": "Unique name for this avatar session (used for management and reference)"
                    },
                    "selected_avatar": {
                        "type": "string",
                        "description": "Avatar option key from available avatars (e.g., 'wayne_professional', 'susan_professional') or 'custom' to use custom_avatar_id",
                        "enum": ["kristin_professional", "josh_casual", "anna_professional", "monica_casual", "wayne_business", "custom"]
                    },
                    "custom_avatar_id": {
                        "type": "string",
                        "description": "Custom HeyGen avatar ID (required if selected_avatar is 'custom')",
                        "default": ""
                    },
                    "selected_voice": {
                        "type": "string",
                        "description": "Voice option to use for the avatar",
                        "default": "professional_male_1"
                    },
                    "voice_emotion": {
                        "type": "string",
                        "enum": ["EXCITED", "SERIOUS", "FRIENDLY", "SOOTHING", "BROADCASTER"],
                        "description": "Emotion/tone for the avatar's voice",
                        "default": "FRIENDLY"
                    },
                    "quality": {
                        "type": "string",
                        "enum": ["low", "medium", "high"],
                        "description": "Video quality for the streaming session",
                        "default": "medium"
                    },
                    "enable_voice_chat": {
                        "type": "boolean",
                        "description": "Enable voice chat functionality for interactive conversations",
                        "default": True
                    },
                    "knowledge_base": {
                        "type": "string",
                        "description": "Knowledge base or personality prompt for the avatar's responses",
                        "default": "You are a helpful AI assistant. Be friendly and professional in your responses."
                    },
                    "language": {
                        "type": "string",
                        "description": "Language code for the avatar (e.g., 'en' for English, 'es' for Spanish)",
                        "default": "en"
                    }
                },
                "required": ["session_name", "selected_avatar"]
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="create_avatar_session">
        <parameter name="session_name">sales_demo_avatar</parameter>
        <parameter name="selected_avatar">kristin_professional</parameter>
        <parameter name="selected_voice">professional_male_1</parameter>
        <parameter name="voice_emotion">FRIENDLY</parameter>
        <parameter name="quality">high</parameter>
        <parameter name="enable_voice_chat">true</parameter>
        <parameter name="knowledge_base">You are a sales representative for our SaaS product. Be enthusiastic, knowledgeable, and focus on the customer's needs.</parameter>
        </invoke>
        </function_calls>
    ''')
    async def create_avatar_session(
        self,
        session_name: str,
        selected_avatar: str,
        custom_avatar_id: str = "",
        selected_voice: str = "professional_male_1",
        voice_emotion: str = "FRIENDLY",
        quality: str = "medium",
        enable_voice_chat: bool = True,
        knowledge_base: str = "You are a helpful AI assistant. Be friendly and professional in your responses.",
        language: str = "en"
    ) -> ToolResult:
        """Create a new interactive avatar session."""
        try:
            if not self.heygen_api_key:
                return self.fail_response("HeyGen API key not configured. Please add HEYGEN_API_KEY to your environment variables.")
            
            # Determine avatar ID
            if selected_avatar == "custom":
                if not custom_avatar_id:
                    return self.fail_response("custom_avatar_id is required when selected_avatar is 'custom'")
                avatar_id = custom_avatar_id
                avatar_name = "Custom Avatar"
            else:
                avatar_config = self.AVATAR_OPTIONS.get(selected_avatar)
                if not avatar_config:
                    return self.fail_response(f"Unknown avatar option: {selected_avatar}")
                avatar_id = avatar_config["avatar_id"]
                avatar_name = avatar_config["name"]
            
            logger.info(f"Creating avatar session '{session_name}' with avatar {avatar_name}")
            
            # Prepare session creation request
            session_data = {
                "quality": quality,
                "avatar_name": avatar_id,
                "voice": {
                    "voice_id": selected_voice,
                    "rate": 1.0,
                    "emotion": voice_emotion
                },
                "knowledge_base": knowledge_base,
                "language": language,
                "disable_idleness": False
            }
            
            # Create session via HeyGen API
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    f"{self.heygen_base_url}/v1/streaming.create_token",
                    headers=self._get_heygen_headers(),
                    json=session_data,
                    timeout=30.0
                )
                
                if response.status_code != 200:
                    error_msg = f"HeyGen API error: {response.status_code} - {response.text}"
                    logger.error(error_msg)
                    return self.fail_response(error_msg)
                
                result = response.json()
                
                if result.get("code") != 100:
                    return self.fail_response(f"HeyGen session creation failed: {result.get('message', 'Unknown error')}")
                
                session_token = result.get("data", {}).get("token")
                session_id = result.get("data", {}).get("session_id", session_token)  # Fallback to token if no session_id
                
                if not session_token:
                    return self.fail_response("Failed to get session token from HeyGen response")
                
                # Store session info
                self.active_sessions[session_name] = session_id
                
                # Save session metadata to workspace
                await self._save_session_metadata(session_name, {
                    "session_id": session_id,
                    "session_token": session_token,
                    "avatar_id": avatar_id,
                    "avatar_name": avatar_name,
                    "selected_voice": selected_voice,
                    "voice_emotion": voice_emotion,
                    "quality": quality,
                    "enable_voice_chat": enable_voice_chat,
                    "knowledge_base": knowledge_base,
                    "language": language,
                    "created_at": datetime.utcnow().isoformat()
                })
                
                logger.info(f"Avatar session '{session_name}' created successfully with ID: {session_id}")
                
                return self.success_response(
                    f"Interactive avatar session '{session_name}' created successfully!\n"
                    f"Session ID: {session_id}\n"
                    f"Avatar: {avatar_name} ({avatar_id})\n"
                    f"Voice: {selected_voice} ({voice_emotion})\n"
                    f"Quality: {quality}\n"
                    f"Voice Chat: {'Enabled' if enable_voice_chat else 'Disabled'}\n"
                    f"Language: {language}\n\n"
                    f"You can now use make_avatar_speak to make the avatar talk, or other session management commands."
                )
                
        except Exception as e:
            error_msg = f"Failed to create avatar session: {str(e)}"
            logger.error(error_msg, exc_info=True)
            return self.fail_response(error_msg)

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "make_avatar_speak",
            "description": "Make an avatar in an active session speak the provided text. The avatar will generate speech and display the corresponding lip-sync animation.",
            "parameters": {
                "type": "object",
                "properties": {
                    "session_name": {
                        "type": "string",
                        "description": "Name of the avatar session to use"
                    },
                    "text": {
                        "type": "string",
                        "description": "Text for the avatar to speak"
                    },
                    "task_type": {
                        "type": "string",
                        "enum": ["repeat", "chat"],
                        "description": "Type of task - 'repeat' for simple text-to-speech, 'chat' for conversational responses",
                        "default": "repeat"
                    }
                },
                "required": ["session_name", "text"]
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="make_avatar_speak">
        <parameter name="session_name">sales_demo_avatar</parameter>
        <parameter name="text">Hello! I'm excited to tell you about our amazing new features.</parameter>
        <parameter name="task_type">repeat</parameter>
        </invoke>
        </function_calls>
    ''')
    async def make_avatar_speak(
        self,
        session_name: str,
        text: str,
        task_type: str = "repeat"
    ) -> ToolResult:
        """Make an avatar speak the provided text."""
        try:
            if session_name not in self.active_sessions:
                return self.fail_response(f"No active session found with name '{session_name}'. Create a session first using create_avatar_session.")
            
            session_id = self.active_sessions[session_name]
            logger.info(f"Making avatar speak in session '{session_name}': {text[:50]}...")
            
            # Prepare speak request
            speak_data = {
                "session_id": session_id,
                "text": text,
                "task_type": task_type
            }
            
            # Make avatar speak via HeyGen API
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    f"{self.heygen_base_url}/v1/streaming.task",
                    headers=self._get_heygen_headers(),
                    json=speak_data,
                    timeout=30.0
                )
                
                if response.status_code != 200:
                    error_msg = f"HeyGen API error: {response.status_code} - {response.text}"
                    logger.error(error_msg)
                    return self.fail_response(error_msg)
                
                result = response.json()
                
                if result.get("code") != 100:
                    return self.fail_response(f"HeyGen speak task failed: {result.get('message', 'Unknown error')}")
                
                task_id = result.get("data", {}).get("task_id")
                
                return self.success_response(
                    f"Avatar is now speaking in session '{session_name}'!\n"
                    f"Task ID: {task_id}\n"
                    f"Text: {text}\n"
                    f"Task Type: {task_type}"
                )
                
        except Exception as e:
            error_msg = f"Failed to make avatar speak: {str(e)}"
            logger.error(error_msg, exc_info=True)
            return self.fail_response(error_msg)

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "check_video_status",
            "description": "Check the status of a video generation job and download when ready.",
            "parameters": {
                "type": "object",
                "properties": {
                    "video_id": {
                        "type": "string",
                        "description": "Video ID to check status for"
                    },
                    "download_if_ready": {
                        "type": "boolean",
                        "description": "Automatically download the video if it's ready",
                        "default": True
                    }
                },
                "required": ["video_id"]
            }
        }
    })
    async def check_video_status(self, video_id: str, download_if_ready: bool = True) -> ToolResult:
        """Check the status of a video generation job."""
        try:
            if not self.heygen_api_key:
                return self.fail_response("HeyGen API key not configured.")
            
            # Validate video ID format (should be 32 hex chars)
            if not video_id or len(video_id) != 32 or not all(c in '0123456789abcdef' for c in video_id):
                return self.fail_response(f"Invalid video ID format: '{video_id}'. Expected 32-character hex string.")
            
            async with httpx.AsyncClient() as client:
                response = await client.get(
                    f"{self.heygen_base_url}/v1/video_status.get?video_id={video_id}",
                    headers=self._get_heygen_headers(),
                    timeout=30.0
                )
                
                if response.status_code != 200:
                    return self.fail_response(f"HeyGen API error: {response.status_code} - {response.text}")
                
                result = response.json()
                status = result.get("data", {}).get("status")
                video_url = result.get("data", {}).get("video_url")
                
                if status == "completed" and video_url and download_if_ready:
                    download_path = await self._download_video(video_url, f"video_{video_id}", video_id)
                    if download_path:
                        logger.info(f"Video {video_id} completed and downloaded: {download_path}")
                        return self.success_response(
                            f"✅ Video generation completed! Video downloaded to: {download_path}\n"
                            f"🎬 Video ID: {video_id}\n"
                            f"📊 Status: {status}\n"
                            f"📁 File ready for download from sandbox",
                            attachments=[download_path]
                        )
                    else:
                        logger.error(f"Video {video_id} completed but download failed after retries")
                        return self.fail_response(
                            f"❌ **Download Failed**\n\n"
                            f"Video generation completed successfully, but download to sandbox failed after multiple attempts.\n\n"
                            f"**Video Details:**\n"
                            f"• Video ID: `{video_id}`\n"
                            f"• Video URL: `{video_url}`\n"
                            f"• Status: {status} ✅\n\n"
                            f"**You can:**\n"
                            f"1. Try `diagnose_sandbox_issues()` to check sandbox health\n"
                            f"2. Download directly from: {video_url}\n"
                            f"3. Retry this command again\n"
                            f"4. Contact support if issues persist"
                        )
                
                return self.success_response(
                    f"Video Status: {status}\n"
                    f"Video ID: {video_id}\n" +
                    (f"Video URL: {video_url}" if video_url else "Video not ready yet")
                )
                
        except Exception as e:
            return self.fail_response(f"Failed to check video status: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "list_avatar_options",
            "description": "List all available avatar options with their details.",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": []
            }
        }
    })
    async def list_avatar_options(self) -> ToolResult:
        """List all available avatar options."""
        try:
            avatar_list = []
            for key, config in self.AVATAR_OPTIONS.items():
                avatar_list.append(f"• {key}: {config['name']} - {config['description']} (ID: {config['avatar_id']})")
            
            return self.success_response(
                "Available Avatar Options:\n\n" + "\n".join(avatar_list) + 
                "\n\nYou can also use 'custom' with a custom_avatar_id parameter to use any HeyGen avatar ID."
            )
            
        except Exception as e:
            return self.fail_response(f"Failed to list avatar options: {str(e)}")

    @openapi_schema({
        "type": "function", 
        "function": {
            "name": "close_avatar_session",
            "description": "Close an active avatar session and clean up resources.",
            "parameters": {
                "type": "object",
                "properties": {
                    "session_name": {
                        "type": "string",
                        "description": "Name of the session to close"
                    }
                },
                "required": ["session_name"]
            }
        }
    })
    async def close_avatar_session(self, session_name: str) -> ToolResult:
        """Close an avatar session."""
        try:
            if session_name not in self.active_sessions:
                return self.fail_response(f"No active session found with name '{session_name}'")
            
            session_id = self.active_sessions[session_name]
            
            # Close session via HeyGen API
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    f"{self.heygen_base_url}/v1/streaming.stop",
                    headers=self._get_heygen_headers(),
                    json={"session_id": session_id},
                    timeout=30.0
                )
                
                # Remove from active sessions regardless of API response
                del self.active_sessions[session_name]
                
                return self.success_response(f"Avatar session '{session_name}' closed successfully.")
                
        except Exception as e:
            # Still remove from active sessions
            if session_name in self.active_sessions:
                del self.active_sessions[session_name]
            return self.fail_response(f"Failed to close avatar session cleanly: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "diagnose_sandbox_issues",
            "description": "Diagnose sandbox connectivity and file system issues to help troubleshoot video download problems.",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": []
            }
        }
    })
    async def diagnose_sandbox_issues(self) -> ToolResult:
        """Diagnose sandbox issues that might be causing download failures."""
        try:
            diagnostics = []
            
            # 1. Test sandbox initialization
            try:
                await self._ensure_sandbox()
                diagnostics.append("✅ Sandbox initialization: Success")
            except Exception as e:
                diagnostics.append(f"❌ Sandbox initialization: Failed - {str(e)}")
                return self.fail_response("Sandbox initialization failed:\n" + "\n".join(diagnostics))
            
            # 2. Test sandbox state
            try:
                state_ok = await self._validate_sandbox_state()
                if state_ok:
                    diagnostics.append("✅ Sandbox state validation: Ready")
                else:
                    diagnostics.append("❌ Sandbox state validation: Not ready")
            except Exception as e:
                diagnostics.append(f"❌ Sandbox state validation: Failed - {str(e)}")
            
            # 3. Test file system operations
            try:
                test_path = "/workspace/.diagnostic_test.txt"
                test_content = b"Diagnostic test content"
                
                await self.sandbox.fs.upload_file(test_content, test_path)
                diagnostics.append("✅ File write test: Success")
                
                # Test file read
                try:
                    file_info = await self.sandbox.fs.stat(test_path)
                    diagnostics.append(f"✅ File stat test: Success (size: {getattr(file_info, 'size', 'unknown')})")
                except Exception:
                    diagnostics.append("⚠️ File stat test: Failed (file written but can't read stats)")
                
                # Cleanup
                try:
                    await self.sandbox.fs.delete(test_path)
                    diagnostics.append("✅ File delete test: Success")
                except Exception:
                    diagnostics.append("⚠️ File delete test: Failed (cleanup issue)")
                    
            except Exception as e:
                diagnostics.append(f"❌ File system test: Failed - {str(e)}")
            
            # 4. Test network connectivity
            try:
                async with httpx.AsyncClient(timeout=10.0) as client:
                    response = await client.get("https://httpbin.org/get")
                    if response.status_code == 200:
                        diagnostics.append("✅ External network test: Success")
                    else:
                        diagnostics.append(f"⚠️ External network test: HTTP {response.status_code}")
            except Exception as e:
                diagnostics.append(f"❌ External network test: Failed - {str(e)}")
            
            # 5. Test sandbox disk space
            try:
                # Try to write a larger test file to check space
                large_test_path = "/workspace/.large_test.tmp"
                large_content = b"x" * (1024 * 1024)  # 1MB test file
                
                await self.sandbox.fs.upload_file(large_content, large_test_path)
                diagnostics.append("✅ Disk space test: Sufficient (1MB test passed)")
                
                try:
                    await self.sandbox.fs.delete(large_test_path)
                except Exception:
                    pass
                    
            except Exception as e:
                diagnostics.append(f"❌ Disk space test: Failed - {str(e)}")
            
            # Compile results
            success_count = len([d for d in diagnostics if d.startswith("✅")])
            warning_count = len([d for d in diagnostics if d.startswith("⚠️")])
            failure_count = len([d for d in diagnostics if d.startswith("❌")])
            
            summary = f"**Sandbox Diagnostic Results:**\n\n"
            summary += f"✅ Passed: {success_count}\n"
            summary += f"⚠️ Warnings: {warning_count}\n" 
            summary += f"❌ Failed: {failure_count}\n\n"
            
            summary += "**Detailed Results:**\n"
            for diagnostic in diagnostics:
                summary += f"{diagnostic}\n"
                
            if failure_count == 0 and warning_count <= 1:
                summary += "\n**Status:** Sandbox appears to be working properly ✅"
                return self.success_response(summary)
            elif failure_count > 0:
                summary += "\n**Status:** Critical issues detected ❌"
                summary += "\n**Recommendation:** Contact support or restart sandbox"
                return self.fail_response(summary)
            else:
                summary += "\n**Status:** Minor issues detected ⚠️"
                summary += "\n**Recommendation:** Issues may resolve themselves or affect performance"
                return self.success_response(summary)
                
        except Exception as e:
            logger.error(f"Diagnostic process failed: {e}", exc_info=True)
            return self.fail_response(f"Sandbox diagnostic process failed: {str(e)}")

    # Helper methods

    async def _simple_download_video(self, video_url: str, title: str, video_id: str) -> Optional[str]:
        """Simplified video download based on working Omniscience labs approach."""
        try:
            logger.info(f"🔽 Starting simplified video download for {video_id}")
            
            # Quick sandbox check
            try:
                await self._ensure_sandbox()
                logger.info(f"✅ Sandbox ready: {self.sandbox_id}")
            except Exception as sandbox_error:
                logger.warning(f"⚠️ Sandbox not available: {sandbox_error}")
                return None
            
            # Clean filename
            safe_title = "".join(c for c in title if c.isalnum() or c in (' ', '-', '_')).rstrip()[:30]
            filename = f"{safe_title}_{video_id[:8]}.mp4"
            file_path = f"/workspace/{filename}"
            
            logger.info(f"📁 Target: {file_path}")
            
            # Simple download with reasonable timeout
            async with httpx.AsyncClient(timeout=httpx.Timeout(60)) as client:
                response = await client.get(video_url)
                response.raise_for_status()
                
                content_size = len(response.content)
                logger.info(f"📦 Downloaded {content_size / (1024 * 1024):.1f}MB")
                
                # Validate minimum size
                if content_size < 50 * 1024:  # 50KB minimum
                    raise Exception(f"File too small: {content_size} bytes")
                
                # Write to sandbox
                await self.sandbox.write_file(file_path, response.content)
                logger.info(f"✅ Video saved to sandbox: {file_path}")
                return file_path
                
        except Exception as e:
            logger.error(f"💥 Simplified download failed: {e}")
            return None

    async def _async_poll_and_download(
        self, 
        video_id: str, 
        video_title: str, 
        text: str, 
        avatar_id: str, 
        voice_id: str, 
        max_wait_time: int = 300
    ) -> ToolResult:
        """Smart async polling: starts generation, polls with progress updates, returns final video."""
        logger.info(f"🔄 Starting intelligent polling for video {video_id} (max wait: {max_wait_time}s)")
        
        # Initial response - let user know we're processing
        logger.info(f"📹 Processing video: {text[:50]}{'...' if len(text) > 50 else ''}")
        
        start_time = asyncio.get_event_loop().time()
        check_count = 0
        
        while (asyncio.get_event_loop().time() - start_time) < max_wait_time:
            try:
                check_count += 1
                
                # Check video status
                async with httpx.AsyncClient() as client:
                    response = await client.get(
                        f"{self.heygen_base_url}/v1/video_status.get?video_id={video_id}",
                        headers=self._get_heygen_headers(),
                        timeout=15.0
                    )
                    
                    if response.status_code == 200:
                        result = response.json()
                        status = result.get("data", {}).get("status")
                        video_url = result.get("data", {}).get("video_url")
                        
                        if status == "completed" and video_url:
                            # Video is ready! Try simplified download first
                            logger.info(f"✅ Video {video_id} completed! Attempting download...")
                            
                            # Try simplified download approach first
                            download_path = await self._simple_download_video(video_url, video_title, video_id)
                            if download_path:
                                # Save metadata
                                await self._save_video_metadata(video_id, video_title, text, avatar_id, voice_id, download_path)
                                
                                logger.info(f"🎉 Successfully downloaded video: {download_path}")
                                return self.success_response(
                                    f"🎉 **Video completed and downloaded!**\n\n"
                                    f"📁 **File:** `{download_path}`\n"
                                    f"🎬 **Video ID:** `{video_id}`\n"
                                    f"📝 **Text:** \"{text[:100]}{'...' if len(text) > 100 else ''}\"\n"
                                    f"👤 **Avatar:** {avatar_id}\n"
                                    f"⏱️ **Time:** {int(asyncio.get_event_loop().time() - start_time)}s\n\n"
                                    f"Your video is ready in the sandbox! 🚀",
                                    attachments=[download_path]
                                )
                            else:
                                # Simplified download failed, provide direct access
                                logger.warning(f"⚠️ Sandbox download failed for {video_id}, providing direct URL")
                                return self.success_response(
                                    f"🎬 **Video completed!** (Sandbox download failed)\n\n"
                                    f"📁 **Direct download URL:** {video_url}\n\n"
                                    f"🎬 **Video ID:** `{video_id}`\n"
                                    f"📝 **Text:** \"{text[:100]}{'...' if len(text) > 100 else ''}\"\n"
                                    f"👤 **Avatar:** {avatar_id}\n"
                                    f"⏱️ **Time:** {int(asyncio.get_event_loop().time() - start_time)}s\n\n"
                                    f"💡 **Tip:** Right-click the URL above and 'Save As' to download the video directly.\n"
                                    f"🔧 The sandbox had connection issues, but your video is ready!"
                                )
                                
                        elif status == "failed":
                            logger.error(f"Video {video_id} generation failed")
                            return self.fail_response(f"HeyGen video generation failed for video ID: {video_id}")
                            
                        else:
                            # Still processing - give progress update every few checks
                            elapsed = int(asyncio.get_event_loop().time() - start_time)
                            if check_count % 3 == 0:  # Every 3rd check (roughly every 30 seconds)
                                logger.info(f"Video {video_id} still processing: {elapsed}s elapsed, status: {status}")
                            
                            logger.info(f"Video {video_id} status: {status}, elapsed: {elapsed}s")
                            
            except Exception as e:
                logger.error(f"Error polling video status: {e}")
            
            # Smart polling intervals: start fast, then slow down
            if check_count <= 2:
                await asyncio.sleep(5)   # First 2 checks: every 5 seconds (for quick videos)
            elif check_count <= 6:
                await asyncio.sleep(10)  # Next 4 checks: every 10 seconds
            elif check_count <= 12:
                await asyncio.sleep(15)  # Next 6 checks: every 15 seconds  
            else:
                await asyncio.sleep(20)  # After that: every 20 seconds (for long videos)
        
        # Timeout reached
        logger.warning(f"Video {video_id} timed out after {max_wait_time} seconds")
        return self.fail_response(
            f"⏰ **Video generation timed out** after {max_wait_time} seconds.\n\n"
            f"**Video ID:** `{video_id}`\n"
            f"**Status:** Still processing - video generation can sometimes take longer for complex requests\n\n"
            f"**Options:**\n"
            f"1. Use `check_video_status('{video_id}')` to check if it's ready now\n"
            f"2. Try again with a shorter video or simpler request\n"
            f"3. Contact support if this happens frequently\n\n"
            f"*Note: The video may still complete in the background and be available later.*"
        )

    async def _wait_for_video_completion(self, video_id: str, max_wait_time: int = 300) -> Optional[str]:
        """Wait for video generation to complete and return the video URL."""
        start_time = asyncio.get_event_loop().time()
        
        while (asyncio.get_event_loop().time() - start_time) < max_wait_time:
            try:
                async with httpx.AsyncClient() as client:
                    response = await client.get(
                        f"{self.heygen_base_url}/v1/video_status.get?video_id={video_id}",
                        headers=self._get_heygen_headers(),
                        timeout=30.0
                    )
                    
                    if response.status_code == 200:
                        result = response.json()
                        status = result.get("data", {}).get("status")
                        video_url = result.get("data", {}).get("video_url")
                        
                        if status == "completed" and video_url:
                            logger.info(f"Video {video_id} completed successfully")
                            return video_url
                        elif status == "failed":
                            logger.error(f"Video {video_id} generation failed")
                            return None
                        
                        logger.info(f"Video {video_id} status: {status}, waiting...")
                
            except Exception as e:
                logger.error(f"Error checking video status: {e}")
            
            await asyncio.sleep(10)  # Wait 10 seconds before next check
        
        logger.warning(f"Video {video_id} generation timed out after {max_wait_time} seconds")
        return None

    async def _download_video(self, video_url: str, title: str, video_id: str) -> Optional[str]:
        """Download video to sandbox workspace with robust error handling and retry logic."""
        max_retries = 3
        retry_delay = 5  # seconds
        
        for attempt in range(max_retries):
            try:
                logger.info(f"Starting video download attempt {attempt + 1}/{max_retries} for {video_id}")
                
                # Ensure sandbox is ready with validation
                try:
                    await self._ensure_sandbox()
                    
                    # Validate sandbox state
                    sandbox_state = await self._validate_sandbox_state()
                    if not sandbox_state:
                        raise Exception("Sandbox is not in a ready state")
                        
                    logger.info(f"Sandbox validated successfully, ID: {self.sandbox_id}")
                except Exception as sandbox_error:
                    logger.error(f"Sandbox initialization/validation failed: {sandbox_error}")
                    if attempt < max_retries - 1:
                        logger.info(f"Retrying in {retry_delay} seconds...")
                        await asyncio.sleep(retry_delay)
                        continue
                    raise Exception(f"Sandbox initialization failed after {max_retries} attempts: {sandbox_error}")
                
                # Clean filename with better sanitization
                safe_title = "".join(c for c in title if c.isalnum() or c in (' ', '-', '_')).rstrip()
                safe_title = safe_title[:50]  # Limit length
                filename = f"{safe_title}_{video_id}.mp4"
                file_path = f"/workspace/{filename}"
                
                logger.info(f"Target file path: {file_path}, filename: {filename}")
                
                # Download video with progressive timeout and validation
                logger.info(f"Downloading video from: {video_url[:50]}...")
                
                # Use extended timeout with proper client configuration
                timeout_config = httpx.Timeout(connect=30.0, read=180.0, write=60.0, pool=30.0)
                async with httpx.AsyncClient(timeout=timeout_config, limits=httpx.Limits(max_keepalive_connections=5, max_connections=10)) as client:
                    # Download with streaming to handle large files better
                    async with client.stream('GET', video_url) as response:
                        response.raise_for_status()
                        
                        # Validate content type
                        content_type = response.headers.get('content-type', '').lower()
                        if 'video' not in content_type and 'application/octet-stream' not in content_type:
                            logger.warning(f"Unexpected content type: {content_type}")
                        
                        # Stream download to handle large files
                        content_chunks = []
                        total_size = 0
                        chunk_size = 1024 * 1024  # 1MB chunks
                        
                        async for chunk in response.aiter_bytes(chunk_size):
                            content_chunks.append(chunk)
                            total_size += len(chunk)
                            
                            # Log progress for large files
                            if total_size % (10 * 1024 * 1024) == 0:  # Every 10MB
                                logger.info(f"Downloaded {total_size / (1024 * 1024):.1f}MB...")
                        
                        # Combine all chunks
                        video_content = b''.join(content_chunks)
                        content_size = len(video_content)
                        
                        logger.info(f"Download completed: {content_size} bytes ({content_size / (1024 * 1024):.1f}MB)")
                        
                        # Validate minimum file size (videos should be at least 100KB)
                        if content_size < 100 * 1024:
                            raise Exception(f"Downloaded file too small ({content_size} bytes), likely corrupted")
                        
                        # Validate basic MP4 structure (check for ftyp box)
                        if not self._validate_mp4_header(video_content):
                            logger.warning("Downloaded file may not be a valid MP4 - proceeding anyway")
                        
                        # Save to sandbox with enhanced error handling
                        try:
                            logger.info(f"Writing {content_size} bytes to sandbox: {file_path}")
                            await self.sandbox.fs.upload_file(video_content, file_path)
                            
                            # Verify the file was written successfully
                            try:
                                # Try to stat the file to confirm it exists
                                file_info = await self.sandbox.fs.stat(file_path)
                                logger.info(f"File successfully written to sandbox: {file_path} (size: {file_info.size if hasattr(file_info, 'size') else 'unknown'})")
                            except Exception as stat_error:
                                logger.warning(f"Could not verify file existence: {stat_error}")
                            
                            logger.info(f"Video downloaded and saved successfully: {filename}")
                            return filename  # Return relative path for attachment
                            
                        except Exception as write_error:
                            logger.error(f"Sandbox file write failed: {write_error}")
                            logger.error(f"Attempted to write {content_size} bytes to {file_path}")
                            raise Exception(f"Sandbox write failed: {write_error}")
                        
            except Exception as e:
                logger.error(f"Download attempt {attempt + 1} failed: {e}")
                if attempt < max_retries - 1:
                    retry_delay_current = retry_delay * (attempt + 1)  # Progressive backoff
                    logger.info(f"Retrying in {retry_delay_current} seconds...")
                    await asyncio.sleep(retry_delay_current)
                else:
                    logger.error(f"All {max_retries} download attempts failed")
                    return None
        
        return None
        
    def _validate_mp4_header(self, content: bytes) -> bool:
        """Basic MP4 header validation."""
        try:
            # MP4 files should start with ftyp box within first 16 bytes typically
            return b'ftyp' in content[:32] or b'mp4' in content[:32].lower()
        except Exception:
            return False
            
    async def _validate_sandbox_state(self) -> bool:
        """Validate that the sandbox is in a ready state for file operations."""
        try:
            if not self._sandbox:
                return False
                
            # Try a simple operation to test sandbox responsiveness
            test_path = "/workspace/.sandbox_test"
            test_content = b"test"
            
            await self.sandbox.fs.upload_file(test_content, test_path)
            
            # Clean up test file
            try:
                await self.sandbox.fs.delete(test_path)
            except Exception:
                pass  # Ignore cleanup failures
                
            return True
            
        except Exception as e:
            logger.error(f"Sandbox validation failed: {e}")
            return False

    async def _save_video_metadata(self, video_id: str, title: str, text: str, avatar_id: str, voice_id: str, file_path: str):
        """Save video metadata as JSON file."""
        try:
            await self._ensure_sandbox()
            
            metadata = {
                "video_id": video_id,
                "title": title,
                "text": text,
                "avatar_id": avatar_id,
                "voice_id": voice_id,
                "file_path": file_path,
                "generated_at": datetime.utcnow().isoformat(),
                "tool": "sb_video_avatar_tool"
            }
            
            metadata_path = f"/workspace/{title.replace(' ', '_')}_{video_id}_metadata.json"
            await self.sandbox.fs.upload_file(json.dumps(metadata, indent=2).encode(), metadata_path)
            
            logger.info(f"Video metadata saved: {metadata_path}")
            
        except Exception as e:
            logger.warning(f"Failed to save video metadata: {e}")

    async def _save_session_metadata(self, session_name: str, session_data: Dict[str, Any]):
        """Save session metadata as JSON file."""
        try:
            await self._ensure_sandbox()
            
            metadata_path = f"/workspace/avatar_session_{session_name}_metadata.json"
            await self.sandbox.fs.upload_file(json.dumps(session_data, indent=2).encode(), metadata_path)
            
            logger.info(f"Session metadata saved: {metadata_path}")
            
        except Exception as e:
            logger.warning(f"Failed to save session metadata: {e}")