"""
Utility modules for the setup package.
"""

from setup.utils.platform import IS_WINDOWS, check_command_exists, get_shell_arg
from setup.utils.docker import detect_docker_compose_command, format_compose_cmd, check_docker_running
from setup.utils.secrets import generate_encryption_key, generate_admin_api_key, generate_webhook_secret

__all__ = [
    "IS_WINDOWS",
    "check_command_exists",
    "get_shell_arg",
    "detect_docker_compose_command",
    "format_compose_cmd",
    "check_docker_running",
    "generate_encryption_key",
    "generate_admin_api_key",
    "generate_webhook_secret",
]
