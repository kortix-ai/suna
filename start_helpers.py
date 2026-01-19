import platform
import subprocess

IS_WINDOWS = platform.system() == "Windows"


def detect_docker_compose_command():
    """
    Detect whether 'docker compose' or 'docker-compose' is available.

    Returns:
        list[str] | None: The command list, e.g. ['docker', 'compose'], or None if not found.
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


def format_compose_cmd(compose_cmd):
    """
    Formats a docker compose command list for display.

    Args:
        compose_cmd: list[str] | None

    Returns:
        str: Human-readable command string, e.g. 'docker compose'.
    """
    return " ".join(compose_cmd) if compose_cmd else "docker compose"

