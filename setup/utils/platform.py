"""
Platform detection utilities.
"""

import platform
import subprocess
import shutil
from typing import Optional


IS_WINDOWS = platform.system() == "Windows"


def get_shell_arg() -> bool:
    """Returns the shell argument for subprocess calls based on platform."""
    return IS_WINDOWS


def check_command_exists(command: str) -> bool:
    """
    Check if a command exists in the system PATH.

    Args:
        command: The command name to check (e.g., 'git', 'docker')

    Returns:
        True if the command exists, False otherwise
    """
    # First try shutil.which for a quick check
    if shutil.which(command):
        return True

    # Fallback to running the command with --version
    try:
        # On Windows, some commands need shell=True
        cmd_to_check = command
        if IS_WINDOWS and command in ["python3", "pip3"]:
            cmd_to_check = command.replace("3", "")

        subprocess.run(
            [cmd_to_check, "--version"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True,
            shell=IS_WINDOWS,
        )
        return True
    except (subprocess.SubprocessError, FileNotFoundError, OSError):
        return False


def get_platform_info() -> dict:
    """
    Get information about the current platform.

    Returns:
        Dictionary with platform information
    """
    return {
        "system": platform.system(),
        "release": platform.release(),
        "version": platform.version(),
        "machine": platform.machine(),
        "python_version": platform.python_version(),
        "is_windows": IS_WINDOWS,
    }


def run_command(
    command: list,
    cwd: Optional[str] = None,
    capture_output: bool = True,
    check: bool = False,
    timeout: Optional[int] = None,
) -> subprocess.CompletedProcess:
    """
    Run a command with platform-appropriate settings.

    Args:
        command: List of command arguments
        cwd: Working directory for the command
        capture_output: Whether to capture stdout/stderr
        check: Whether to raise on non-zero exit
        timeout: Timeout in seconds

    Returns:
        CompletedProcess instance
    """
    return subprocess.run(
        command,
        cwd=cwd,
        capture_output=capture_output,
        text=True,
        check=check,
        shell=IS_WINDOWS,
        timeout=timeout,
    )
