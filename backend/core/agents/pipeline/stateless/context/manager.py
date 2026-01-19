import json
import uuid
from typing import Dict, Any, List, Optional, Tuple
from dataclasses import dataclass

from core.utils.logger import logger


@dataclass
class CompressionResult:
    summary: str
    facts: Dict[str, Any]
    compressed_count: int
    working_memory_size: int
    estimated_tokens_saved: int


@dataclass
class ContextLayers:
    facts_message: Optional[Dict[str, Any]] = None  # Layer 1
    summary_message: Optional[Dict[str, Any]] = None  # Layer 2
    working_memory: List[Dict[str, Any]] = None  # Layer 3
    
    def __post_init__(self):
        if self.working_memory is None:
            self.working_memory = []
    
    def to_messages(self) -> List[Dict[str, Any]]:
        messages = []
        
        if self.facts_message:
            messages.append(self.facts_message)
        
        if self.summary_message:
            messages.append(self.summary_message)
        
        messages.extend(self.working_memory)
        
        return messages
    
    @property
    def total_messages(self) -> int:
        return len(self.to_messages())


class ContextManager:
    DEFAULT_WORKING_MEMORY_SIZE = 18
    
    @staticmethod
    def find_summary_message(messages: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        for msg in messages:
            if msg.get('type') == 'thread_summary' or msg.get('_is_summary'):
                return msg
        return None
    
    @staticmethod
    def extract_layers(messages: List[Dict[str, Any]]) -> ContextLayers:
        summary_msg = None
        working_memory = []
        
        for msg in messages:
            if msg.get('type') == 'thread_summary' or msg.get('_is_summary'):
                summary_msg = msg
            elif not msg.get('type') in ['thread_summary']:
                working_memory.append(msg)
        
        if not summary_msg:
            return ContextLayers(working_memory=messages)
        
        content = summary_msg.get('content', {})
        if isinstance(content, str):
            try:
                content = json.loads(content)
            except json.JSONDecodeError:
                content = {}
        
        facts = content.get('facts', {})
        summary_text = content.get('summary', '')
        
        if summary_text:
            summary_as_user_msg = {
                "role": "user",
                "content": f"[CONVERSATION HISTORY SUMMARY]\n\n{summary_text}\n\n{ContextManager._format_facts_inline(facts)}",
                "message_id": str(uuid.uuid4()),
                "_is_summary_inline": True
            }
            working_memory.insert(0, summary_as_user_msg)
        
        return ContextLayers(
            facts_message=None,    
            summary_message=None,
            working_memory=working_memory
        )
    
    @staticmethod
    def _format_facts_inline(facts: Dict[str, Any]) -> str:
        if not facts:
            return ""
        
        lines = ["\n---\n# KEY CONTEXT\n"]
        
        if user_info := facts.get('user_info', {}):
            if name := user_info.get('name'):
                lines.append(f"User: {name}")
            if prefs := user_info.get('preferences', []):
                lines.append(f"Preferences: {', '.join(prefs[:3])}")
        
        if project := facts.get('project', {}):
            if name := project.get('name'):
                lines.append(f"Project: {name}")
            if stack := project.get('tech_stack', []):
                lines.append(f"Stack: {', '.join(stack[:5])}")
        
        if decisions := facts.get('decisions', []):
            lines.append(f"Key Decisions: {', '.join(decisions[:3])}")
        
        return "\n".join(lines)
    
    @staticmethod
    def _format_facts_message(facts: Dict[str, Any]) -> Dict[str, Any]:
        lines = ["# PROJECT CONTEXT\n"]
        
        if user_info := facts.get('user_info', {}):
            if name := user_info.get('name'):
                lines.append(f"**User:** {name}")
            if role := user_info.get('role'):
                lines.append(f"**Role:** {role}")
            if prefs := user_info.get('preferences', []):
                lines.append(f"**Preferences:** {', '.join(prefs)}")
            lines.append("")
        
        if project := facts.get('project', {}):
            if name := project.get('name'):
                lines.append(f"**Project:** {name}")
            if ptype := project.get('type'):
                lines.append(f"**Type:** {ptype}")
            if stack := project.get('tech_stack', []):
                lines.append(f"**Tech Stack:** {', '.join(stack)}")
            lines.append("")
        
        if goal := facts.get('current_goal'):
            lines.append(f"**Current Goal:** {goal}\n")
        
        if decisions := facts.get('decisions', []):
            lines.append("**Key Decisions:**")
            for decision in decisions:
                lines.append(f"- {decision}")
            lines.append("")
        
        if entities := facts.get('entities', []):
            lines.append(f"**Key Entities:** {', '.join(entities)}")
        
        return {
            "role": "system",
            "content": "\n".join(lines),
            "_is_facts": True,
            "message_id": str(uuid.uuid4())
        }
    
    @staticmethod
    def _format_summary_message(summary: str, content: Dict[str, Any]) -> Dict[str, Any]:
        compressed_count = content.get('compressed_count', 0)
        
        summary_text = f"""# CONVERSATION HISTORY

{summary}

---
*(Compressed summary of {compressed_count} messages)*"""
        
        return {
            "role": "system",
            "content": summary_text,
            "_is_summary": True,
            "_compressed_count": compressed_count,
            "message_id": str(uuid.uuid4())
        }
    
    @staticmethod
    def should_compress(
        messages: List[Dict[str, Any]],
        working_memory_size: int = DEFAULT_WORKING_MEMORY_SIZE
    ) -> bool:
        if len(messages) < working_memory_size + 20:
            return False
        
        if ContextManager.find_summary_message(messages):
            return False
        
        return True
    
    @staticmethod
    async def compress_history(
        messages: List[Dict[str, Any]],
        working_memory_size: int = DEFAULT_WORKING_MEMORY_SIZE,
        model: str = "gpt-4o-mini"
    ) -> CompressionResult:
        
        if len(messages) <= working_memory_size:
            raise ValueError(f"Not enough messages to compress (need >{working_memory_size}, got {len(messages)})")
        
        to_compress = messages[:-working_memory_size]
        working_memory = messages[-working_memory_size:]
        
        recent_context = working_memory[:3] if len(working_memory) >= 3 else working_memory
        
        result = await ContextManager._summarize_with_facts(
            old_messages=to_compress,
            recent_context=recent_context,
            model=model
        )
        
        estimated_old_tokens = sum(len(str(m.get('content', ''))) // 4 for m in to_compress)
        estimated_new_tokens = len(result['summary']) // 4 + 500
        tokens_saved = estimated_old_tokens - estimated_new_tokens
        
        return CompressionResult(
            summary=result['summary'],
            facts=result['facts'],
            compressed_count=len(to_compress),
            working_memory_size=len(working_memory),
            estimated_tokens_saved=tokens_saved
        )
    
    @staticmethod
    async def _summarize_with_facts(
        old_messages: List[Dict[str, Any]],
        recent_context: List[Dict[str, Any]],
        model: str = "gpt-4o-mini"
    ) -> Dict[str, Any]:
        from core.agentpress.thread_manager.services.execution.llm_executor import make_llm_api_call
        
        formatted_old = ContextManager._format_messages_for_prompt(old_messages)
        formatted_recent = ContextManager._format_messages_for_prompt(recent_context)
        
        prompt = f"""You are compressing conversation history for an AI agent that's in the middle of a task.

RECENT CONTEXT (what agent is currently doing):
{formatted_recent}

OLD MESSAGES TO COMPRESS ({len(old_messages)} messages):
{formatted_old}

Generate TWO outputs:

1. SUMMARY (500-800 words):
   - What the user originally requested
   - Major decisions made (tech choices, architecture, preferences)
   - Work completed (files created, features built, APIs developed, etc.)
   - Important context the agent needs to continue the current task
   - Any errors/issues encountered and how they were resolved
   
   Write as a clear narrative focused on facts and outcomes, not back-and-forth discussion.

2. FACTS (structured JSON):
{{
  "user_info": {{
    "name": "User's name if mentioned",
    "role": "Their role/expertise if mentioned",
    "preferences": ["Prefers TypeScript", "Likes detailed comments", etc.]
  }},
  "project": {{
    "name": "Project name if any",
    "type": "Type of project (e.g., SaaS app, API, mobile app)",
    "tech_stack": ["FastAPI", "PostgreSQL", "React", etc.]
  }},
  "decisions": ["Using Stripe for payments", "JWT authentication", "Monthly subscription model", etc.],
  "entities": ["Stripe", "PostgreSQL", "AWS", "CompanyName", etc.],
  "current_goal": "Brief description of what user is trying to accomplish"
}}

Return ONLY valid JSON in this exact format:
{{
  "summary": "Your 500-800 word summary here...",
  "facts": {{
    "user_info": {{}},
    "project": {{}},
    "decisions": [],
    "entities": [],
    "current_goal": ""
  }}
}}"""
        
        try:
            response = await make_llm_api_call(
                messages=[{"role": "user", "content": prompt}],
                model_name=model,
                temperature=0.1,
                max_tokens=2500
            )
            
            full_response = ""
            if hasattr(response, '__aiter__'):
                async for chunk in response:
                    if isinstance(chunk, dict):
                        if chunk.get('type') == 'content':
                            full_response += chunk.get('content', '')
                    elif hasattr(chunk, 'choices') and chunk.choices:
                        delta = getattr(chunk.choices[0], 'delta', None)
                        if delta and hasattr(delta, 'content') and delta.content:
                            full_response += delta.content
            elif isinstance(response, str):
                full_response = response
            else:
                full_response = str(response)
            
            result = json.loads(full_response)
            
            if 'summary' not in result or 'facts' not in result:
                raise ValueError("Invalid response structure")
            
            return result
            
        except json.JSONDecodeError as e:
            logger.error(f"[ContextManager] Failed to parse LLM response as JSON: {e}")
            logger.error(f"[ContextManager] Raw response: {response[:500]}")
            
            return {
                "summary": f"Conversation history covering {len(old_messages)} messages. [Summary generation failed, using fallback]",
                "facts": {
                    "user_info": {},
                    "project": {},
                    "decisions": [],
                    "entities": [],
                    "current_goal": "Unknown"
                }
            }
        except Exception as e:
            logger.error(f"[ContextManager] Summarization failed: {e}")
            raise
    
    @staticmethod
    def _format_messages_for_prompt(messages: List[Dict[str, Any]]) -> str:
        lines = []
        
        for i, msg in enumerate(messages, 1):
            role = msg.get('role', 'unknown')
            content = msg.get('content', '')
            
            if isinstance(content, list):
                text_parts = []
                for block in content:
                    if isinstance(block, dict):
                        if block.get('type') == 'text':
                            text_parts.append(block.get('text', ''))
                        elif block.get('type') == 'tool_use':
                            text_parts.append(f"[tool: {block.get('name')}]")
                content = ' '.join(text_parts)
            elif isinstance(content, dict):
                content = json.dumps(content)
            
            if len(str(content)) > 500:
                content = str(content)[:500] + "..."
            
            lines.append(f"{i}. [{role}]: {content}")
        
        return "\n".join(lines)
    
    @staticmethod
    def create_summary_message_data(
        thread_id: str,
        summary: str,
        facts: Dict[str, Any],
        compressed_count: int,
        compressed_message_ids: List[str]
    ) -> Dict[str, Any]:
        message_id = str(uuid.uuid4())
        
        return {
            "message_id": message_id,
            "thread_id": thread_id,
            "type": "thread_summary",
            "content": {
                "summary": summary,
                "facts": facts,
                "compressed_count": compressed_count,
                "compressed_message_ids": compressed_message_ids
            },
            "metadata": {
                "created_at": "now()",
                "last_message_id": compressed_message_ids[-1] if compressed_message_ids else None
            },
            "is_llm_message": False
        }
    
    @staticmethod
    def estimate_tokens(messages: List[Dict[str, Any]]) -> int:
        total_chars = sum(len(str(msg.get('content', ''))) for msg in messages)
        return total_chars // 4
