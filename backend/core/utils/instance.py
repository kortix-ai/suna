"""
Instance identification for multi-instance deployments.

Each worker/process gets a unique instance ID that persists for its lifetime.
This is critical for:
- Instance-aware cleanup of agent runs on startup/shutdown
- Distributed locking
- Proper handling of agent runs across multiple instances
"""
import uuid

# Generate unique instance ID per process/worker
# This ID is stable for the lifetime of the process
INSTANCE_ID = str(uuid.uuid4())[:8]


def get_instance_id() -> str:
    """Get the current instance's unique identifier."""
    return INSTANCE_ID

