from typing import Dict, List, Any, Optional, TYPE_CHECKING
from dataclasses import dataclass, field
from core.utils.logger import logger

if TYPE_CHECKING:
    from .sources.base import ContextSource


@dataclass
class AllocationResult:
    allocations: Dict[str, int]
    layer_budgets: Dict[str, int]
    total_allocated: int
    reserve: int


class TokenBudget:
    def __init__(
        self,
        total_budget: int = 150_000,
        reserve_ratio: float = 0.1,
        min_source_tokens: int = 1000,
    ):
        self.total_budget = total_budget
        self.reserve_ratio = reserve_ratio
        self.min_source_tokens = min_source_tokens
        self._usage: Dict[str, int] = {}
        
    @property
    def available_budget(self) -> int:
        reserve = int(self.total_budget * self.reserve_ratio)
        return self.total_budget - reserve
    
    @property
    def reserve_tokens(self) -> int:
        return int(self.total_budget * self.reserve_ratio)
    
    def allocate_to_sources(
        self,
        sources: List["ContextSource"],
        layer_requirements: Optional[Dict[str, int]] = None,
    ) -> AllocationResult:
        if not sources:
            return AllocationResult(
                allocations={},
                layer_budgets=layer_requirements or {},
                total_allocated=0,
                reserve=self.reserve_tokens,
            )
        
        available = self.available_budget
        
        if layer_requirements:
            layer_total = sum(layer_requirements.values())
            if layer_total > available:
                scale = available / layer_total
                layer_requirements = {
                    k: int(v * scale) for k, v in layer_requirements.items()
                }
        
        total_priority = sum(s.get_priority() for s in sources)
        if total_priority == 0:
            total_priority = len(sources)
        
        allocations = {}
        for source in sources:
            priority = source.get_priority()
            if total_priority > 0:
                weight = priority / total_priority
            else:
                weight = 1.0 / len(sources)
            
            allocation = max(
                self.min_source_tokens,
                int(available * weight)
            )
            allocations[source.name] = allocation
        
        total_allocated = sum(allocations.values())
        if total_allocated > available:
            scale = available / total_allocated
            allocations = {k: int(v * scale) for k, v in allocations.items()}
            total_allocated = sum(allocations.values())
        
        logger.debug(f"Budget allocation: {allocations} (total: {total_allocated}/{available})")
        
        return AllocationResult(
            allocations=allocations,
            layer_budgets=layer_requirements or {},
            total_allocated=total_allocated,
            reserve=self.reserve_tokens,
        )
    
    def allocate_to_layers(
        self,
        layer_configs: Dict[str, int],
        available_tokens: Optional[int] = None,
    ) -> Dict[str, int]:
        available = available_tokens or self.available_budget
        requested_total = sum(layer_configs.values())
        
        if requested_total <= available:
            return layer_configs
        
        scale = available / requested_total
        scaled = {k: int(v * scale) for k, v in layer_configs.items()}
        
        remainder = available - sum(scaled.values())
        if remainder > 0:
            sorted_layers = sorted(scaled.keys(), key=lambda k: layer_configs[k], reverse=True)
            for layer in sorted_layers:
                if remainder <= 0:
                    break
                scaled[layer] += 1
                remainder -= 1
        
        return scaled
    
    def rebalance(
        self,
        used: Dict[str, int],
        allocated: Dict[str, int],
    ) -> Dict[str, int]:
        unused_total = 0
        sources_needing_more = []
        
        for source, allocation in allocated.items():
            actual_usage = used.get(source, 0)
            if actual_usage < allocation:
                unused_total += allocation - actual_usage
            elif actual_usage >= allocation:
                sources_needing_more.append(source)
        
        if not sources_needing_more or unused_total == 0:
            return allocated
        
        rebalanced = allocated.copy()
        extra_per_source = unused_total // len(sources_needing_more)
        
        for source in sources_needing_more:
            rebalanced[source] += extra_per_source
        
        for source, allocation in allocated.items():
            actual_usage = used.get(source, 0)
            if actual_usage < allocation:
                rebalanced[source] = actual_usage
        
        logger.debug(f"Rebalanced budget: {allocated} -> {rebalanced}")
        return rebalanced
    
    def track_usage(self, source: str, tokens: int):
        self._usage[source] = self._usage.get(source, 0) + tokens
    
    def get_usage(self) -> Dict[str, int]:
        return self._usage.copy()
    
    def reset_usage(self):
        self._usage = {}
    
    def remaining(self, source: str, allocated: int) -> int:
        used = self._usage.get(source, 0)
        return max(0, allocated - used)
    
    def is_over_budget(self) -> bool:
        total_used = sum(self._usage.values())
        return total_used > self.total_budget
    
    def get_overage(self) -> int:
        total_used = sum(self._usage.values())
        return max(0, total_used - self.total_budget)
