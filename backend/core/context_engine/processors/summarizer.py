import json
import hashlib
from typing import List, Dict, Any, Optional, Tuple
from dataclasses import dataclass, field
from datetime import datetime, timezone
from core.utils.logger import logger
from core.utils.cache import Cache
from ..utils.tokens import count_tokens


@dataclass
class ExtractedFact:
    content: str
    confidence: float = 1.0
    source_time: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


class FactStore:
    def __init__(self, max_facts: int = 100):
        self._facts: List[ExtractedFact] = []
        self._max_facts = max_facts
    
    def add(self, content: str, confidence: float = 1.0):
        content = content.strip()
        if not content:
            return
        
        for existing in self._facts:
            if existing.content.lower() == content.lower():
                existing.confidence = max(existing.confidence, confidence)
                return
        
        self._facts.append(ExtractedFact(content=content, confidence=confidence))
        
        if len(self._facts) > self._max_facts:
            self._facts = sorted(self._facts, key=lambda f: f.confidence, reverse=True)[:self._max_facts]
    
    def add_many(self, facts: List[Dict[str, Any]]):
        for f in facts:
            if isinstance(f, dict) and f.get("fact"):
                self.add(f["fact"], f.get("confidence", 0.8))
            elif isinstance(f, str):
                self.add(f, 0.8)
    
    def to_context(self) -> str:
        if not self._facts:
            return ""
        
        sorted_facts = sorted(self._facts, key=lambda f: f.confidence, reverse=True)
        lines = [f"• {f.content}" for f in sorted_facts]
        return "\n".join(lines)
    
    def get_tokens(self) -> int:
        return count_tokens(self.to_context())
    
    @property
    def count(self) -> int:
        return len(self._facts)
    
    def clear(self):
        self._facts = []


