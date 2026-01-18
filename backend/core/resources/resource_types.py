from enum import Enum
from typing import Literal

class ResourceType(str, Enum):
    SANDBOX = "sandbox"
class ResourceStatus(str, Enum):
    ACTIVE = "active"
    STOPPED = "stopped"
    DELETED = "deleted"
    POOLED = "pooled"

SandboxConfig = dict[str, str | None]
ResourceConfig = SandboxConfig
