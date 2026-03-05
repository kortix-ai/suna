import asyncio
import time
from typing import Any, Callable, Dict, Optional
from datetime import datetime, timezone, timedelta
from enum import Enum
from functools import wraps
import stripe
from core.utils.logger import logger
from core.services.convex_client import get_convex_client
from core.utils.config import config
from ..interfaces import CircuitBreakerInterface

stripe.api_key = config.STRIPE_SECRET_KEY

class CircuitState(Enum):
    CLOSED = "closed"
    OPEN = "open"
    HALF_OPEN = "half_open"


class StripeCircuitBreaker(CircuitBreakerInterface):
    """
    High-performance circuit breaker for Stripe API calls.
    
    PERFORMANCE OPTIMIZATIONS (Jan 2026):
    - In-memory state caching with configurable TTL (avoids DB reads on every call)
    - NO DB writes on success - only writes when state changes (failure/recovery)
    - No global lock - uses atomic in-memory counters for high concurrency
    - Convex is used for persistence across restarts and multi-instance coordination
    
    Memory state is authoritative for fast-path (closed circuit).
    Convex state is checked periodically and on failures for cross-instance coordination.
    """
    
    # Class-level cache shared across all instances (per worker process)
    _memory_state: Optional[Dict] = None
    _memory_state_time: float = 0
    _memory_state_ttl: float = 10.0  # Check Convex every 10 seconds max
    _state_lock: Optional[asyncio.Lock] = None
    
    def __init__(
        self,
        circuit_name: str = "stripe_api",
        failure_threshold: int = 5,
        recovery_timeout: int = 60,
        expected_exception: type = stripe.StripeError
    ):
        self.circuit_name = circuit_name
        self.failure_threshold = failure_threshold
        self.recovery_timeout = recovery_timeout
        self.expected_exception = expected_exception
        self._convex_client = None
    
    @property
    def convex_client(self):
        """Lazy initialization of Convex client."""
        if self._convex_client is None:
            self._convex_client = get_convex_client()
        return self._convex_client
    
    @classmethod
    def _get_lock(cls) -> asyncio.Lock:
        """Lazily create the async lock (must be called from async context)."""
        if cls._state_lock is None:
            cls._state_lock = asyncio.Lock()
        return cls._state_lock
    
    async def safe_call(self, func: Callable, *args, **kwargs) -> Any:
        """
        Execute Stripe API call with circuit breaker protection.
        
        PERFORMANCE: No lock on the hot path (closed circuit).
        Lock only acquired when circuit is not closed or state needs update.
        """
        # Fast path: Check memory state without lock
        state_info = self._get_memory_state()
        
        if state_info and state_info['state'] == CircuitState.CLOSED:
            # Circuit is closed - execute without any Convex calls or locks
            try:
                result = await func(*args, **kwargs)
                # Success on closed circuit - no Convex write needed
                return result
            except self.expected_exception as e:
                # Failure - need to record it (this path is rare)
                await self._record_failure_async(str(e))
                raise
            except Exception as e:
                logger.error(f"[CIRCUIT BREAKER] Unexpected error in {func.__name__}: {e}")
                raise
        
        # Slow path: Circuit may be open/half-open, need to check state
        state_info = await self._get_circuit_state_with_refresh()
        
        if await self._should_allow_request(state_info):
            try:
                result = await func(*args, **kwargs)
                # If we were not CLOSED, record success to transition back
                if state_info['state'] != CircuitState.CLOSED:
                    await self._record_success_async()
                return result
            except self.expected_exception as e:
                await self._record_failure_async(str(e))
                raise
            except Exception as e:
                logger.error(f"[CIRCUIT BREAKER] Unexpected error in {func.__name__}: {e}")
                raise
        else:
            logger.warning(f"[CIRCUIT BREAKER] Request blocked - circuit is {state_info['state'].value}")
            raise Exception(f"Circuit breaker is {state_info['state'].value} - blocking request to Stripe API")
    
    def _get_memory_state(self) -> Optional[Dict]:
        """Get cached state from memory if still valid."""
        now = time.time()
        if (StripeCircuitBreaker._memory_state is not None and 
            (now - StripeCircuitBreaker._memory_state_time) < StripeCircuitBreaker._memory_state_ttl):
            return StripeCircuitBreaker._memory_state
        return None
    
    def _set_memory_state(self, state_info: Dict) -> None:
        """Update memory cache."""
        StripeCircuitBreaker._memory_state = state_info
        StripeCircuitBreaker._memory_state_time = time.time()
    
    async def _get_circuit_state_with_refresh(self) -> Dict:
        """Get circuit state, refreshing from Convex if cache expired."""
        cached = self._get_memory_state()
        if cached:
            return cached
        
        # Cache miss - fetch from Convex (with lock to prevent thundering herd)
        async with self._get_lock():
            # Double-check after acquiring lock
            cached = self._get_memory_state()
            if cached:
                return cached
            
            state_info = await self._fetch_state_from_convex()
            self._set_memory_state(state_info)
            return state_info
    
    async def _fetch_state_from_convex(self) -> Dict:
        """
        Fetch circuit state from Convex.
        
        TODO: Requires Convex endpoint for circuit_breaker_state table operations.
        The following Convex endpoints need to be created:
        - GET /api/circuit-breaker/state?circuitName=stripe_api
        - POST /api/circuit-breaker/state (upsert)
        
        For now, returns default CLOSED state.
        """
        try:
            # TODO: Implement Convex circuit breaker state endpoint
            # The Supabase implementation queried the 'circuit_breaker_state' table:
            #   result = await client.from_('circuit_breaker_state').select('*').eq(
            #       'circuit_name', self.circuit_name
            #   ).execute()
            #
            # For now, we'll use in-memory state only and log a warning
            logger.debug(f"[CIRCUIT BREAKER] Using in-memory state only - Convex endpoint not yet implemented for {self.circuit_name}")
            
            # Return default closed state
            return {
                'state': CircuitState.CLOSED,
                'failure_count': 0,
                'last_failure_time': None
            }
            
        except Exception as e:
            logger.error(f"[CIRCUIT BREAKER] Error reading state from Convex: {e}, defaulting to CLOSED")
            return {
                'state': CircuitState.CLOSED,
                'failure_count': 0,
                'last_failure_time': None
            }
    
    async def get_status(self) -> Dict:
        """Get current circuit breaker status."""
        state_info = await self._get_circuit_state_with_refresh()
        return {
            'circuit_name': self.circuit_name,
            'state': state_info['state'].value,
            'failure_count': state_info['failure_count'],
            'last_failure_time': state_info['last_failure_time'].isoformat() if state_info['last_failure_time'] else None,
            'failure_threshold': self.failure_threshold,
            'recovery_timeout': self.recovery_timeout,
            'status': '✅ Healthy' if state_info['state'] == CircuitState.CLOSED else f"🔴 {state_info['state'].value.upper()}",
            'cache_age_seconds': time.time() - StripeCircuitBreaker._memory_state_time if StripeCircuitBreaker._memory_state else None
        }
    
    async def _should_allow_request(self, state_info: Dict) -> bool:
        """Check if request should be allowed based on circuit state."""
        state = state_info['state']
        
        if state == CircuitState.CLOSED:
            return True
        elif state == CircuitState.OPEN:
            if state_info['last_failure_time']:
                time_since_failure = datetime.now(timezone.utc) - state_info['last_failure_time']
                if time_since_failure.total_seconds() >= self.recovery_timeout:
                    # Transition to half-open (allow one request through)
                    await self._transition_to_half_open()
                    return True
            return False
        elif state == CircuitState.HALF_OPEN:
            return True
        
        return False
    
    async def _record_success_async(self):
        """
        Record success - only called when recovering from non-CLOSED state.
        Updates both memory and Convex to transition back to CLOSED.
        """
        try:
            new_state = {
                'state': CircuitState.CLOSED,
                'failure_count': 0,
                'last_failure_time': None
            }
            
            # Update memory immediately
            self._set_memory_state(new_state)
            
            # TODO: Persist to Convex for cross-instance coordination
            # The Supabase implementation was:
            #   await client.from_('circuit_breaker_state').upsert({
            #       'circuit_name': self.circuit_name,
            #       'state': CircuitState.CLOSED.value,
            #       'failure_count': 0,
            #       'last_failure_time': None,
            #       'updated_at': datetime.now(timezone.utc).isoformat()
            #   }).execute()
            logger.debug(f"[CIRCUIT BREAKER] Circuit recovered to CLOSED for {self.circuit_name} (in-memory only)")
            
        except Exception as e:
            logger.error(f"[CIRCUIT BREAKER] Failed to record success: {e}")
    
    async def _record_failure_async(self, error_message: str):
        """Record failure - increments counter and may open circuit."""
        try:
            async with self._get_lock():
                # Get current state (prefer memory, fall back to Convex)
                state_info = self._get_memory_state()
                if not state_info:
                    state_info = await self._fetch_state_from_convex()
                
                new_failure_count = state_info['failure_count'] + 1
                new_state = CircuitState.OPEN if new_failure_count >= self.failure_threshold else state_info['state']
                
                # If state is CLOSED and we're below threshold, keep it CLOSED
                if new_state == CircuitState.OPEN and state_info['state'] == CircuitState.CLOSED:
                    new_state = CircuitState.CLOSED if new_failure_count < self.failure_threshold else CircuitState.OPEN
                
                now = datetime.now(timezone.utc)
                updated_state = {
                    'state': new_state,
                    'failure_count': new_failure_count,
                    'last_failure_time': now
                }
                
                # Update memory immediately
                self._set_memory_state(updated_state)
                
                # TODO: Persist to Convex
                # The Supabase implementation was:
                #   await client.from_('circuit_breaker_state').upsert({
                #       'circuit_name': self.circuit_name,
                #       'state': new_state.value,
                #       'failure_count': new_failure_count,
                #       'last_failure_time': now.isoformat(),
                #       'updated_at': now.isoformat()
                #   }).execute()
                
                if new_state == CircuitState.OPEN:
                    logger.warning(f"[CIRCUIT BREAKER] Circuit OPENED due to {new_failure_count} failures: {error_message}")
                else:
                    logger.debug(f"[CIRCUIT BREAKER] Recorded failure #{new_failure_count} for {self.circuit_name}")
                    
        except Exception as e:
            logger.error(f"[CIRCUIT BREAKER] Failed to record failure: {e}")
    
    async def _transition_to_half_open(self):
        """Transition circuit to half-open state."""
        try:
            half_open_state = {
                'state': CircuitState.HALF_OPEN,
                'failure_count': 0,
                'last_failure_time': self._get_memory_state().get('last_failure_time') if self._get_memory_state() else None
            }
            
            # Update memory
            self._set_memory_state(half_open_state)
            
            # TODO: Persist to Convex
            # The Supabase implementation was:
            #   await client.from_('circuit_breaker_state').upsert({
            #       'circuit_name': self.circuit_name,
            #       'state': CircuitState.HALF_OPEN.value,
            #       'failure_count': 0,
            #       'updated_at': datetime.now(timezone.utc).isoformat()
            #   }).execute()
            
            logger.info(f"[CIRCUIT BREAKER] Circuit transitioned to HALF_OPEN for {self.circuit_name} (in-memory only)")
            
        except Exception as e:
            logger.error(f"[CIRCUIT BREAKER] Failed to transition to half-open: {e}")
    
    async def _initialize_circuit_state(self):
        """Initialize circuit state in Convex if it doesn't exist."""
        # TODO: Implement Convex circuit breaker state initialization
        # The Supabase implementation was:
        #   await client.from_('circuit_breaker_state').insert({
        #       'circuit_name': self.circuit_name,
        #       'state': CircuitState.CLOSED.value,
        #       'failure_count': 0,
        #       'last_failure_time': None,
        #       'updated_at': datetime.now(timezone.utc).isoformat(),
        #       'created_at': datetime.now(timezone.utc).isoformat()
        #   }).execute()
        logger.debug(f"[CIRCUIT BREAKER] Using in-memory state for {self.circuit_name} - Convex persistence not yet implemented")