class HybridSummarizer:
    
    SUMMARIZE_AND_EXTRACT_PROMPT = """Analyze this conversation and produce three outputs:

1. **FACTS**: Extract ALL important facts that should NEVER be forgotten. Include:
   - User identity (name, role, company, team)
   - Project details (names, goals, tech stack)
   - Credentials (API keys, tokens, passwords, IPs, URLs)
   - Decisions made
   - Tasks completed (what was done, what files were created)
   - Deadlines, dates, numbers, budgets
   - Preferences expressed
   - Anything explicitly asked to remember

2. **IMPORTANT_MESSAGES**: List the message indices (0-based) that contain critical information.
   Include messages with: credentials, key decisions, explicit memory requests, complex instructions, project requirements.
   EXCLUDE trivial messages like "ok", "thanks", "got it", "yes", "no", short acknowledgments.

3. **SUMMARY**: Brief narrative of what happened (~{target_words} words)

Respond in this exact JSON format:
{{
  "facts": [
    {{"fact": "User's name is X", "confidence": 1.0}},
    {{"fact": "Working on project Y", "confidence": 0.9}}
  ],
  "important_message_indices": [0, 3, 7],
  "summary": "Brief narrative..."
}}

Conversation:
{conversation}

JSON response:"""
    
    def __init__(
        self,
        use_llm: bool = True,
        cache_ttl: int = 3600,
        max_llm_calls_per_compile: int = 5,
    ):
        self.use_llm = use_llm
        self.cache_ttl = cache_ttl
        self.max_llm_calls_per_compile = max_llm_calls_per_compile
        self._llm_calls_made = 0
        self._fact_store = FactStore()
        self._important_message_ids: List[str] = []
        self._message_id_mapping: Dict[int, str] = {}
    
    def reset_call_counter(self):
        self._llm_calls_made = 0
        self._important_message_ids = []
        self._message_id_mapping = {}
    
    def can_use_llm(self) -> bool:
        return self.use_llm and self._llm_calls_made < self.max_llm_calls_per_compile
    
    @property
    def fact_store(self) -> FactStore:
        return self._fact_store
    
    def get_preserved_facts_context(self) -> str:
        return self._fact_store.to_context()
    
    def get_important_message_ids(self) -> List[str]:
        return self._important_message_ids.copy()
    
    def set_message_id_mapping(self, mapping: Dict[int, str]):
        self._message_id_mapping = mapping
    
    async def summarize(
        self,
        messages: List[Dict[str, Any]],
        target_tokens: int = 500,
    ) -> str:
        if not messages:
            return ""
        
        cache_key = self._get_cache_key(messages)
        cached = await self._get_cached(cache_key)
        if cached:
            logger.debug(f"Using cached summary for {len(messages)} messages")
            if "facts" in cached:
                self._fact_store.add_many(cached["facts"])
            if "important_message_indices" in cached:
                self._process_important_indices(cached["important_message_indices"])
            return cached.get("summary", "")
        
        if self.can_use_llm():
            try:
                result = await self._llm_summarize_and_extract(messages, target_tokens)
                if result:
                    summary, facts, important_indices = result
                    self._fact_store.add_many(facts)
                    self._process_important_indices(important_indices)
                    await self._cache(cache_key, {
                        "summary": summary, 
                        "facts": facts,
                        "important_message_indices": important_indices,
                    })
                    self._llm_calls_made += 1
                    return summary
            except Exception as e:
                logger.warning(f"LLM summarization failed, falling back to rule-based: {e}")
        
        return self._rule_based_extract(messages, target_tokens)
    
    def _process_important_indices(self, indices: List[int]):
        for idx in indices:
            if idx in self._message_id_mapping:
                msg_id = self._message_id_mapping[idx]
                if msg_id not in self._important_message_ids:
                    self._important_message_ids.append(msg_id)
    
    async def extract_facts_only(
        self,
        messages: List[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        if not messages or not self.can_use_llm():
            return []
        
        try:
            result = await self._llm_summarize_and_extract(messages, 200)
            if result:
                _, facts, important_indices = result
                self._fact_store.add_many(facts)
                self._process_important_indices(important_indices)
                self._llm_calls_made += 1
                return facts
        except Exception as e:
            logger.warning(f"Fact extraction failed: {e}")
        
        return []
    
    async def _llm_summarize_and_extract(
        self,
        messages: List[Dict[str, Any]],
        target_tokens: int,
    ) -> Optional[Tuple[str, List[Dict[str, Any]], List[int]]]:
        try:
            from core.services.llm import make_llm_api_call
        except ImportError:
            logger.warning("LLM service not available")
            return None
        
        conversation_text = self._format_messages(messages)
        target_words = target_tokens // 4
        
        prompt = self.SUMMARIZE_AND_EXTRACT_PROMPT.format(
            target_words=target_words,
            conversation=conversation_text,
        )
        
        try:
            response = await make_llm_api_call(
                messages=[{"role": "user", "content": prompt}],
                model_name="kortix/basic",
                temperature=0.2,
                max_tokens=target_tokens + 500,
                stream=False,
            )
            
            response_text = ""
            if hasattr(response, "choices") and response.choices:
                response_text = response.choices[0].message.content
            elif isinstance(response, dict) and "choices" in response:
                response_text = response["choices"][0]["message"]["content"]
            
            if response_text:
                return self._parse_llm_response(response_text)
            
            return None
            
        except Exception as e:
            logger.error(f"LLM call failed: {e}")
            return None
    
    def _parse_llm_response(self, response: str) -> Optional[Tuple[str, List[Dict[str, Any]], List[int]]]:
        response = response.strip()
        
        if response.startswith("```"):
            lines = response.split("\n")
            if lines[0].startswith("```"):
                lines = lines[1:]
            if lines and lines[-1].startswith("```"):
                lines = lines[:-1]
            response = "\n".join(lines)
        
        try:
            data = json.loads(response)
            facts = data.get("facts", [])
            summary = data.get("summary", "")
            important_indices = data.get("important_message_indices", [])
            return summary, facts, important_indices
        except json.JSONDecodeError:
            start = response.find("{")
            end = response.rfind("}") + 1
            if start != -1 and end > start:
                try:
                    data = json.loads(response[start:end])
                    return (
                        data.get("summary", ""), 
                        data.get("facts", []),
                        data.get("important_message_indices", []),
                    )
                except:
                    pass
        
        return response, [], []
    
    def _rule_based_extract(
        self,
        messages: List[Dict[str, Any]],
        target_tokens: int,
    ) -> str:
        facts = []
        current_tokens = 0
        
        for msg in reversed(messages):
            content = self._get_content(msg)
            if not content:
                continue
            
            role = msg.get("role", "user")
            extracted = self._extract_from_text(content, role)
            
            for fact in extracted:
                tokens = count_tokens(fact)
                if current_tokens + tokens > target_tokens:
                    break
                facts.append(fact)
                current_tokens += tokens
            
            if current_tokens >= target_tokens:
                break
        
        facts.reverse()
        
        if not facts:
            return "[No key information extracted]"
        
        return "[Preserved Information]\n" + "\n".join(f"• {f}" for f in facts)
    
    def _extract_from_text(self, text: str, role: str) -> List[str]:
        results = []
        
        lines = text.replace(". ", ".\n").replace("! ", "!\n").replace("? ", "?\n").split("\n")
        
        for line in lines:
            line = line.strip()
            if len(line) < 10:
                continue
            
            lower = line.lower()
            
            is_identity = any(w in lower for w in ["my name", "i am", "i'm", "i work", "my role", "my company"])
            is_project = any(w in lower for w in ["project", "building", "working on", "creating"])
            is_credential = any(w in lower for w in ["api", "key", "token", "password", "secret", "ip", "url", "http"])
            is_explicit = any(w in lower for w in ["remember", "don't forget", "important", "note this"])
            has_numbers = any(c.isdigit() for c in line)
            is_task = any(w in lower for w in ["created", "built", "finished", "completed", "done", "made"])
            
            if is_explicit or is_identity or is_credential:
                results.append(line)
            elif is_project or is_task:
                results.append(line)
            elif has_numbers and (is_credential or "@" in line or "/" in line):
                results.append(line)
        
        return results[:20]
    
    def _get_content(self, msg: Dict[str, Any]) -> str:
        content = msg.get("content", "")
        if isinstance(content, list):
            parts = []
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    parts.append(block.get("text", ""))
            return " ".join(parts)
        return content if isinstance(content, str) else ""
    
    def _format_messages(self, messages: List[Dict[str, Any]]) -> str:
        parts = []
        start_idx = max(0, len(messages) - 30)
        for i, msg in enumerate(messages[-30:]):
            actual_idx = start_idx + i
            role = msg.get("role", "user")
            content = self._get_content(msg)
            
            if content:
                truncated = content[:800] + "..." if len(content) > 800 else content
                parts.append(f"[{actual_idx}] {role.upper()}: {truncated}")
        
        return "\n\n".join(parts)
    
    def _get_cache_key(self, messages: List[Dict[str, Any]]) -> str:
        content_hash = hashlib.sha256(
            json.dumps(messages, sort_keys=True, default=str).encode()
        ).hexdigest()[:32]
        return f"ctx_summary_v2:{content_hash}"
    
    async def _get_cached(self, cache_key: str) -> Optional[Dict[str, Any]]:
        try:
            data = await Cache.get(cache_key)
            if isinstance(data, str):
                return json.loads(data)
            return data
        except Exception:
            return None
    
    async def _cache(self, cache_key: str, data: Dict[str, Any]):
        try:
            await Cache.set(cache_key, json.dumps(data), ttl=self.cache_ttl)
        except Exception as e:
            logger.debug(f"Failed to cache: {e}")
