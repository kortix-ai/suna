"""
Admin API Endpoints for Test Harness

Provides secure endpoints for:
- Starting benchmark tests (core and stress modes)
- Retrieving test results
- Listing previous runs
- Cancelling active tests
"""

import asyncio
from typing import Optional, List
from fastapi import APIRouter, HTTPException, Depends, Query
from pydantic import BaseModel, Field
from core.utils.auth_utils import verify_admin_api_key
from core.utils.logger import logger

from .runner import TestHarnessRunner
from .metrics import MetricsCollector


router = APIRouter(prefix="/admin/test-harness", tags=["admin-test-harness"])

e2e_router = APIRouter(prefix="/admin/tests", tags=["admin-e2e-tests"])


# Pydantic models for request/response
class StartTestRequest(BaseModel):
    """Request model for starting a benchmark test"""
    mode: str = Field(..., description="Test mode: 'core_test' or 'stress_test'")
    prompt_ids: Optional[List[str]] = Field(None, description="List of prompt IDs to test (None = all)")
    concurrency: int = Field(1, description="Number of concurrent requests", ge=1, le=100)
    model: str = Field("kortix/basic", description="Model to use (core_test only)")
    num_executions: int = Field(100, description="Number of executions (stress_test only)", ge=1, le=10000)
    cleanup_threads: bool = Field(True, description="Delete test threads after completion")
    metadata: Optional[dict] = Field(None, description="Additional metadata")


class StartTestResponse(BaseModel):
    """Response model for test start"""
    run_id: str
    status: str
    message: str


class RunSummaryResponse(BaseModel):
    """Response model for run summary"""
    run_id: str
    status: str
    run_type: str
    model_name: str
    concurrency_level: int
    total_prompts: int
    started_at: str
    completed_at: Optional[str]
    duration_ms: Optional[int]
    metadata: dict
    summary: dict
    results: List[dict]


class RunListResponse(BaseModel):
    """Response model for listing runs"""
    runs: List[dict]
    total: int


# Global runner instance
_runner_instance: Optional[TestHarnessRunner] = None
_background_tasks = {}


def get_runner(cleanup_threads: bool = True) -> TestHarnessRunner:
    """Get or create global runner instance"""
    global _runner_instance
    if _runner_instance is None:
        _runner_instance = TestHarnessRunner(cleanup_threads=cleanup_threads)
    return _runner_instance


@router.post("/run", response_model=StartTestResponse, summary="Start Benchmark Test")
async def start_benchmark_test(
    request: StartTestRequest,
    _: bool = Depends(verify_admin_api_key)
):
    """
    Start a new benchmark test run
    
    Requires X-Admin-Api-Key header for authentication.
    
    - **core_test**: Real LLM calls with full metrics tracking
    - **stress_test**: Mocked LLM for high-concurrency validation
    """
    runner = get_runner(cleanup_threads=request.cleanup_threads)
    
    # Validate mode
    if request.mode not in ['core_test', 'stress_test']:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid mode: {request.mode}. Must be 'core_test' or 'stress_test'"
        )
    
    # Validate prompt IDs if provided
    if request.prompt_ids:
        from .prompts import get_prompt
        invalid_prompts = [pid for pid in request.prompt_ids if not get_prompt(pid)]
        if invalid_prompts:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid prompt IDs: {invalid_prompts}"
            )
    
    logger.info(f"Starting {request.mode} test: concurrency={request.concurrency}, prompts={request.prompt_ids or 'all'}")
    
    try:
        # Start test - it returns run_id immediately after creating DB record
        logger.info(f"Starting {request.mode} with prompts: {request.prompt_ids or 'all'}, cleanup: {request.cleanup_threads}")
        
        # Start test and get run_id immediately
        if request.mode == 'core_test':
            run_id = await runner.run_core_test(
                prompt_ids=request.prompt_ids,
                concurrency=request.concurrency,
                model=request.model,
                metadata=request.metadata
            )
        else:  # stress_test
            run_id = await runner.run_stress_test(
                prompt_ids=request.prompt_ids,
                concurrency=request.concurrency,
                num_executions=request.num_executions,
                metadata=request.metadata
            )
        
        return StartTestResponse(
            run_id=run_id,
            status="running",
            message="Test started successfully"
        )
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error starting benchmark test: {e}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Failed to start test: {str(e)}"
        )


@router.get("/runs/{run_id}", response_model=RunSummaryResponse, summary="Get Test Run Results")
async def get_test_run(
    run_id: str,
    _: bool = Depends(verify_admin_api_key)
):
    """
    Get detailed results and summary for a benchmark test run
    
    Requires X-Admin-Api-Key header for authentication.
    """
    metrics = MetricsCollector()
    
    try:
        summary = await metrics.get_run_summary(run_id)
        return RunSummaryResponse(**summary)
    
    except Exception as e:
        logger.error(f"Error retrieving test run {run_id}: {e}", exc_info=True)
        
        if "not found" in str(e).lower():
            raise HTTPException(
                status_code=404,
                detail=f"Test run {run_id} not found"
            )
        
        raise HTTPException(
            status_code=500,
            detail=f"Failed to retrieve test run: {str(e)}"
        )


@router.get("/runs", response_model=RunListResponse, summary="List Test Runs")
async def list_test_runs(
    limit: int = Query(20, description="Maximum number of runs to return", ge=1, le=100),
    run_type: Optional[str] = Query(None, description="Filter by run type: 'core_test' or 'stress_test'"),
    _: bool = Depends(verify_admin_api_key)
):
    """
    List recent benchmark test runs
    
    Requires X-Admin-Api-Key header for authentication.
    """
    metrics = MetricsCollector()
    
    # Validate run_type if provided
    if run_type and run_type not in ['core_test', 'stress_test']:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid run_type: {run_type}. Must be 'core_test' or 'stress_test'"
        )
    
    try:
        runs = await metrics.list_runs(limit=limit, run_type=run_type)
        
        return RunListResponse(
            runs=runs,
            total=len(runs)
        )
    
    except Exception as e:
        logger.error(f"Error listing test runs: {e}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Failed to list test runs: {str(e)}"
        )


