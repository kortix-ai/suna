"""
Rate limiting utilities for API endpoints.

This module provides in-memory rate limiting for sensitive endpoints
to prevent brute force attacks and DoS.
"""

import hashlib
import time
from collections import OrderedDict
from typing import Optional
from fastapi import Request


class RateLimiter:
    """
    In-memory rate limiter using sliding window approach.
    
    Features:
    - Per-client rate limiting based on real IP
    - Automatic cleanup of expired entries
    - LRU eviction to prevent unbounded memory growth
    
    Usage:
        limiter = RateLimiter(max_requests=100, window_seconds=60)
        is_limited, retry_after = limiter.is_rate_limited(client_id)
    """
    
    def __init__(self, max_requests: int = 60, window_seconds: int = 60):
        """
        Initialize rate limiter.
        
        Args:
            max_requests: Maximum requests allowed per window
            window_seconds: Time window in seconds
        """
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        self.requests: OrderedDict[str, list] = OrderedDict()
        self._last_cleanup = time.time()
        self._cleanup_interval = 60  # Cleanup every minute
        self._max_entries = 10000  # Prevent unbounded memory growth
    
    def _cleanup(self):
        """Remove expired entries and enforce max size."""
        current_time = time.time()
        
        # Only cleanup periodically
        if current_time - self._last_cleanup < self._cleanup_interval:
            return
            
        self._last_cleanup = current_time
        cutoff = current_time - self.window_seconds
        
        # Remove expired timestamps from all keys
        keys_to_remove = []
        for key, timestamps in self.requests.items():
            self.requests[key] = [t for t in timestamps if t > cutoff]
            if not self.requests[key]:
                keys_to_remove.append(key)
        
        for key in keys_to_remove:
            del self.requests[key]
        
        # Enforce max entries (LRU eviction)
        while len(self.requests) > self._max_entries:
            self.requests.popitem(last=False)
    
    def is_rate_limited(self, identifier: str) -> tuple[bool, int]:
        """
        Check if the identifier is rate limited.
        
        Args:
            identifier: Unique client identifier (e.g., hashed IP)
            
        Returns:
            tuple: (is_limited: bool, retry_after_seconds: int)
        """
        self._cleanup()
        
        current_time = time.time()
        cutoff = current_time - self.window_seconds
        
        # Get or create request list
        if identifier not in self.requests:
            self.requests[identifier] = []
        
        # Filter to only recent requests
        recent = [t for t in self.requests[identifier] if t > cutoff]
        self.requests[identifier] = recent
        
        # Check limit
        if len(recent) >= self.max_requests:
            # Calculate retry-after
            oldest = min(recent)
            retry_after = int(oldest + self.window_seconds - current_time) + 1
            return True, max(1, retry_after)
        
        # Record this request
        self.requests[identifier].append(current_time)
        self.requests.move_to_end(identifier)  # LRU update
        
        return False, 0


def get_real_client_ip(request: Request) -> str:
    """
    Get the real client IP, handling proxies/load balancers/CDNs.
    
    Supports:
    - X-Forwarded-For (AWS ALB, CloudFront, Cloudflare, Vercel, Nginx)
    - X-Real-IP (Nginx, Vercel)
    - Direct connection fallback
    
    Args:
        request: FastAPI request object
        
    Returns:
        str: The client's real IP address
    """
    # X-Forwarded-For can contain multiple IPs: client, proxy1, proxy2
    # The first one is the original client
    forwarded_for = request.headers.get("x-forwarded-for")
    if forwarded_for:
        # Take the first (leftmost) IP which is the original client
        client_ip = forwarded_for.split(",")[0].strip()
        if client_ip:
            return client_ip
    
    # Some proxies use X-Real-IP instead
    real_ip = request.headers.get("x-real-ip")
    if real_ip:
        return real_ip.strip()
    
    # Fall back to direct connection IP
    return request.client.host if request.client else "unknown"


def get_client_identifier(request: Request) -> str:
    """
    Get a unique identifier for rate limiting based on real client IP.
    
    Args:
        request: FastAPI request object
        
    Returns:
        str: Hashed identifier for the client
    """
    client_ip = get_real_client_ip(request)
    # Hash to normalize format and prevent extremely long keys
    identifier = hashlib.sha256(client_ip.encode()).hexdigest()[:32]
    return identifier


# =============================================================================
# Pre-configured rate limiters for different endpoint categories
# =============================================================================

# Auth/webhook endpoints: 100 requests per minute per client
# Protects against credential brute force attacks
auth_rate_limiter = RateLimiter(max_requests=100, window_seconds=60)

# API key management: 60 requests per minute per client
# Protects against key enumeration/brute force
api_key_rate_limiter = RateLimiter(max_requests=60, window_seconds=60)

# Admin endpoints: 300 requests per minute per client
# Higher limit for legitimate admin operations
admin_rate_limiter = RateLimiter(max_requests=300, window_seconds=60)
