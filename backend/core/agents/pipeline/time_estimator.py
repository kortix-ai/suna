import time
from typing import Dict, Optional, Tuple
from dataclasses import dataclass, field

from core.utils.logger import logger


@dataclass
class EstimateBreakdown:
    prep_seconds: float = 0.5
    llm_seconds: float = 3.0
    tool_seconds: float = 0.0
    
    @property
    def total(self) -> float:
        return self.prep_seconds + self.llm_seconds + self.tool_seconds
    
    def to_dict(self) -> Dict[str, float]:
        return {
            "prep": round(self.prep_seconds, 1),
            "llm": round(self.llm_seconds, 1),
            "tools": round(self.tool_seconds, 1)
        }


@dataclass
class EstimateResult:
    estimated_seconds: float
    confidence: str
    breakdown: EstimateBreakdown
    
    def to_dict(self) -> Dict:
        return {
            "estimated_seconds": round(self.estimated_seconds, 1),
            "confidence": self.confidence,
            "breakdown": self.breakdown.to_dict()
        }


class TimeEstimator:
    BASE_PREP_TIME = 0.5
    BASE_LLM_TIME = 3.0
    
    MODEL_MULTIPLIERS = {
        "claude-3-5-sonnet": 1.0,
        "claude-3-opus": 1.5,
        "claude-3-haiku": 0.6,
        "gpt-4o": 1.0,
        "gpt-4o-mini": 0.7,
        "gpt-4-turbo": 1.3,
        "o1": 2.0,
        "o1-mini": 1.5,
        "o1-preview": 2.5,
        "o3-mini": 1.8,
        "gemini-2.0-flash": 0.8,
        "gemini-1.5-pro": 1.2,
        "deepseek-chat": 0.9,
        "deepseek-reasoner": 1.8,
    }
    
    TOOL_TIME_ESTIMATES = {
        "sb_shell_tool": 2.0,
        "sb_files_tool": 1.0,
        "browser_tool": 5.0,
        "web_search_tool": 2.0,
        "image_search_tool": 2.0,
        "sb_vision_tool": 3.0,
        "sb_presentation_tool": 4.0,
        "sb_image_edit_tool": 5.0,
        "sb_kb_tool": 2.0,
        "people_search_tool": 3.0,
        "company_search_tool": 3.0,
        "apify_tool": 10.0,
        "paper_search_tool": 3.0,
    }
    
    CONFIDENCE_THRESHOLDS = {
        "high": 0.2,
        "medium": 0.4,
        "low": 0.6
    }
    
    def __init__(self):
        self._history: Dict[str, list] = {}
        self._max_history = 100
    
    def estimate(
        self,
        model_name: str,
        message_count: int = 0,
        has_mcp: bool = False,
        enabled_tools: Optional[list] = None,
        is_continuation: bool = False
    ) -> EstimateResult:
        breakdown = EstimateBreakdown()
        
        if is_continuation:
            breakdown.prep_seconds = 0.1
        else:
            breakdown.prep_seconds = self.BASE_PREP_TIME
            if has_mcp:
                breakdown.prep_seconds += 0.5
        
        model_key = self._normalize_model_name(model_name)
        multiplier = self.MODEL_MULTIPLIERS.get(model_key, 1.0)
        
        breakdown.llm_seconds = self.BASE_LLM_TIME * multiplier
        
        if message_count > 50:
            breakdown.llm_seconds *= 1.2
        elif message_count > 100:
            breakdown.llm_seconds *= 1.5
        
        if enabled_tools:
            avg_tool_time = sum(
                self.TOOL_TIME_ESTIMATES.get(t, 1.5) 
                for t in enabled_tools[:5]
            ) / max(len(enabled_tools[:5]), 1)
            breakdown.tool_seconds = avg_tool_time * 0.3
        
        confidence = self._calculate_confidence(model_key, is_continuation)
        
        return EstimateResult(
            estimated_seconds=breakdown.total,
            confidence=confidence,
            breakdown=breakdown
        )
    
    def record_actual(
        self,
        model_name: str,
        actual_seconds: float,
        was_continuation: bool = False
    ) -> None:
        key = f"{self._normalize_model_name(model_name)}:{'cont' if was_continuation else 'new'}"
        
        if key not in self._history:
            self._history[key] = []
        
        self._history[key].append(actual_seconds)
        
        if len(self._history[key]) > self._max_history:
            self._history[key] = self._history[key][-self._max_history:]
    
    def get_historical_average(
        self,
        model_name: str,
        is_continuation: bool = False
    ) -> Optional[float]:
        key = f"{self._normalize_model_name(model_name)}:{'cont' if is_continuation else 'new'}"
        
        history = self._history.get(key, [])
        if not history:
            return None
        
        return sum(history) / len(history)
    
    def _normalize_model_name(self, model_name: str) -> str:
        name = model_name.lower()
        
        for key in self.MODEL_MULTIPLIERS:
            if key in name:
                return key
        
        if "claude" in name:
            return "claude-3-5-sonnet"
        if "gpt-4" in name:
            return "gpt-4o"
        if "gemini" in name:
            return "gemini-2.0-flash"
        if "deepseek" in name:
            return "deepseek-chat"
        
        return "gpt-4o"
    
    def _calculate_confidence(
        self,
        model_key: str,
        is_continuation: bool
    ) -> str:
        history_key = f"{model_key}:{'cont' if is_continuation else 'new'}"
        history = self._history.get(history_key, [])
        
        if len(history) < 5:
            return "low"
        
        if len(history) < 20:
            return "medium"
        
        avg = sum(history) / len(history)
        variance = sum((x - avg) ** 2 for x in history) / len(history)
        std_dev = variance ** 0.5
        cv = std_dev / avg if avg > 0 else 1.0
        
        if cv < self.CONFIDENCE_THRESHOLDS["high"]:
            return "high"
        elif cv < self.CONFIDENCE_THRESHOLDS["medium"]:
            return "medium"
        else:
            return "low"


time_estimator = TimeEstimator()
