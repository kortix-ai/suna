"""
Docker and Docker Compose utilities.
"""

import subprocess
from typing import Optional, List

from setup.utils.platform import IS_WINDOWS


def detect_docker_compose_command() -> Optional[List[str]]:
    """
    Detect whether 'docker compose' or 'docker-compose' is available.

    Returns:
        The command list (e.g., ['docker', 'compose']), or None if not found.
    """
    candidates = [
        ["docker", "compose"],
        ["docker-compose"],
    ]

    for cmd in candidates:
        try:
            subprocess.run(
                cmd + ["version"],
                capture_output=True,
                text=True,
                check=True,
                shell=IS_WINDOWS,
            )
            return cmd
        except (subprocess.CalledProcessError, FileNotFoundError):
            continue

    return None


def format_compose_cmd(compose_cmd: Optional[List[str]]) -> str:
    """
    Format a docker compose command list for display.

    Args:
        compose_cmd: The command list, e.g., ['docker', 'compose']

    Returns:
        Human-readable command string, e.g., 'docker compose'
    """
    return " ".join(compose_cmd) if compose_cmd else "docker compose"


def check_docker_running() -> tuple[bool, str]:
    """
    Check if the Docker daemon is running.

    Returns:
        Tuple of (is_running: bool, error_message: str)
    """
    try:
        subprocess.run(
            ["docker", "info"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True,
            shell=IS_WINDOWS,
        )
        return True, ""
    except subprocess.SubprocessError as e:
        return False, f"Docker is installed but not running: {e}"
    except FileNotFoundError:
        return False, "Docker is not installed"


def docker_compose_up(
    compose_cmd: List[str],
    services: Optional[List[str]] = None,
    detach: bool = True,
    build: bool = False,
) -> tuple[bool, str]:
    """
    Start Docker Compose services.

    Args:
        compose_cmd: The compose command list
        services: Optional list of specific services to start
        detach: Run in detached mode
        build: Build images before starting

    Returns:
        Tuple of (success: bool, error_message: str)
    """
    cmd = compose_cmd + ["up"]

    if detach:
        cmd.append("-d")
    if build:
        cmd.append("--build")
    if services:
        cmd.extend(services)

    try:
        subprocess.run(cmd, check=True, shell=IS_WINDOWS)
        return True, ""
    except subprocess.SubprocessError as e:
        return False, str(e)


def docker_compose_down(compose_cmd: List[str]) -> tuple[bool, str]:
    """
    Stop Docker Compose services.

    Args:
        compose_cmd: The compose command list

    Returns:
        Tuple of (success: bool, error_message: str)
    """
    try:
        subprocess.run(compose_cmd + ["down"], check=True, shell=IS_WINDOWS)
        return True, ""
    except subprocess.SubprocessError as e:
        return False, str(e)


def docker_compose_ps(compose_cmd: List[str]) -> tuple[bool, str, str]:
    """
    Get status of Docker Compose services.

    Args:
        compose_cmd: The compose command list

    Returns:
        Tuple of (success: bool, output: str, error_message: str)
    """
    try:
        result = subprocess.run(
            compose_cmd + ["ps"],
            capture_output=True,
            text=True,
            shell=IS_WINDOWS,
        )
        return True, result.stdout, ""
    except subprocess.SubprocessError as e:
        return False, "", str(e)