@router.post("/runs/{run_id}/cancel", summary="Cancel Test Run")
async def cancel_test_run(
    run_id: str,
    _: bool = Depends(verify_admin_api_key)
):
    """
    Cancel an active benchmark test run
    
    Requires X-Admin-Api-Key header for authentication.
    """
    runner = get_runner()
    
    try:
        await runner.cancel_run(run_id)
        
        # Cancel background task if exists
        if run_id in _background_tasks:
            task = _background_tasks[run_id]
            if not task.done():
                task.cancel()
            _background_tasks.pop(run_id)
        
        return {
            "run_id": run_id,
            "status": "cancelled",
            "message": "Test run cancelled successfully"
        }
    
    except Exception as e:
        logger.error(f"Error cancelling test run {run_id}: {e}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Failed to cancel test run: {str(e)}"
        )


@router.post("/emergency-stop", summary="Emergency Stop All Tests")
async def emergency_stop_all_tests(
    _: bool = Depends(verify_admin_api_key)
):
    """
    🚨 EMERGENCY STOP - Cancel ALL active benchmark test runs
    
    Use this in case of emergency to stop all running tests immediately.
    
    Requires X-Admin-Api-Key header for authentication.
    """
    runner = get_runner()
    
    try:
        # Get all active run IDs
        active_runs = list(runner._active_runs.keys())
        
        if not active_runs:
            return {
                "message": "No active test runs to stop",
                "cancelled_count": 0
            }
        
        logger.warning(f"🚨 EMERGENCY STOP triggered for {len(active_runs)} active runs")
        
        # Cancel all active runs
        cancelled = []
        errors = []
        
        for run_id in active_runs:
            try:
                await runner.cancel_run(run_id)
                cancelled.append(run_id)
                
                # Cancel background task if exists
                if run_id in _background_tasks:
                    task = _background_tasks[run_id]
                    if not task.done():
                        task.cancel()
                    _background_tasks.pop(run_id)
            
            except Exception as e:
                logger.error(f"Failed to cancel run {run_id}: {e}")
                errors.append({"run_id": run_id, "error": str(e)})
        
        return {
            "message": f"Emergency stop completed - cancelled {len(cancelled)} test runs",
            "cancelled_count": len(cancelled),
            "cancelled_runs": cancelled,
            "errors": errors if errors else None
        }
    
    except Exception as e:
        logger.error(f"Error during emergency stop: {e}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Emergency stop failed: {str(e)}"
        )


@router.get("/prompts", summary="List Available Test Prompts")
async def list_test_prompts(
    _: bool = Depends(verify_admin_api_key)
):
    """
    List all available test prompts
    
    Requires X-Admin-Api-Key header for authentication.
    """
    from .prompts import TEST_PROMPTS
    
    prompts = [
        {
            'id': p.id,
            'text': p.text,
            'category': p.category,
            'expected_tools': p.expected_tools,
            'min_tool_calls': p.min_tool_calls,
            'max_duration_ms': p.max_duration_ms,
            'description': p.description,
        }
        for p in TEST_PROMPTS
    ]
    
    return {
        'prompts': prompts,
        'total': len(prompts)
    }


@e2e_router.post("/e2e", summary="Run E2E API Tests")
async def run_e2e_tests(
    test_filter: Optional[str] = Query(None, description="pytest filter expression (e.g., 'test_agents' or 'test_accounts::test_get_accounts')"),
    _: bool = Depends(verify_admin_api_key)
):
    """
    Trigger pytest E2E API test suite.
    
    Runs the functional E2E tests from backend/tests/ directory.
    Requires X-Admin-Api-Key header for authentication.
    
    Args:
        test_filter: Optional pytest filter expression to run specific tests.
                    Examples:
                    - "test_agents" - run all agent tests
                    - "test_accounts::test_get_accounts" - run specific test
                    - "test_full_flow" - run E2E flow tests
    
    Returns:
        Test execution results with status, returncode, stdout, and stderr
    """
    import subprocess
    import os
    from pathlib import Path
    
    # Get backend directory path
    backend_dir = Path(__file__).parent.parent.parent
    
    # Build pytest command
    cmd = ["python", "-m", "pytest", "tests/", "-v", "--tb=short"]
    
    if test_filter:
        cmd.extend(["-k", test_filter])
    
    logger.info(f"Running E2E tests: {' '.join(cmd)}")
    
    try:
        # Run pytest in backend directory
        result = await asyncio.to_thread(
            subprocess.run,
            cmd,
            capture_output=True,
            text=True,
            cwd=str(backend_dir),
            timeout=600.0  # 10 minute timeout
        )
        
        return {
            "status": "passed" if result.returncode == 0 else "failed",
            "returncode": result.returncode,
            "stdout": result.stdout,
            "stderr": result.stderr,
            "command": " ".join(cmd)
        }
    
    except subprocess.TimeoutExpired:
        logger.error("E2E test execution timed out after 10 minutes")
        return {
            "status": "timeout",
            "returncode": -1,
            "stdout": "",
            "stderr": "Test execution timed out after 10 minutes",
            "command": " ".join(cmd)
        }
    
    except Exception as e:
        logger.error(f"Error running E2E tests: {e}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Failed to run E2E tests: {str(e)}"
        )

