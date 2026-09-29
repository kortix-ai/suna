"""
Shared helpers for running LibreOffice headless on Linux and macOS.
"""

import os
import platform
import subprocess
from pathlib import Path

MACRO_DIR = {
    "Darwin": "~/Library/Application Support/LibreOffice/4/user/basic/Standard",
    "Linux": "~/.config/libreoffice/4/user/basic/Standard",
}

TIMEOUT_CMD = {"Darwin": "gtimeout", "Linux": "timeout"}


def soffice_env() -> dict[str, str]:
    env = os.environ.copy()
    env["SAL_USE_VCLPLUGIN"] = "svp"
    return env


def macro_dir() -> Path:
    return Path(os.path.expanduser(MACRO_DIR.get(platform.system(), MACRO_DIR["Linux"])))


def has_timeout_cmd() -> str | None:
    cmd = TIMEOUT_CMD.get(platform.system())
    if not cmd:
        return None
    try:
        subprocess.run([cmd, "--version"], capture_output=True, timeout=1, check=False)
        return cmd
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None


def run_soffice(args: list[str], timeout: int | None = None) -> subprocess.CompletedProcess[str]:
    cmd = ["soffice", *args]

    if timeout is not None:
        timeout_cmd = has_timeout_cmd()
        if timeout_cmd:
            cmd = [timeout_cmd, str(timeout), *cmd]

    return subprocess.run(cmd, capture_output=True, text=True, env=soffice_env())
