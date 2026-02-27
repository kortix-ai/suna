"""
Test Harness Runner

Executes E2E benchmark tests by:
- Calling /agent/start API endpoint
- Consuming SSE streaming responses
- Tracking metrics (timing, tool calls, etc.)
- Managing concurrency
- Cleaning up test threads after completion
"""

import asyncio
import json
import time
import jwt
from datetime import datetime, timezone, timedelta
from typing import Optional, List, Dict, Any
from core.utils.logger import logger
from core.utils.config import config

from .prompts import TEST_PROMPTS, get_prompt, get_all_prompt_ids
from .metrics import MetricsCollector, BenchmarkResult
from .mock_llm import get_mock_provider


class TestHarnessRunner:
    """
    Main test harness runner for executing E2E benchmark tests
    """
    
    def __init__(
        self,
        base_url: Optional[str] = None,
        admin_api_key: Optional[str] = None,
        test_account_id: Optional[str] = None,
        cleanup_threads: bool = True
    ):
        """
        Initialize test runner
        
        Args:
            base_url: Base URL for API (defaults to localhost:8000)
            admin_api_key: Admin API key for authentication
            test_account_id: Account ID to use for tests (auto-created if None)
            cleanup_threads: Whether to delete test threads after completion (default: True)
        """
        self.base_url = base_url or "http://localhost:8000/v1"
        self.admin_api_key = admin_api_key or config.KORTIX_ADMIN_API_KEY
        self.test_account_id = test_account_id  # Will be set on first use
        self.cleanup_threads = cleanup_threads
        self.metrics = MetricsCollector()
        self._active_runs: Dict[str, bool] = {}  # run_id -> should_continue
        self._test_threads: Dict[str, List[str]] = {}  # run_id -> [thread_ids]
        self._tasks: Dict[str, asyncio.Task] = {}  # run_id -> background task (prevent GC)
        self._jwt_token: Optional[str] = None
        self._test_user_initialized = False
    
    async def _ensure_test_user(self) -> str:
        """
        Ensure test user exists and return their ID.
        
        Looks for user with email 'testuser@kortix.ai' and creates if not exists.
        
        Returns:
            user_id: UUID of the test user
        """
        if self._test_user_initialized and self.test_account_id:
            return self.test_account_id
        
        TEST_USER_EMAIL = "testuser@kortix.ai"
        
        from core.services.supabase import DBConnection
        db = DBConnection()
        await db.initialize()
        client = await db.client
        
        try:
            # Try to find existing test user
            result = await client.table('profiles').select('user_id, email').eq('email', TEST_USER_EMAIL).maybe_single().execute()
            
            if result.data:
                self.test_account_id = result.data['user_id']
                logger.info(f"✅ Using existing test user: {TEST_USER_EMAIL} (ID: {self.test_account_id})")
            else:
                # Create test user in auth.users
                logger.info(f"Creating test user: {TEST_USER_EMAIL}")
                
                # Use admin client to create user
                user_response = await client.auth.admin.create_user({
                    'email': TEST_USER_EMAIL,
                    'password': 'test_password_for_e2e_testing_12345',
                    'email_confirm': True,
                    'user_metadata': {
                        'test_user': True,
                        'created_by': 'e2e_test_harness'
                    }
                })
                
                self.test_account_id = user_response.user.id
                logger.info(f"✅ Created test user: {TEST_USER_EMAIL} (ID: {self.test_account_id})")
                
                # Create profile
                try:
                    await client.table('profiles').insert({
                        'user_id': self.test_account_id,
                        'email': TEST_USER_EMAIL,
                        'full_name': 'E2E Test User',
                    }).execute()
                    logger.debug("Created profile for test user")
                except Exception as profile_error:
                    # Profile might already exist (trigger-created), that's fine
                    logger.debug(f"Profile creation skipped (may already exist): {profile_error}")
            
            self._test_user_initialized = True
            return self.test_account_id
            
        except Exception as e:
            logger.error(f"Error ensuring test user: {e}", exc_info=True)
            
            # Fallback to SYSTEM_ADMIN_USER_ID if configured
            if config.SYSTEM_ADMIN_USER_ID:
                logger.warning(f"Falling back to SYSTEM_ADMIN_USER_ID: {config.SYSTEM_ADMIN_USER_ID}")
                self.test_account_id = config.SYSTEM_ADMIN_USER_ID
                self._test_user_initialized = True
                return self.test_account_id
            
            raise ValueError(
                f"Could not create or find test user '{TEST_USER_EMAIL}'. "
                "Please set SYSTEM_ADMIN_USER_ID in .env or check Supabase permissions."
            )
    
    def _generate_jwt_token(self) -> str:
        """Generate a JWT token for the test user"""
        if not self.test_account_id:
            raise ValueError("test_account_id is required to generate JWT token")
        
        if not config.SUPABASE_JWT_SECRET:
            raise ValueError("SUPABASE_JWT_SECRET not configured")
        
        # Generate JWT token for test user
        payload = {
            'sub': self.test_account_id,
            'aud': 'authenticated',
            'role': 'authenticated',
            'iat': datetime.now(timezone.utc).timestamp(),
            'exp': (datetime.now(timezone.utc) + timedelta(hours=1)).timestamp(),
        }
        
        token = jwt.encode(payload, config.SUPABASE_JWT_SECRET, algorithm='HS256')
        logger.debug(f"Generated JWT token for test user: {self.test_account_id}")
        return token
    
    def _get_auth_headers(self) -> Dict[str, str]:
        """Get authentication headers with JWT token"""
        if not self._jwt_token:
            self._jwt_token = self._generate_jwt_token()
        
        return {
            'Authorization': f'Bearer {self._jwt_token}'
        }
    
    async def _cleanup_test_threads(self, run_id: str):
        """Clean up threads created during testing"""
        if not self.cleanup_threads:
            return
        
        thread_ids = self._test_threads.get(run_id, [])
        if not thread_ids:
            return
        
        logger.info(f"Cleaning up {len(thread_ids)} test threads for run {run_id}")
        
        from core.services.supabase import DBConnection
        db = DBConnection()
        await db.initialize()
        client = await db.client
        
        try:
            # Delete agent_runs first (to avoid FK constraint violations), then threads
            for thread_id in thread_ids:
                try:
                    # Delete agent_runs first
                    await client.table('agent_runs').delete().eq('thread_id', thread_id).execute()
                    # Then delete the thread
                    await client.table('threads').delete().eq('thread_id', thread_id).execute()
                    logger.debug(f"Deleted test thread and its agent_runs: {thread_id}")
                except Exception as e:
                    logger.warning(f"Failed to delete thread {thread_id}: {e}")
            
            logger.info(f"✅ Cleaned up {len(thread_ids)} test threads")
        except Exception as e:
            logger.error(f"Error during thread cleanup: {e}")
    
    async def _execute_core_test(
        self,
        run_id: str,
        prompts: List,
        concurrency: int,
        model: str
    ):
        """Internal method to execute core test prompts"""
        try:
            # Execute prompts with concurrency control
            semaphore = asyncio.Semaphore(concurrency)
            
            async def execute_with_semaphore(prompt):
                async with semaphore:
                    if not self._active_runs.get(run_id, False):
                        logger.info(f"Run {run_id} cancelled, skipping prompt {prompt.id}")
                        return None
                    return await self.execute_single_prompt(
                        prompt=prompt,
                        run_id=run_id,
                        model=model
                    )
            
            tasks = [execute_with_semaphore(prompt) for prompt in prompts]
            results = await asyncio.gather(*tasks, return_exceptions=True)
            
            # Log any exceptions
            for i, result in enumerate(results):
                if isinstance(result, Exception):
                    logger.error(f"Prompt {prompts[i].id} failed with exception: {result}")
            
            # Finalize run
            status = 'completed' if self._active_runs.get(run_id, False) else 'cancelled'
            await self.metrics.finalize_run(run_id, status=status)
            
            # Cleanup test threads
            await self._cleanup_test_threads(run_id)
            
            logger.info(f"Core test completed: run_id={run_id}, status={status}")
            
        except Exception as e:
            logger.error(f"Core test failed: {e}", exc_info=True)
            await self.metrics.finalize_run(run_id, status='failed')
            await self._cleanup_test_threads(run_id)
        finally:
            self._active_runs.pop(run_id, None)
            self._test_threads.pop(run_id, None)
            self._tasks.pop(run_id, None)
    
    async def run_core_test(
        self,
        prompt_ids: Optional[List[str]] = None,
        concurrency: int = 1,
        model: str = "kortix/basic",
        metadata: Optional[Dict[str, Any]] = None
    ) -> str:
        """
        Execute core test with real LLM calls
        
        Args:
            prompt_ids: List of prompt IDs to test (None = all prompts)
            concurrency: Number of concurrent requests
            model: Model to use for testing
            metadata: Additional metadata to store
        
        Returns:
            run_id: UUID of the benchmark run (returned immediately)
        """
        # Ensure test user exists
        await self._ensure_test_user()
        
        # Get prompts to test
        if prompt_ids is None:
            prompts = TEST_PROMPTS
        else:
            prompts = [get_prompt(pid) for pid in prompt_ids if get_prompt(pid)]
        
        if not prompts:
            raise ValueError("No valid prompts found")
        
        logger.info(f"Starting core test: {len(prompts)} prompts, concurrency={concurrency}, model={model}")
        
        # Create benchmark run record immediately
        run_id = await self.metrics.start_run(
            run_type='core_test',
            model_name=model,
            concurrency_level=concurrency,
            total_prompts=len(prompts),
            metadata=metadata or {},
            created_by=self.test_account_id
        )
        
        self._active_runs[run_id] = True
        self._test_threads[run_id] = []
        
        # Execute tests in background
        task = asyncio.create_task(self._execute_core_test(run_id, prompts, concurrency, model))
        
        # Store task reference to prevent garbage collection
        self._tasks[run_id] = task
        
        # Return run_id immediately
        return run_id
    
    async def _execute_stress_test(
        self,
        run_id: str,
        prompts: List,
        concurrency: int,
        num_executions: int
    ):
        """Internal method to execute stress test with MOCKED responses"""
        try:
            logger.info(f"🔥 STRESS TEST: {num_executions} executions with {concurrency} concurrency (MOCK MODE)")
            logger.info(f"🔍 DEBUG: run_id={run_id}, active_runs={self._active_runs}, prompts_count={len(prompts)}")
            
            # No semaphore if concurrency == num_executions (run all at once)
            if concurrency >= num_executions:
                logger.info(f"⚡ Running ALL {num_executions} requests simultaneously")
                
                async def execute_mock(idx):
                    is_active = self._active_runs.get(run_id, False)
                    logger.debug(f"🔍 execute_mock({idx}): run_id={run_id}, is_active={is_active}")
                    if not is_active:
                        logger.warning(f"⚠️ Run {run_id} is not active, skipping execution {idx}")
                        return None
                    prompt = prompts[idx % len(prompts)]
                    logger.debug(f"🔍 Executing prompt {prompt.id} for idx {idx}")
                    result = await self.execute_single_prompt(
                        prompt=prompt,
                        run_id=run_id,
                        model='mock-ai'  # Use mock LLM provider
                    )
                    logger.debug(f"🔍 Execution {idx} completed: {result.status if result else 'None'}")
                    return result
                
                tasks = [execute_mock(i) for i in range(num_executions)]
                logger.info(f"🔍 Created {len(tasks)} tasks, about to gather...")
                results = await asyncio.gather(*tasks, return_exceptions=True)
                logger.info(f"🔍 Gathered {len(results)} results. None count: {sum(1 for r in results if r is None)}")
            else:
                # Use semaphore for controlled concurrency
                semaphore = asyncio.Semaphore(concurrency)
                
                async def execute_with_semaphore(idx):
                    async with semaphore:
                        if not self._active_runs.get(run_id, False):
                            return None
                        prompt = prompts[idx % len(prompts)]
                        return await self.execute_single_prompt(
                            prompt=prompt,
                            run_id=run_id,
                            model='mock-ai'  # Use mock LLM provider
                        )
                
                tasks = [execute_with_semaphore(i) for i in range(num_executions)]
                results = await asyncio.gather(*tasks, return_exceptions=True)
            
            # Log any exceptions
            exception_count = sum(1 for r in results if isinstance(r, Exception))
            if exception_count > 0:
                logger.warning(f"Stress test had {exception_count} exceptions out of {num_executions} executions")
                # Log first few exceptions for debugging
                for i, r in enumerate(results[:3]):
                    if isinstance(r, Exception):
                        logger.error(f"Exception in stress test execution {i}: {type(r).__name__}: {r}", exc_info=r)
            
            # Finalize run
            status = 'completed' if self._active_runs.get(run_id, False) else 'cancelled'
            await self.metrics.finalize_run(run_id, status=status)
            
            # Cleanup test threads
            await self._cleanup_test_threads(run_id)
            
            logger.info(f"Stress test completed: run_id={run_id}, status={status}")

        except Exception as e:
            logger.error(f"Stress test failed: {e}", exc_info=True)
            await self.metrics.finalize_run(run_id, status='failed')
        finally:
            self._active_runs.pop(run_id, None)
            self._test_threads.pop(run_id, None)
            self._tasks.pop(run_id, None)
    
    async def run_stress_test(
        self,
        prompt_ids: Optional[List[str]] = None,
        concurrency: int = 10,
        num_executions: int = 100,
        metadata: Optional[Dict[str, Any]] = None
    ) -> str:
        """
        Execute stress test with mocked LLM
        
        Args:
            prompt_ids: List of prompt IDs to test (None = all prompts)
            concurrency: Number of concurrent requests
            num_executions: Total number of executions to run
            metadata: Additional metadata to store
        
        Returns:
            run_id: UUID of the benchmark run (returned immediately)
        """
        # Ensure test user exists
        await self._ensure_test_user()
        
        # Get prompts to test
        if prompt_ids is None:
            prompts = TEST_PROMPTS
        else:
            prompts = [get_prompt(pid) for pid in prompt_ids if get_prompt(pid)]
        
        if not prompts:
            raise ValueError("No valid prompts found")
        
        logger.info(f"Starting stress test: {num_executions} executions, concurrency={concurrency}")
        
        # Create benchmark run record immediately
        run_id = await self.metrics.start_run(
            run_type='stress_test',
            model_name='mock',
            concurrency_level=concurrency,
            total_prompts=num_executions,
            metadata=metadata or {},
            created_by=self.test_account_id
        )
        
        self._active_runs[run_id] = True
        self._test_threads[run_id] = []  # Initialize thread tracking
        
        logger.info(f"✅ About to create background task: run_id={run_id}, active_runs={self._active_runs}")
        
        # Execute tests in background
        task = asyncio.create_task(self._execute_stress_test(run_id, prompts, concurrency, num_executions))
        logger.info(f"✅ Background task created: {task}")
        
        # Store task reference to prevent garbage collection
        self._tasks[run_id] = task
        
        # Return run_id immediately
        return run_id
    
    async def execute_single_prompt(
        self,
        prompt,
        run_id: str,
        model: str = "kortix/basic"
    ) -> Optional[BenchmarkResult]:
        """
        Execute a single test prompt and collect metrics
        
        Args:
            prompt: TestPrompt object
            run_id: Benchmark run ID
            model: Model to use (use "mock-ai" for mocked LLM responses)
        
        Returns:
            BenchmarkResult with collected metrics
        """
        started_at = datetime.now(timezone.utc)
        start_time = time.time()
        
        thread_id = None
        agent_run_id = None
        cold_start_time_ms = None
        tool_calls = []
        stream_chunks = []
        chunk_timestamps = []  # Initialize to prevent UnboundLocalError in error handler
        error_message = None
        status = 'completed'
        
        # Make API calls (real or mocked based on model name)
        try:
            # For stress tests with mock LLM, use a shorter timeout (30s instead of 120s)
            timeout_seconds = 30.0 if model == 'mock-ai' else 120.0
            
            # Call /agent/start
            from core.services.http_client import get_http_client
            async with get_http_client() as client:
                # Start agent with JWT authentication
                auth_headers = self._get_auth_headers()
                
                start_response = await client.post(
                    f"{self.base_url}/agent/start",
                    data={
                        'prompt': prompt.text,
                        'model_name': model,
                    },
                    headers=auth_headers,
                    timeout=timeout_seconds
                )
                
                if start_response.status_code != 200:
                    raise Exception(f"Failed to start agent: {start_response.status_code} - {start_response.text}")
                
                start_data = start_response.json()
                thread_id = start_data.get('thread_id')
                agent_run_id = start_data.get('agent_run_id')
                
                # Track thread for cleanup
                if thread_id and run_id in self._test_threads:
                    self._test_threads[run_id].append(thread_id)
                
                # Connect to streaming endpoint
                stream_url = f"{self.base_url}/agent-run/{agent_run_id}/stream"
                
                first_chunk_received = False
                chunk_timestamps = []
                
                async with client.stream('GET', stream_url, headers=auth_headers) as stream_response:
                    
                    if stream_response.status_code != 200:
                        raise Exception(f"Failed to connect to stream: {stream_response.status_code}")
                    
                    # Parse SSE stream
                    async for line in stream_response.aiter_lines():
                        if not line or not line.strip():
                            continue
                        
                        if line.startswith('data: '):
                            data_str = line[6:]  # Remove 'data: ' prefix
                            
                            try:
                                data = json.loads(data_str)
                            except json.JSONDecodeError:
                                continue
                            
                            chunk_time = time.time()
                            
                            # Record cold start time (first chunk)
                            if not first_chunk_received:
                                cold_start_time_ms = int((chunk_time - start_time) * 1000)
                                first_chunk_received = True
                            
                            chunk_timestamps.append(chunk_time)
                            stream_chunks.append(data)
                            
                            # Track tool calls from assistant message metadata
                            if data.get('type') == 'assistant':
                                try:
                                    metadata = data.get('metadata', '{}')
                                    if isinstance(metadata, str):
                                        metadata = json.loads(metadata)
                                    
                                    # Extract tool calls from metadata
                                    metadata_tool_calls = metadata.get('tool_calls', [])
                                    if metadata_tool_calls:
                                        for tc in metadata_tool_calls:
                                            tool_call_data = {
                                                'tool_name': tc.get('function_name', tc.get('name')),
                                                'tool_call_id': tc.get('tool_call_id'),
                                                'timestamp': chunk_time,
                                                'input': tc.get('arguments', {}),
                                            }
                                            # Avoid duplicates (same tool_call_id)
                                            if not any(t.get('tool_call_id') == tool_call_data['tool_call_id'] for t in tool_calls):
                                                tool_calls.append(tool_call_data)
                                except (json.JSONDecodeError, AttributeError) as e:
                                    logger.debug(f"Failed to parse tool calls from metadata: {e}")
                            
                            # Check for completion
                            if data.get('type') == 'status':
                                if data.get('status') in ['completed', 'stopped']:
                                    break
                                elif data.get('status') in ['failed', 'error']:
                                    status = 'failed'
                                    error_message = data.get('message', 'Unknown error')
                                    break
        
        except asyncio.TimeoutError:
            status = 'timeout'
            error_message = f"Execution exceeded {prompt.max_duration_ms}ms timeout"
            logger.warning(f"Prompt {prompt.id} timed out")
        
        except Exception as e:
            status = 'error'
            error_message = str(e)
            logger.error(f"Prompt {prompt.id} failed: {e}", exc_info=True)
        
        # Fetch tool calls from final assistant message in database
        if status == 'completed' and thread_id and not tool_calls:
            try:
                await self.metrics.db.initialize()
                client = await self.metrics.db.client
                messages_response = await client.table('messages').select('metadata').eq('thread_id', thread_id).eq('type', 'assistant').eq('is_llm_message', True).order('created_at', desc=True).limit(1).execute()
                
                if messages_response.data and len(messages_response.data) > 0:
                    msg_metadata = messages_response.data[0].get('metadata', {})
                    db_tool_calls = msg_metadata.get('tool_calls', [])
                    if db_tool_calls:
                        logger.debug(f"Fetched {len(db_tool_calls)} tool calls from DB for thread {thread_id}")
                        for tc in db_tool_calls:
                            tool_calls.append({
                                'tool_name': tc.get('function_name', tc.get('name')),
                                'tool_call_id': tc.get('tool_call_id'),
                                'timestamp': time.time(),  # Use current time as proxy
                                'input': tc.get('arguments', {}),
                            })
            except Exception as e:
                logger.warning(f"Failed to fetch tool calls from DB: {e}")
        
        # Calculate metrics
        completed_at = datetime.now(timezone.utc)
        total_duration_ms = int((time.time() - start_time) * 1000)
        
        # Tool call metrics
        tool_calls_count = len(tool_calls)
        avg_tool_call_time_ms = None
        slowest_tool_call = None
        
        if tool_calls_count > 0 and len(tool_calls) > 1:
            # Calculate time between tool calls as proxy for tool execution time
            tool_durations = []
            for i in range(1, len(tool_calls)):
                duration = (tool_calls[i]['timestamp'] - tool_calls[i-1]['timestamp']) * 1000
                tool_durations.append(duration)
                tool_calls[i-1]['duration_ms'] = int(duration)
            
            if tool_durations:
                avg_tool_call_time_ms = sum(tool_durations) / len(tool_durations)
                max_idx = tool_durations.index(max(tool_durations))
                slowest_tool_call = {
                    'tool_name': tool_calls[max_idx]['tool_name'],
                    'duration_ms': int(tool_durations[max_idx])
                }
        
        # Stream chunk metrics
        stream_chunk_count = len(stream_chunks)
        avg_chunk_interval_ms = None
        
        if len(chunk_timestamps) > 1:
            intervals = []
            for i in range(1, len(chunk_timestamps)):
                interval = (chunk_timestamps[i] - chunk_timestamps[i-1]) * 1000
                intervals.append(interval)
            
            if intervals:
                avg_chunk_interval_ms = sum(intervals) / len(intervals)
        
        # Calculate tool call breakdown
        tool_call_breakdown = {}
        for tool_call in tool_calls:
            tool_name = tool_call.get('tool_name', 'unknown')
            tool_call_breakdown[tool_name] = tool_call_breakdown.get(tool_name, 0) + 1
        
        # Validate expected tools are present
        called_tools = set(tool_call_breakdown.keys())
        expected_tools = set(prompt.expected_tools)
        missing_tools = list(expected_tools - called_tools)
        expected_tools_present = len(missing_tools) == 0
        
        # Create result
        result = BenchmarkResult(
            prompt_id=prompt.id,
            prompt_text=prompt.text,
            thread_id=thread_id,
            agent_run_id=agent_run_id,
            started_at=started_at,
            completed_at=completed_at,
            cold_start_time_ms=cold_start_time_ms,
            total_duration_ms=total_duration_ms,
            tool_calls_count=tool_calls_count,
            tool_calls=tool_calls,
            tool_call_breakdown=tool_call_breakdown,
            expected_tools_present=expected_tools_present,
            missing_tools=missing_tools,
            avg_tool_call_time_ms=avg_tool_call_time_ms,
            slowest_tool_call=slowest_tool_call,
            stream_chunk_count=stream_chunk_count,
            avg_chunk_interval_ms=avg_chunk_interval_ms,
            status=status,
            error_message=error_message,
            metadata={
                'model': model,
                'mock_mode': model == 'mock-ai',
                'expected_tools': prompt.expected_tools,
                'expected_tool_calls': prompt.expected_tool_calls or {},
                'category': prompt.category,
            }
        )
        
        # Record result
        await self.metrics.record_prompt_result(run_id, result)
        
        logger.debug(f"Prompt {prompt.id} completed: {status} ({total_duration_ms}ms, {tool_calls_count} tool calls)")
        
        return result
    
    async def cancel_run(self, run_id: str):
        """
        Cancel an active benchmark run
        
        Args:
            run_id: UUID of the benchmark run
        """
        if run_id in self._active_runs:
            self._active_runs[run_id] = False
            await self.metrics.cancel_run(run_id)
            logger.info(f"Cancelled benchmark run: {run_id}")
        else:
            logger.warning(f"Cannot cancel run {run_id}: not found or already completed")

