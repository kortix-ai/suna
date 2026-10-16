#!/usr/bin/env python3
"""Build/package helper: fetch a checksum-pinned official ONNX Runtime library.
No model, user data, credentials, or inference requests. Python is build-only.
"""
import argparse
import hashlib
from pathlib import Path
import shutil
import tarfile
import urllib.request
import zipfile

ASSETS = {
    "macos-arm64": ("onnxruntime-osx-arm64-1.23.2.tgz", "b4d513ab2b26f088c66891dbbc1408166708773d7cc4163de7bdca0e9bbb7856", "libonnxruntime.1.23.2.dylib"),
    "macos-x86_64": ("onnxruntime-osx-x86_64-1.23.2.tgz", "d10359e16347b57d9959f7e80a225a5b4a66ed7d7e007274a15cae86836485a6", "libonnxruntime.1.23.2.dylib"),
    "windows-x86_64": ("onnxruntime-win-x64-1.23.2.zip", "0b38df9af21834e41e73d602d90db5cb06dbd1ca618948b8f1d66d607ac9f3cd", "onnxruntime.dll"),
    "linux-x86_64": ("onnxruntime-linux-x64-1.23.2.tgz", "1fa4dcaef22f6f7d5cd81b28c2800414350c10116f5fdd46a2160082551c5f9b", "libonnxruntime.so.1.23.2"),
}

def digest(path):
    with path.open("rb") as file:
        hash = hashlib.sha256()
        while chunk := file.read(128 * 1024): hash.update(chunk)
        return hash.hexdigest()

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--platform", choices=ASSETS, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    args = parser.parse_args()
    destination = args.destination.resolve()
    destination.mkdir(parents=True, exist_ok=True)
    name, expected, library = ASSETS[args.platform]
    cache = destination / ".privacy-runtime-cache"
    cache.mkdir(exist_ok=True)
    archive = cache / name
    if not archive.exists() or digest(archive) != expected:
        temporary = archive.with_suffix(".download")
        with urllib.request.urlopen(f"https://github.com/microsoft/onnxruntime/releases/download/v1.23.2/{name}", timeout=60) as source, temporary.open("wb") as target:
            shutil.copyfileobj(source, target, 128 * 1024)
        if digest(temporary) != expected:
            temporary.unlink()
            raise SystemExit("ONNX Runtime archive checksum mismatch")
        temporary.replace(archive)
    notices = []
    found = False
    if name.endswith(".zip"):
        with zipfile.ZipFile(archive) as bundle:
            for member in bundle.infolist():
                base = Path(member.filename).name
                if base == library:
                    with bundle.open(member) as source, (destination / library).open("wb") as target:
                        shutil.copyfileobj(source, target, 128 * 1024)
                    found = True
                elif base.lower() in {"license", "license.txt", "thirdpartynotices.txt"}:
                    notices.append(bundle.read(member).decode("utf-8", errors="replace"))
    else:
        with tarfile.open(archive) as bundle:
            for member in bundle:
                if not member.isfile():
                    continue
                base = Path(member.name).name
                if base == library:
                    with bundle.extractfile(member) as source, (destination / library).open("wb") as target:
                        shutil.copyfileobj(source, target, 128 * 1024)
                    found = True
                elif base.lower() in {"license", "license.txt", "thirdpartynotices.txt"}:
                    notices.append(bundle.extractfile(member).read().decode("utf-8", errors="replace"))
    if not found or not notices:
        raise SystemExit("Pinned archive lacks runtime or license notices")
    (destination / "privacy-runtime-notices.txt").write_text("\n\n".join(notices))
    print(f"PRIVACY_RUNTIME_OK platform={args.platform} library={library} sha256={digest(destination / library)}")

if __name__ == "__main__":
    main()
