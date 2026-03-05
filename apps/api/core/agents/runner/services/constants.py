import os
from concurrent.futures import ThreadPoolExecutor
import multiprocessing

REDIS_STREAM_TTL_SECONDS = 600
TIMEOUT_MCP_INIT = 3.0
TIMEOUT_PROJECT_METADATA = 2.0
TIMEOUT_DYNAMIC_TOOLS = 5.0
TIMEOUT_DB_QUERY = 3.0
STOP_CHECK_INTERVAL = float(os.getenv("AGENT_STOP_CHECK_INTERVAL", "2.0"))


def _calculate_thread_pool_size() -> int:
    cpu_count = multiprocessing.cpu_count()
    return max(cpu_count, 16)


SETUP_TOOLS_EXECUTOR = ThreadPoolExecutor(
    max_workers=_calculate_thread_pool_size(),
    thread_name_prefix="setup_tools"
)
