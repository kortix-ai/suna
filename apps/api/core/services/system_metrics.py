import os
from typing import Any, Dict

try:
    import psutil
except ImportError:
    psutil = None


def get_system_metrics() -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    if psutil is None:
        return {"error": "psutil not installed"}

    try:
        process = psutil.Process()
        mem = process.memory_info()
        out["memory_rss_mb"] = round(mem.rss / 1024 / 1024, 1)
        out["memory_vms_mb"] = round(mem.vms / 1024 / 1024, 1)
    except Exception as e:
        out["memory_error"] = str(e)

    try:
        vm = psutil.virtual_memory()
        out["memory_system_total_mb"] = round(vm.total / 1024 / 1024, 1)
        out["memory_system_available_mb"] = round(vm.available / 1024 / 1024, 1)
        out["memory_system_percent"] = round(vm.percent, 1)
    except Exception as e:
        out["memory_system_error"] = str(e)

    try:
        out["cpu_process_percent"] = round(process.cpu_percent(interval=0.1), 1)
    except Exception as e:
        out["cpu_process_error"] = str(e)

    try:
        out["cpu_system_percent"] = round(psutil.cpu_percent(interval=0.1), 1)
    except Exception as e:
        out["cpu_system_error"] = str(e)

    try:
        n = process.num_fds()
        out["open_fds"] = n
    except (AttributeError, OSError):
        try:
            out["open_fds"] = len(process.open_files())
        except Exception:
            out["open_fds"] = None

    try:
        du = psutil.disk_usage("/")
        out["disk_percent"] = round(du.percent, 1)
        out["disk_free_gb"] = round(du.free / 1024 / 1024 / 1024, 2)
    except Exception as e:
        out["disk_error"] = str(e)

    return out
