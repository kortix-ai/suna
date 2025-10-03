"""
Image context management for conversation threads.
Handles loading, storing, and removing images from conversation context.
"""

import json
from typing import Dict, Any, Optional, List, TYPE_CHECKING
from core.services.supabase import DBConnection
from core.utils.logger import logger

if TYPE_CHECKING:
    from core.agentpress.thread_manager import ThreadManager


class ImageContextManager:
    """Manages image context for conversation threads."""
    
    def __init__(self, thread_manager: Optional['ThreadManager'] = None):
        self.thread_manager = thread_manager
        self.db = DBConnection()
    
    async def add_image_to_context(
        self, 
        thread_id: str, 
        image_url: str,
        mime_type: str, 
        file_path: str,
        original_size: int,
        compressed_size: int
    ) -> Optional[Dict[str, Any]]:
        """Add an image to the conversation context as a proper LLM message using image URL."""
        try:
            # Create the LLM-compatible message format directly
            message_content = {
                "role": "user",
                "content": [
                    {"type": "text", "text": f"Here is the image from '{file_path}':"},
                    {"type": "image_url", "image_url": {"url": image_url}}
                ]
            }
            
            # Store metadata separately for reference
            metadata = {
                "image_context": True,
                "file_path": file_path,
                "mime_type": mime_type,
                "original_size": original_size,
                "compressed_size": compressed_size
            }
            
            # Use ThreadManager's add_message if available, otherwise direct DB access
            if self.thread_manager:
                result = await self.thread_manager.add_message(
                    thread_id=thread_id,
                    type='user',
                    content=message_content,
                    is_llm_message=True,
                    metadata=metadata
                )
            else:
                # Fallback to direct DB access
                client = await self.db.client
                db_result = await client.table('messages').insert({
                    'thread_id': thread_id,
                    'type': 'user',
                    'content': message_content,
                    'is_llm_message': True,
                    'metadata': metadata
                }).execute()
                result = db_result.data[0] if db_result.data and len(db_result.data) > 0 else None
            
            if result:
                logger.debug(f"Added image to context: {file_path}")
                return result
            else:
                logger.error("Failed to insert image message")
                return None
                
        except Exception as e:
            logger.error(f"Failed to add image to context: {str(e)}", exc_info=True)
            return None
    
    async def clear_images_from_context(self, thread_id: str) -> int:
        """Remove all image context messages from a thread."""
        try:
            client = await self.db.client
            
            # Delete all messages with image_context metadata
            result = await client.table('messages').delete().eq(
                'thread_id', thread_id
            ).eq(
                'is_llm_message', True
            ).contains(
                'metadata', {'image_context': True}
            ).execute()
            
            deleted_count = len(result.data) if result.data else 0
            logger.debug(f"Cleared {deleted_count} images from context")
            return deleted_count
            
        except Exception as e:
            logger.error(f"Failed to clear images from context: {str(e)}", exc_info=True)
            return 0
    
    async def get_image_count_in_context(self, thread_id: str) -> int:
        """Get the number of images currently in the conversation context."""
        try:
            client = await self.db.client
            
            result = await client.table('messages').select(
                'message_id', count='exact'
            ).eq(
                'thread_id', thread_id
            ).eq(
                'is_llm_message', True
            ).contains(
                'metadata', {'image_context': True}
            ).execute()
            
            return result.count or 0
            
        except Exception as e:
            logger.error(f"Failed to get image count: {str(e)}", exc_info=True)
            return 0
    
    async def list_images_in_context(self, thread_id: str) -> List[Dict[str, Any]]:
        """List all images currently in the conversation context."""
        try:
            client = await self.db.client
            
            result = await client.table('messages').select(
                'message_id, metadata, created_at'
            ).eq(
                'thread_id', thread_id
            ).eq(
                'is_llm_message', True
            ).contains(
                'metadata', {'image_context': True}
            ).order('created_at').execute()
            
            images = []
            for item in result.data or []:
                metadata = item.get('metadata', {})
                images.append({
                    'message_id': item['message_id'],
                    'file_path': metadata.get('file_path'),
                    'mime_type': metadata.get('mime_type'),
                    'original_size': metadata.get('original_size'),
                    'compressed_size': metadata.get('compressed_size'),
                    'created_at': item['created_at']
                })
            
            return images
            
        except Exception as e:
            logger.error(f"Failed to list images in context: {str(e)}", exc_info=True)
            return []
