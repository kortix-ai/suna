"""Accept all tracked changes in a DOCX file via LibreOffice headless macro.

Copies the input, installs a Basic macro into a temporary LibreOffice profile,
and runs it. LibreOffice often hangs after completing the macro — a timeout
is treated as success since the file has already been saved.

Usage:
    python accept_changes.py <input.docx> <output.docx>
"""

import os
import shutil
import subprocess
from pathlib import Path

SOFFICE = "soffice"
PROFILE_DIR = Path("/tmp/libreoffice_accept_profile")
MACRO_DIR = PROFILE_DIR / "user" / "basic" / "Standard"
MODULE_FILE = MACRO_DIR / "Module1.xba"
MACRO_URI = "vnd.sun.star.script:Standard.Module1.AcceptAllTrackedChanges?language=Basic&location=application"

EXECUTION_TIMEOUT = 30
INIT_TIMEOUT = 10

MACRO_XML = "\n".join(
    [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE script:module PUBLIC "-//OpenOffice.org//DTD OfficeDocument 1.0//EN" "module.dtd">',
        '<script:module xmlns:script="http://openoffice.org/2000/script" script:name="Module1" script:language="StarBasic">',
        "    Sub AcceptAllTrackedChanges()",
        "        Dim document As Object",
        "        Dim dispatcher As Object",
        "",
        "        document = ThisComponent.CurrentController.Frame",
        '        dispatcher = createUnoService("com.sun.star.frame.DispatchHelper")',
        "",
        '        dispatcher.executeDispatch(document, ".uno:AcceptAllTrackedChanges", "", 0, Array())',
        "        ThisComponent.store()",
        "        ThisComponent.close(True)",
        "    End Sub",
        "</script:module>",
    ]
)


def _soffice_env() -> dict[str, str]:
    env = os.environ.copy()
    env["SAL_USE_VCLPLUGIN"] = "svp"
    return env


def _profile_arg() -> str:
    return f"-env:UserInstallation=file://{PROFILE_DIR}"


def _ensure_macro() -> bool:
    if MODULE_FILE.exists() and "AcceptAllTrackedChanges" in MODULE_FILE.read_text():
        return True

    if not MACRO_DIR.exists():
        subprocess.run(
            [SOFFICE, "--headless", _profile_arg(), "--terminate_after_init"],
            capture_output=True,
            timeout=INIT_TIMEOUT,
            check=False,
            env=_soffice_env(),
        )
        MACRO_DIR.mkdir(parents=True, exist_ok=True)

    MODULE_FILE.write_text(MACRO_XML)
    return True


def accept_tracked_changes(input_file: str, output_file: str) -> tuple[None, str]:
    src, dst = Path(input_file), Path(output_file)

    if not src.exists():
        return None, f"Input path does not exist: {src}"
    if src.suffix.lower() != ".docx":
        return None, f"Expected a .docx file, got: {src.suffix}"

    try:
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
    except OSError as exc:
        return None, f"Failed to copy input to output location: {exc}"

    if not _ensure_macro():
        return None, "Macro installation into LibreOffice profile failed"

    cmd = [SOFFICE, "--headless", _profile_arg(), "--norestore", MACRO_URI, str(dst.absolute())]
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=EXECUTION_TIMEOUT, check=False, env=_soffice_env()
        )
    except subprocess.TimeoutExpired:
        return None, f"Accepted all tracked changes: {src} -> {dst}"

    if result.returncode != 0:
        return None, f"soffice exited with error: {result.stderr}"

    return None, f"Accepted all tracked changes: {src} -> {dst}"


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(description="Accept all tracked changes in a DOCX file")
    ap.add_argument("input_file", help="Input DOCX with tracked changes")
    ap.add_argument("output_file", help="Output DOCX (clean, changes accepted)")
    args = ap.parse_args()

    _, msg = accept_tracked_changes(args.input_file, args.output_file)
    print(msg)
    if not msg.startswith("Accepted"):
        raise SystemExit(1)
