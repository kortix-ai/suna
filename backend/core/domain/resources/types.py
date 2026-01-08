"""Resource type definitions and constants."""

from enum import Enum
from typing import Literal

class ResourceType(str, Enum):
    """Types of resources that can be created."""
    SANDBOX = "sandbox"
    # Future types: DATABASE = "database", STORAGE = "storage", etc.

class ResourceStatus(str, Enum):
    """Status of a resource."""
    ACTIVE = "active"
    STOPPED = "stopped"
    DELETED = "deleted"

# Type hints for resource config structures
SandboxConfig = dict[str, str | None]
ResourceConfig = SandboxConfig  # Union type for future resource configs

