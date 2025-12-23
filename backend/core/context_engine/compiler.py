from typing import List, Dict, Any, Optional
import uuid
from .types import (
    ContextChunk,
    LayersConfig,
    LayerType,
    CompileResult,
    CompileRules,
    ToolCallGroup,
    ImportanceLevel,
)
from .layers import (
    ContextLayer,
    WorkingLayer,
    RecentLayer,
    HistoricalLayer,
    ArchivedLayer,
)
from .processors import SemanticRanker, HybridSummarizer, Compressor, get_embedding
from .processors.importance import ImportanceMarker
from .budget import TokenBudget
from .utils.tokens import count_tokens
from core.utils.logger import logger


class ContextCompiler:
    def __init__(
        self,
        layers_config: Optional[LayersConfig] = None,
        budget: Optional[TokenBudget] = None,
    ):
        self.layers_config = layers_config or LayersConfig()
        self.budget = budget or TokenBudget()
        
        self.ranker = SemanticRanker()
        self.summarizer = HybridSummarizer()
        self.compressor = Compressor()
        self.importance_marker = ImportanceMarker()
        
        self._layers: Dict[LayerType, ContextLayer] = {}
        self._init_layers()
    
    def _init_layers(self):
        self._layers = {
            LayerType.WORKING: WorkingLayer(self.layers_config.working),
            LayerType.RECENT: RecentLayer(self.layers_config.recent),
            LayerType.HISTORICAL: HistoricalLayer(self.layers_config.historical),
            LayerType.ARCHIVED: ArchivedLayer(self.layers_config.archived),
        }
    
    async def compile(
        self,
        chunks: List[ContextChunk],
        system_prompt: Optional[Dict[str, Any]] = None,
        query: Optional[str] = None,
        rules: Optional[CompileRules] = None,
    ) -> CompileResult:
        rules = rules or CompileRules()
        
        for layer in self._layers.values():
            layer.clear()
        self.summarizer.reset_call_counter()
        
        chunks = self.importance_marker.mark(chunks)
        
        if rules.use_semantic_ranking and query:
            query_embedding = await get_embedding(query)
            self.ranker.set_query_embedding(query_embedding)
        else:
            self.ranker.set_query_embedding(None)
        
        sorted_chunks = self._sort_by_recency(chunks)
        
        if rules.deduplicate:
            sorted_chunks = self._deduplicate(sorted_chunks)
        
        sorted_chunks = self._group_tool_calls(sorted_chunks)
        
        layer_assignments = self._assign_to_layers(sorted_chunks)
        
        chunks_by_layer: Dict[LayerType, List[ContextChunk]] = {}
        
        for layer_type in [LayerType.WORKING, LayerType.RECENT, LayerType.HISTORICAL, LayerType.ARCHIVED]:
            layer = self._layers[layer_type]
            assigned_chunks = layer_assignments.get(layer_type, [])
            
            if layer_type == LayerType.HISTORICAL and len(assigned_chunks) > 0:
                layer_budget = self.layers_config.historical.tokens
                total_tokens = sum(c.tokens for c in assigned_chunks)
                
                if total_tokens > layer_budget:
                    assigned_chunks = self.ranker.select_optimal(assigned_chunks, layer_budget)
                    logger.debug(f"Optimal selection: {len(assigned_chunks)} chunks for historical layer")
            
            processed = await layer.process(
                assigned_chunks,
                compressor=self.compressor,
                summarizer=self.summarizer if layer_type in [LayerType.HISTORICAL, LayerType.ARCHIVED] else None,
            )
            
            chunks_by_layer[layer_type] = processed
        
        messages = self._assemble_messages(chunks_by_layer)
        
        preserved_facts = self.summarizer.get_preserved_facts_context()
        if preserved_facts:
            facts_message = {
                "role": "system",
                "content": f"[PRESERVED FACTS - Never forget this information]\n{preserved_facts}",
            }
            messages.insert(0, facts_message)
            logger.info(f"Injected {self.summarizer.fact_store.count} preserved facts into context")
        
        total_tokens = sum(layer.token_count for layer in self._layers.values())
        if preserved_facts:
            total_tokens += count_tokens(preserved_facts)
        
        layer_stats = {
            layer_type.value: layer.get_stats()
            for layer_type, layer in self._layers.items()
        }
        
        sources_used = self._count_sources(chunks_by_layer)
        
        compression_stats = {
            "llm_summarizations": self.summarizer._llm_calls_made,
            "chunks_compressed": sum(
                1 for layer_chunks in chunks_by_layer.values()
                for chunk in layer_chunks
                if chunk.metadata.get("compressed")
            ),
            "facts_preserved": self.summarizer.fact_store.count,
        }
        
        logger.info(
            f"Context compiled: {total_tokens} tokens, "
            f"{len(messages)} messages across {len(chunks_by_layer)} layers, "
            f"{self.summarizer.fact_store.count} facts preserved"
        )
        
        return CompileResult(
            messages=messages,
            system_prompt=system_prompt,
            token_count=total_tokens,
            layer_stats=layer_stats,
            sources_used=sources_used,
            chunks_by_layer=chunks_by_layer,
            compression_stats=compression_stats,
        )
    
    def _sort_by_recency(self, chunks: List[ContextChunk]) -> List[ContextChunk]:
        def get_sort_key(chunk: ContextChunk):
            if chunk.created_at:
                return chunk.created_at.timestamp()
            return 0
        
        return sorted(chunks, key=get_sort_key)
    
    def _deduplicate(self, chunks: List[ContextChunk]) -> List[ContextChunk]:
        seen_ids = set()
        unique_chunks = []
        
        for chunk in chunks:
            if chunk.message_id:
                if chunk.message_id in seen_ids:
                    continue
                seen_ids.add(chunk.message_id)
            unique_chunks.append(chunk)
        
        return unique_chunks
    
    def _group_tool_calls(self, chunks: List[ContextChunk]) -> List[ContextChunk]:
        result = []
        pending_tool_calls: Dict[str, ToolCallGroup] = {}
        
        for chunk in chunks:
            tool_calls = chunk.metadata.get("tool_calls")
            tool_call_id = chunk.get_tool_call_id()
            
            if tool_calls and isinstance(tool_calls, list):
                group_id = str(uuid.uuid4())[:8]
                chunk.tool_call_group_id = group_id
                
                expected_ids = {
                    tc.get("id") for tc in tool_calls
                    if isinstance(tc, dict) and tc.get("id")
                }
                
                pending_tool_calls[group_id] = ToolCallGroup(
                    assistant_chunk=chunk,
                    tool_chunks=[],
                    group_id=group_id,
                )
                
                for tc_id in expected_ids:
                    pending_tool_calls[tc_id] = pending_tool_calls[group_id]
                
            elif tool_call_id and tool_call_id in pending_tool_calls:
                group = pending_tool_calls[tool_call_id]
                chunk.tool_call_group_id = group.group_id
                group.tool_chunks.append(chunk)
                
                if group.is_complete():
                    result.extend(group.all_chunks)
                    for tc in group.assistant_chunk.metadata.get("tool_calls", []):
                        if isinstance(tc, dict) and tc.get("id"):
                            pending_tool_calls.pop(tc.get("id"), None)
                    pending_tool_calls.pop(group.group_id, None)
            else:
                result.append(chunk)
        
        for group_id, group in list(pending_tool_calls.items()):
            if group_id == group.group_id:
                result.extend(group.all_chunks)
        
        return result
    
    def _assign_to_layers(
        self,
        chunks: List[ContextChunk],
    ) -> Dict[LayerType, List[ContextChunk]]:
        if not chunks:
            return {layer_type: [] for layer_type in LayerType}
        
        assignments: Dict[LayerType, List[ContextChunk]] = {
            layer_type: [] for layer_type in LayerType
        }
        
        pinned = [c for c in chunks if c.is_pinned()]
        non_pinned = [c for c in chunks if not c.is_pinned()]
        
        working_config = self.layers_config.working
        recent_config = self.layers_config.recent
        historical_config = self.layers_config.historical
        
        working_count = working_config.messages or 10
        recent_count = recent_config.messages or 30
        historical_count = historical_config.messages or 100
        
        total = len(non_pinned)
        
        if total <= working_count:
            assignments[LayerType.WORKING] = non_pinned
        elif total <= working_count + recent_count:
            assignments[LayerType.WORKING] = non_pinned[-working_count:]
            assignments[LayerType.RECENT] = non_pinned[:-working_count]
        elif total <= working_count + recent_count + historical_count:
            assignments[LayerType.WORKING] = non_pinned[-working_count:]
            recent_start = total - working_count - recent_count
            assignments[LayerType.RECENT] = non_pinned[recent_start:-working_count]
            assignments[LayerType.HISTORICAL] = non_pinned[:recent_start]
        else:
            assignments[LayerType.WORKING] = non_pinned[-working_count:]
            recent_start = total - working_count - recent_count
            assignments[LayerType.RECENT] = non_pinned[recent_start:-working_count]
            historical_start = recent_start - historical_count
            assignments[LayerType.HISTORICAL] = non_pinned[historical_start:recent_start]
            assignments[LayerType.ARCHIVED] = non_pinned[:historical_start]
        
        for chunk in pinned:
            assignments[LayerType.WORKING].insert(0, chunk)
        
        for layer_type, layer_chunks in assignments.items():
            logger.debug(f"Layer {layer_type.value}: {len(layer_chunks)} chunks assigned")
        
        return assignments
    
    def _assemble_messages(
        self,
        chunks_by_layer: Dict[LayerType, List[ContextChunk]],
    ) -> List[Dict[str, Any]]:
        messages = []
        
        for layer_type in [LayerType.ARCHIVED, LayerType.HISTORICAL, LayerType.RECENT, LayerType.WORKING]:
            layer_chunks = chunks_by_layer.get(layer_type, [])
            for chunk in layer_chunks:
                messages.append(chunk.to_message())
        
        return messages
    
    def _count_sources(
        self,
        chunks_by_layer: Dict[LayerType, List[ContextChunk]],
    ) -> Dict[str, int]:
        sources: Dict[str, int] = {}
        
        for layer_chunks in chunks_by_layer.values():
            for chunk in layer_chunks:
                source = chunk.source
                sources[source] = sources.get(source, 0) + chunk.tokens
        
        return sources
    
    def get_layer_budgets(self) -> Dict[str, int]:
        return {
            layer_type.value: self.layers_config.get_layer(layer_type).tokens
            for layer_type in LayerType
        }
    
    def get_total_capacity(self) -> int:
        return self.layers_config.total_tokens()
