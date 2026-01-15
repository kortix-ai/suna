import os
from dataclasses import dataclass
from typing import Optional


@dataclass
class SandboxPoolConfig:
    """Configuration for the sandbox pool service."""
    
    # Minimum number of warm sandboxes to maintain in the pool
    min_size: int = 5
    
    # Maximum number of sandboxes in the pool (prevents runaway creation)
    max_size: int = 20
    
    replenish_threshold: float = 0.3
    
    # Seconds between pool size checks
    check_interval: int = 30
    
    # Maximum age (seconds) a sandbox can stay in pool before being cleaned up
    max_age: int = 3600  # 1 hour
    
    # Whether the pool service is enabled
    enabled: bool = True
    
    # Number of sandboxes to create in parallel during replenishment
    parallel_create_limit: int = 3
    
    @classmethod
    def from_env(cls) -> "SandboxPoolConfig":
        return cls(
            min_size=int(os.getenv("SANDBOX_POOL_MIN_SIZE", "5")),
            max_size=int(os.getenv("SANDBOX_POOL_MAX_SIZE", "20")),
            replenish_threshold=float(os.getenv("SANDBOX_POOL_REPLENISH_THRESHOLD", "0.3")),
            check_interval=int(os.getenv("SANDBOX_POOL_CHECK_INTERVAL", "30")),
            max_age=int(os.getenv("SANDBOX_POOL_MAX_AGE", "3600")),
            enabled=os.getenv("SANDBOX_POOL_ENABLED", "true").lower() in ("true", "1", "yes"),
            parallel_create_limit=int(os.getenv("SANDBOX_POOL_PARALLEL_CREATE", "3")),
        )
    
    @property
    def replenish_below(self) -> int:
        return max(1, int(self.min_size * self.replenish_threshold))


_config: Optional[SandboxPoolConfig] = None


def get_pool_config() -> SandboxPoolConfig:
    global _config
    if _config is None:
        _config = SandboxPoolConfig.from_env()
    return _config


def reset_pool_config() -> None:
    global _config
    _config = None
