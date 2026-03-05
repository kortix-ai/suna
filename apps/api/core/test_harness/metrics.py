"""
Metrics Collection and Storage for E2E Benchmark Testing

Handles:
- Creating benchmark run records
- Recording individual prompt results
- Calculating aggregated statistics
- Finalizing runs with summary data
"""

import uuid
from datetime import datetime, timezone
from typing import Dict, Any, List, Optional
from dataclasses import dataclass, asdict
from core.services.convex_client import get_convex_client
from core.utils.logger import logger


@dataclass
class BenchmarkResult:
    """Result of a single test prompt execution"""
    prompt_id: str
    prompt_text: str
    thread_id: Optional[str]
    agent_run_id: Optional[str]
    started_at: datetime
    completed_at: Optional[datetime]
    cold_start_time_ms: Optional[int]
    total_duration_ms: Optional[int]
    tool_calls_count: int
    tool_calls: List[Dict[str, Any]]
    tool_call_breakdown: Dict[str, int]  # Count of each tool called
    expected_tools_present: bool  # Were all expected tools called?
    missing_tools: List[str]  # List of expected tools that weren't called
    avg_tool_call_time_ms: Optional[float]
    slowest_tool_call: Optional[Dict[str, Any]]
    stream_chunk_count: int
    avg_chunk_interval_ms: Optional[float]
    status: str  # 'completed', 'failed', 'timeout', 'error'
    error_message: Optional[str]
    metadata: Dict[str, Any]


class MetricsCollector:
    """Collects and stores benchmark metrics using Convex"""
    
    def __init__(self):
        self.convex = get_convex_client()
        self._initialized = False
    
    async def initialize(self):
        """Initialize database connection"""
        if not self._initialized:
            # Convex client is a singleton, no need to initialize
            self._initialized = True
    
    async def start_run(
        self,
        run_type: str,
        model_name: str,
        concurrency_level: int,
        total_prompts: int,
        metadata: Optional[Dict[str, Any]] = None,
        created_by: Optional[str] = None
    ) -> str:
        """
        Create a new benchmark run record
        
        Args:
            run_type: 'core_test' or 'stress_test'
            model_name: Model being tested (e.g., 'kortix/basic')
            concurrency_level: Number of concurrent requests
            total_prompts: Total number of prompts to execute
            metadata: Additional metadata (git commit, branch, etc.)
            created_by: User ID who initiated the test
        
        Returns:
            run_id: UUID of the created benchmark run
        """
        await self.initialize()
        
        # TODO: Migrate to Convex - need benchmark_runs table endpoints
        # Old Supabase code inserted into benchmark_runs table
        # Need to add benchmark run endpoints to Convex http.ts
        run_id = str(uuid.uuid4())
        
        logger.info(f"Created benchmark run: {run_id} (type: {run_type}, model: {model_name}, concurrency: {concurrency_level})")
        logger.warning("Benchmark runs storage needs Convex endpoint - using in-memory tracking only")
        
        return run_id
    
    async def record_prompt_result(
        self,
        run_id: str,
        result: BenchmarkResult
    ):
        """
        Record the result of a single prompt execution
        
        Args:
            run_id: UUID of the benchmark run
            result: BenchmarkResult object with metrics
        """
        await self.initialize()
        
        # TODO: Migrate to Convex - need benchmark_results table endpoints
        # Old Supabase code inserted into benchmark_results table
        # Need to add benchmark results endpoints to Convex http.ts
        logger.debug(f"Recorded result for prompt {result.prompt_id} in run {run_id}: {result.status}")
    
    async def finalize_run(
        self,
        run_id: str,
        status: str = 'completed'
    ):
        """
        Finalize a benchmark run and calculate summary statistics
        
        Args:
            run_id: UUID of the benchmark run
            status: Final status ('completed', 'failed', 'cancelled')
        """
        await self.initialize()
        
        # TODO: Migrate to Convex - need benchmark_runs update endpoint
        # Old Supabase code updated benchmark_runs table with completion data
        logger.info(f"Finalized benchmark run {run_id}: {status}")
    
    async def get_run_summary(self, run_id: str) -> Dict[str, Any]:
        """
        Get summary statistics for a benchmark run
        
        Args:
            run_id: UUID of the benchmark run
        
        Returns:
            Dictionary with run metadata and aggregated statistics
        """
        await self.initialize()
        
        # TODO: Migrate to Convex - need benchmark_runs and benchmark_results endpoints
        # Old Supabase code queried both tables for summary data
        logger.warning(f"get_run_summary needs Convex benchmark endpoints for run {run_id}")
        
        return {
            'run_id': run_id,
            'status': 'unknown',
            'run_type': 'unknown',
            'model_name': 'unknown',
            'concurrency_level': 0,
            'total_prompts': 0,
            'started_at': None,
            'completed_at': None,
            'duration_ms': None,
            'metadata': {},
            'summary': {
                'total_prompts': 0,
                'successful': 0,
                'failed': 0,
            },
            'results': []
        }
    
    async def list_runs(
        self,
        limit: int = 20,
        run_type: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """
        List recent benchmark runs
        
        Args:
            limit: Maximum number of runs to return
            run_type: Filter by run type ('core_test' or 'stress_test')
        
        Returns:
            List of benchmark run records
        """
        await self.initialize()
        
        # TODO: Migrate to Convex - need benchmark_runs list endpoint
        # Old Supabase code queried benchmark_runs table with order/limit
        logger.warning("list_runs needs Convex benchmark endpoints")
        
        return []
    
    def _calculate_tool_deviations(
        self,
        tool_call_breakdown: Dict[str, int],
        expected_tool_calls: Dict[str, int]
    ) -> Dict[str, Dict[str, int]]:
        """
        Calculate deviations between expected and actual tool calls
        
        Args:
            tool_call_breakdown: Actual tool call counts
            expected_tool_calls: Expected tool call counts
        
        Returns:
            Dict with deviation data per tool
        """
        deviations = {}
        for tool_name, expected_count in expected_tool_calls.items():
            actual_count = tool_call_breakdown.get(tool_name, 0)
            deviations[tool_name] = {
                "expected": expected_count,
                "actual": actual_count,
                "deviation": actual_count - expected_count
            }
        return deviations
    
    async def cancel_run(self, run_id: str):
        """
        Cancel a running benchmark test
        
        Args:
            run_id: UUID of the benchmark run
        """
        await self.finalize_run(run_id, status='cancelled')

