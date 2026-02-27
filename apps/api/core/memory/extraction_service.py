import json
from typing import List, Dict, Any, Optional
from core.utils.logger import logger
from core.utils.config import config
from core.ai_models import model_manager
from core.prompts.memory_extraction_prompt import MEMORY_EXTRACTION_PROMPT
from .models import ExtractedMemory, MemoryType


class MemoryExtractionService:
    def __init__(self, model: Optional[str] = None):
        self.model = model or config.MEMORY_EXTRACTION_MODEL or "kortix/basic"
        self._client = None
    
    @property
    def client(self):
        if self._client is None:
            try:
                import litellm
                self._client = litellm
            except ImportError:
                logger.error("litellm not installed")
                raise
        return self._client
    
    def _get_resolved_model(self) -> str:
        resolved = model_manager.resolve_model_id(self.model)
        litellm_model = model_manager.get_litellm_model_id(resolved)
        return litellm_model
    
    def _format_conversation(self, messages: List[Dict[str, Any]]) -> str:
        formatted = []
        for msg in messages:
            msg_type = msg.get('type', 'unknown')
            content = msg.get('content', {})
            
            if isinstance(content, str):
                try:
                    content = json.loads(content)
                except:
                    pass
            
            if msg_type == 'user':
                if isinstance(content, dict):
                    text = content.get('content', str(content))
                else:
                    text = str(content)
                formatted.append(f"User: {text}")
            
            elif msg_type == 'assistant':
                if isinstance(content, dict):
                    text = content.get('content', '')
                    if not text and 'tool_calls' in content:
                        continue
                else:
                    text = str(content)
                if text:
                    formatted.append(f"Assistant: {text}")
        
        return "\n\n".join(formatted)
    
    async def extract_memories(
        self,
        messages: List[Dict[str, Any]],
        account_id: str,
        thread_id: str
    ) -> List[ExtractedMemory]:
        # Check global memory flag first
        if not config.ENABLE_MEMORY:
            logger.debug("Memory extraction skipped: ENABLE_MEMORY is False")
            return []
        
        try:
            logger.debug(f"Starting memory extraction for {len(messages)} messages")
            conversation_text = self._format_conversation(messages)
            logger.debug(f"Formatted conversation length: {len(conversation_text)}")
            
            if not conversation_text or len(conversation_text.strip()) < 20:
                logger.debug(f"Conversation too short for memory extraction: {thread_id}")
                return []
            
            prompt = MEMORY_EXTRACTION_PROMPT.format(conversation=conversation_text)
            
            resolved_model = self._get_resolved_model()
            logger.info(f"Using model for memory extraction: {self.model} -> {resolved_model}")
            
            response = await self.client.acompletion(
                model=resolved_model,
                messages=[
                    {"role": "user", "content": prompt}
                ],
                temperature=0.1,
                max_tokens=2000,
                timeout=60, 
            )
            
            logger.debug(f"Got response from LLM")
            content = response.choices[0].message.content
            logger.info(f"Raw extraction response length: {len(content) if content else 0}")
            
            try:
                json_content = content
                if '```json' in content:
                    parts = content.split('```json')
                    if len(parts) > 1:
                        json_content = parts[1].split('```')[0].strip()
                elif '```' in content:
                    parts = content.split('```')
                    if len(parts) > 1:
                        json_content = parts[1].split('```')[0].strip()
                
                start_idx = json_content.find('{')
                end_idx = json_content.rfind('}')
                if start_idx != -1 and end_idx != -1:
                    json_content = json_content[start_idx:end_idx + 1]
                
                result = json.loads(json_content)
                
                worth_extracting = result.get('worth_extracting', True)
                reason = result.get('reason', '')
                
                if not worth_extracting:
                    logger.info(f"LLM decided not to extract memories from thread {thread_id}: {reason}")
                    return []
                
                memories_data = result.get('memories', [])
                
                if not memories_data:
                    logger.info(f"No memories to extract from thread {thread_id}: {reason}")
                    return []
                
                extracted_memories = []
                for mem in memories_data:
                    try:
                        memory = ExtractedMemory(
                            content=mem['content'],
                            memory_type=MemoryType(mem['memory_type']),
                            confidence_score=float(mem.get('confidence_score', 0.8)),
                            metadata=mem.get('metadata', {})
                        )
                        extracted_memories.append(memory)
                    except Exception as e:
                        logger.warning(f"Failed to parse memory: {e}")
                        continue
                
                logger.info(f"Extracted {len(extracted_memories)} memories from thread {thread_id}")
                return extracted_memories
            
            except json.JSONDecodeError as e:
                logger.error(f"Failed to parse extraction response: {e}, content: {content[:500]}")
                return []
        
        except Exception as e:
            logger.error(f"Memory extraction error for thread {thread_id}: {str(e)}")
            return []
    
    async def should_extract(
        self,
        messages: List[Dict[str, Any]],
        min_messages: int = 1
    ) -> bool:
        if len(messages) < min_messages:
            return False
        
        user_messages = [m for m in messages if m.get('type') == 'user']
        if len(user_messages) < 1:
            return False
        
        return True

memory_extraction_service = MemoryExtractionService()
