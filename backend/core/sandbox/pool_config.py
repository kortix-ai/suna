import os
from dataclasses import dataclass
from typing import Optional

from core.utils.config import config, EnvMode

_DEFAULTS = {
    EnvMode.LOCAL: {
        "min_size": 5,
        "max_size": 20,
        "check_interval": 30,
        "parallel_create_limit": 3,
        "replenish_threshold": 0.3,
        "batch_delay": 5,
    },
    EnvMode.STAGING: {
        "min_size": 50,
        "max_size": 100,
        "check_interval": 20,
        "parallel_create_limit": 5,
        "replenish_threshold": 0.5,
        "batch_delay": 5,
    },
    EnvMode.PRODUCTION: {
        "min_size": 100, 
        "max_size": 300,
        "check_interval": 15,
        "parallel_create_limit": 10,
        "replenish_threshold": 0.7,
        "batch_delay": 10,
    },
}


def _get_default(key: str):
    env_mode = config.ENV_MODE or EnvMode.LOCAL
    return _DEFAULTS[env_mode][key]


@dataclass
class SandboxPoolConfig:
    min_size: int = 5
    max_size: int = 20
    replenish_threshold: float = 0.3
    check_interval: int = 30
    max_age: int = 3600
    enabled: bool = True
    parallel_create_limit: int = 3
    batch_delay: int = 10  # seconds to wait between batches to avoid rate limits
    
    @classmethod
    def from_env(cls) -> "SandboxPoolConfig":
        return cls(
            min_size=int(os.getenv("SANDBOX_POOL_MIN_SIZE", str(_get_default("min_size")))),
            max_size=int(os.getenv("SANDBOX_POOL_MAX_SIZE", str(_get_default("max_size")))),
            replenish_threshold=float(os.getenv("SANDBOX_POOL_REPLENISH_THRESHOLD", str(_get_default("replenish_threshold")))),
            check_interval=int(os.getenv("SANDBOX_POOL_CHECK_INTERVAL", str(_get_default("check_interval")))),
            max_age=int(os.getenv("SANDBOX_POOL_MAX_AGE", "3600")),
            enabled=os.getenv("SANDBOX_POOL_ENABLED", "true").lower() in ("true", "1", "yes"),
            parallel_create_limit=int(os.getenv("SANDBOX_POOL_PARALLEL_CREATE", str(_get_default("parallel_create_limit")))),
            batch_delay=int(os.getenv("SANDBOX_POOL_BATCH_DELAY", str(_get_default("batch_delay")))),
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
