from typing import List, Dict, Any, Optional, Union
from .types import (
    ContextChunk,
    LayersConfig,
    CompileResult,
    CompileRules,
)
from .sources.base import ContextSource
from .sources.thread import ThreadSource
from .sources.memory import MemorySource
from .budget import TokenBudget
from .compiler import ContextCompiler
from .processors import get_embeddings_batch
from core.utils.logger import logger


class ContextEngine:
    def __init__(
        self,
        sources: Optional[List[ContextSource]] = None,
        layers: Optional[Union[Dict[str, Any], LayersConfig]] = None,
        total_budget: int = 150_000,
        enable_embeddings: bool = True,
    ):
        self._sources: List[ContextSource] = sources or []
        self._enable_embeddings = enable_embeddings
        
        if isinstance(layers, dict):
            self._layers_config = LayersConfig.from_dict(layers)
        elif isinstance(layers, LayersConfig):
            self._layers_config = layers
        else:
            self._layers_config = LayersConfig()
        
        self._budget = TokenBudget(total_budget=total_budget)
        self._compiler = ContextCompiler(
            layers_config=self._layers_config,
            budget=self._budget,
        )
        
        self._ensure_thread_source()
    
    def _ensure_thread_source(self):
        has_thread = any(isinstance(s, ThreadSource) for s in self._sources)
        if not has_thread:
            self._sources.insert(0, ThreadSource())
    
    def add_source(self, source: ContextSource):
        self._sources.append(source)
    
    def remove_source(self, name: str):
        self._sources = [s for s in self._sources if s.name != name]
    
    def get_sources(self) -> List[str]:
        return [s.name for s in self._sources]
    
    async def compile(
        self,
        thread_id: str,
        account_id: str,
        system_prompt: Optional[Dict[str, Any]] = None,
        query: Optional[str] = None,
        rules: Optional[Union[Dict[str, Any], CompileRules]] = None,
    ) -> CompileResult:
        logger.info(f"[CONTEXT_ENGINE] Starting compilation for thread={thread_id}, account={account_id}, query={bool(query)}")
        
        if isinstance(rules, dict):
            rules = CompileRules(
                include_system_prompt=rules.get("include_system_prompt", True),
                include_recent_messages=rules.get("include_recent_messages", True),
                include_thread_memory=rules.get("include_thread_memory", True),
                time_decay=rules.get("time_decay", "14d"),
                relevance_threshold=rules.get("relevance_threshold", 0.3),
                deduplicate=rules.get("deduplicate", True),
                use_semantic_ranking=rules.get("use_semantic_ranking", True),
            )
        else:
            rules = rules or CompileRules()
        
        logger.debug(f"[CONTEXT_ENGINE] Compile rules: semantic={rules.use_semantic_ranking}, dedupe={rules.deduplicate}, threshold={rules.relevance_threshold}")
        
        allocations = self._budget.allocate_to_sources(
            self._sources,
            layer_requirements=self._compiler.get_layer_budgets(),
        )
        
        logger.debug(f"[CONTEXT_ENGINE] Budget allocations: {allocations.allocations}")
        
        all_chunks: List[ContextChunk] = []
        
        for source in self._sources:
            source_budget = allocations.allocations.get(source.name)
            
            try:
                chunks = await source.fetch(
                    thread_id=thread_id,
                    account_id=account_id,
                    query=query,
                    limit_tokens=source_budget,
                )
                
                all_chunks.extend(chunks)
                
                tokens_fetched = sum(c.tokens for c in chunks)
                self._budget.track_usage(source.name, tokens_fetched)
                
                logger.debug(f"Source '{source.name}' fetched {len(chunks)} chunks ({tokens_fetched} tokens)")
                
            except Exception as e:
                logger.error(f"Source '{source.name}' failed to fetch: {e}")
                continue
        
        logger.info(f"[CONTEXT_ENGINE] Fetched total {len(all_chunks)} chunks from {len(self._sources)} sources")
        
        if self._enable_embeddings and rules.use_semantic_ranking and query:
            logger.debug(f"[CONTEXT_ENGINE] Adding embeddings for semantic ranking")
            all_chunks = await self._add_embeddings(all_chunks)
            chunks_with_embeddings = sum(1 for c in all_chunks if c.embedding)
            logger.debug(f"[CONTEXT_ENGINE] {chunks_with_embeddings}/{len(all_chunks)} chunks now have embeddings")
        
        result = await self._compiler.compile(
            chunks=all_chunks,
            system_prompt=system_prompt,
            query=query,
            rules=rules,
        )
        
        self._budget.reset_usage()
        
        logger.info(f"[CONTEXT_ENGINE] Compilation complete: {result.summary()}")
        
        return result
    
    async def _add_embeddings(self, chunks: List[ContextChunk]) -> List[ContextChunk]:
        chunks_needing_embeddings = [
            (i, c) for i, c in enumerate(chunks)
            if c.embedding is None and c.content
        ]
        
        if not chunks_needing_embeddings:
            return chunks
        
        historical_start = max(0, len(chunks) - 200)
        to_embed = [
            (i, c) for i, c in chunks_needing_embeddings
            if i >= historical_start
        ]
        
        if not to_embed:
            return chunks
        
        texts = [c.content[:2000] for _, c in to_embed]
        
        try:
            embeddings = await get_embeddings_batch(texts)
            
            for j, (original_idx, chunk) in enumerate(to_embed):
                if j < len(embeddings) and embeddings[j]:
                    chunks[original_idx].embedding = embeddings[j]
        except Exception as e:
            logger.warning(f"Failed to generate embeddings: {e}")
        
        return chunks
    
    async def compile_for_llm(
        self,
        thread_id: str,
        account_id: str,
        system_prompt: Optional[Dict[str, Any]] = None,
        query: Optional[str] = None,
        rules: Optional[Union[Dict[str, Any], CompileRules]] = None,
    ) -> List[Dict[str, Any]]:
        result = await self.compile(
            thread_id=thread_id,
            account_id=account_id,
            system_prompt=system_prompt,
            query=query,
            rules=rules,
        )
        return result.get_prepared_messages()
    
    def get_budget_info(self) -> Dict[str, Any]:
        return {
            "total_budget": self._budget.total_budget,
            "available_budget": self._budget.available_budget,
            "reserve_tokens": self._budget.reserve_tokens,
            "layer_budgets": self._compiler.get_layer_budgets(),
            "total_capacity": self._compiler.get_total_capacity(),
        }
    
    def get_layers_config(self) -> LayersConfig:
        return self._layers_config
    
    def update_layers_config(self, config: Union[Dict[str, Any], LayersConfig]):
        if isinstance(config, dict):
            self._layers_config = LayersConfig.from_dict(config)
        else:
            self._layers_config = config
        
        self._compiler = ContextCompiler(
            layers_config=self._layers_config,
            budget=self._budget,
        )
    
    @classmethod
    def create_default(
        cls,
        include_memory: bool = True,
        total_budget: int = 150_000,
        enable_embeddings: bool = True,
    ) -> "ContextEngine":
        sources = [ThreadSource()]
        
        if include_memory:
            sources.append(MemorySource())
        
        return cls(
            sources=sources,
            total_budget=total_budget,
            enable_embeddings=enable_embeddings,
        )
    
    @classmethod
    def from_config(cls, config: Dict[str, Any]) -> "ContextEngine":
        sources = []
        
        for source_config in config.get("sources", []):
            source_type = source_config.get("type")
            
            if source_type == "thread":
                sources.append(ThreadSource(
                    priority=source_config.get("priority", 100)
                ))
            elif source_type == "memory":
                sources.append(MemorySource(
                    priority=source_config.get("priority", 90),
                    semantic_retrieval=source_config.get("semantic_retrieval", True),
                    similarity_threshold=source_config.get("similarity_threshold", 0.5),
                ))
        
        layers = config.get("layers")
        if layers:
            layers = LayersConfig.from_dict(layers)
        
        return cls(
            sources=sources,
            layers=layers,
            total_budget=config.get("total_budget", 150_000),
            enable_embeddings=config.get("enable_embeddings", True),
        )