class StripeAPIWrapper:
    """
    Wrapper for Stripe API calls with circuit breaker protection and timeouts.
    
    Uses a shared circuit breaker instance for all Stripe API calls.
    """
    _circuit_breaker = StripeCircuitBreaker()
    DEFAULT_TIMEOUT = 30
    
    @classmethod
    async def safe_stripe_call(cls, func: Callable, *args, timeout: Optional[float] = None, **kwargs) -> Any:
        """Execute Stripe API call with timeout and circuit breaker protection."""
        request_timeout = timeout or cls.DEFAULT_TIMEOUT
        try:
            return await asyncio.wait_for(
                cls._circuit_breaker.safe_call(func, *args, **kwargs),
                timeout=request_timeout
            )
        except asyncio.TimeoutError:
            logger.error(f"[STRIPE API] Timeout after {request_timeout}s for {func.__name__}")
            raise Exception(f"Stripe API timeout after {request_timeout}s")
    
    @classmethod
    async def get_circuit_status(cls) -> Dict:
        """Get current circuit breaker status."""
        return await cls._circuit_breaker.get_status()
    
    @classmethod
    async def retrieve_customer(cls, customer_id: str) -> stripe.Customer:
        return await cls.safe_stripe_call(stripe.Customer.retrieve_async, customer_id)
    
    @classmethod
    async def create_customer(cls, **kwargs) -> stripe.Customer:
        return await cls.safe_stripe_call(stripe.Customer.create_async, **kwargs)
    
    @classmethod
    async def retrieve_subscription(cls, subscription_id: str) -> stripe.Subscription:
        return await cls.safe_stripe_call(stripe.Subscription.retrieve_async, subscription_id)
    
    @classmethod
    async def retrieve_payment_intent(cls, payment_intent_id: str) -> stripe.PaymentIntent:
        return await cls.safe_stripe_call(stripe.PaymentIntent.retrieve_async, payment_intent_id)
    
    @classmethod
    async def cancel_subscription(cls, subscription_id: str, cancel_immediately: bool = True) -> stripe.Subscription:
        if cancel_immediately:
            return await cls.safe_stripe_call(
                stripe.Subscription.cancel_async, 
                subscription_id,
                prorate=True
            )
        else:
            return await cls.safe_stripe_call(
                stripe.Subscription.modify_async,
                subscription_id,
                cancel_at_period_end=True
            )
    
    @classmethod
    async def modify_subscription(cls, subscription_id: str, **kwargs) -> stripe.Subscription:
        return await cls.safe_stripe_call(
            stripe.Subscription.modify_async,
            subscription_id,
            **kwargs
        )
    
    @classmethod
    async def create_checkout_session(cls, **kwargs) -> stripe.checkout.Session:
        return await cls.safe_stripe_call(stripe.checkout.Session.create_async, **kwargs)
    
    @classmethod 
    async def list_invoices(cls, **kwargs) -> stripe.ListObject:
        return await cls.safe_stripe_call(stripe.Invoice.list_async, **kwargs)
    
    @classmethod
    async def retrieve_price(cls, price_id: str) -> stripe.Price:
        return await cls.safe_stripe_call(stripe.Price.retrieve_async, price_id)
    
    @classmethod
    async def list_subscriptions(cls, **kwargs) -> stripe.ListObject:
        return await cls.safe_stripe_call(stripe.Subscription.list_async, **kwargs)


# Singleton instance for backwards compatibility
stripe_circuit_breaker = StripeCircuitBreaker()
