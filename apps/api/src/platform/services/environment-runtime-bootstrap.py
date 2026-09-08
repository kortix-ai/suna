import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request


def bootstrap(root=Path('/'), reuse_workspace=False):
    state = root / 'opt/kortix'
    state.mkdir(parents=True, exist_ok=True)
    lock = (state / 'environment-bootstrap.lock').open('w')
    fcntl.flock(lock, fcntl.LOCK_EX)
    env = dict(os.environ)
    for source in [root / 'etc/environment', root / 'etc/pt-env']:
        if source.exists():
            for line in source.read_text().splitlines():
                key, sep, value = line.partition('=')
                if sep and key.startswith('KORTIX_') and not env.get(key):
                    env[key] = value.strip('"\'')
    port = int(env.get('KORTIX_SERVICE_PORT', '8000'))

    def health():
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/kortix/health', timeout=2) as response:
                return json.load(response)
        except Exception:
            return {}

    def execution_ready(value):
        return value.get('workload') == 'environment' and value.get('opencode') == 'disabled' and value.get('runtimeReady') is True

    if execution_ready(health()):
        print(json.dumps({'ready': True, 'changed': False}))
        return

    api = env.get('KORTIX_API_URL', '').rstrip('/')
    if api.endswith('/v1'):
        api = api[:-3]
    token = env.get('KORTIX_TOKEN')
    if not api or not token:
        raise RuntimeError('Environment API identity is missing')
    headers = {'Authorization': 'Bearer ' + token, 'User-Agent': 'kortix-environment-bootstrap/1'}
    request = urllib.request.Request(api + '/v1/runtime-assets/manifest', headers=headers)
    with urllib.request.urlopen(request, timeout=30) as response:
        manifest = json.load(response)
    runtime = state / 'environment-runtime'
    runtime.mkdir(exist_ok=True)
    entrypoint = root / 'usr/local/bin/kortix-entrypoint'
    entrypoint.parent.mkdir(parents=True, exist_ok=True)

    def download(component, destination):
        asset = manifest['components'][component]
        path, digest = asset['path'], asset['sha256']
        if not path.startswith('/v1/runtime-assets/') or len(digest) != 64:
            raise RuntimeError('Invalid runtime asset manifest')
        fd, name = tempfile.mkstemp(dir=destination.parent)
        try:
            checksum = hashlib.sha256()
            request = urllib.request.Request(api + path, headers=headers)
            with os.fdopen(fd, 'wb') as output, urllib.request.urlopen(request, timeout=120) as response:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    checksum.update(chunk)
                    output.write(chunk)
            if checksum.hexdigest() != digest:
                raise RuntimeError(component + ' digest mismatch')
            os.chmod(name, 0o755)
            os.replace(name, destination)
            return digest
        finally:
            Path(name).unlink(missing_ok=True)

    floor = runtime / 'agent.floor'
    agent_sha = download('agent', floor)
    staged_entrypoint = runtime / 'entrypoint.next'
    download('entrypoint', staged_entrypoint)
    env.update({
        'KORTIX_WORKLOAD': 'environment', 'KORTIX_WARM_SEED': '0',
        'KORTIX_BOOTSTRAP_OPENCODE_SESSION': '0', 'KORTIX_COMPILED_BOOT_MODE': 'off',
        'KORTIX_AGENT_BIN': str(floor), 'KORTIX_AGENT_STATE_DIR': str(runtime),
        'KORTIX_SESSION_FRESH': '0', 'KORTIX_SESSION_BRANCH_RESTORE': '1',
        'KORTIX_ENVIRONMENT_REUSE_WORKSPACE': '1' if reuse_workspace else '0',
    })
    if root == Path('/'):
        user = pwd.getpwnam('kortix')
        os.chown(runtime, user.pw_uid, user.pw_gid)
        os.chown(floor, user.pw_uid, user.pw_gid)

    supervisors, agents = [], []
    proc_root = root / 'proc'
    for proc in proc_root.glob('[0-9]*'):
        try:
            args = [part.decode() for part in (proc / 'cmdline').read_bytes().split(b'\0') if part]
            if int(proc.name) == os.getpid():
                continue
            paths = {str(root / p) for p in ['usr/local/bin/kortix-agent', 'opt/kortix/agent.current', 'opt/kortix/agent.prev', 'opt/kortix/environment-runtime/agent.current', 'opt/kortix/environment-runtime/agent.floor']}
            if str(entrypoint) in args:
                supervisors.append(int(proc.name))
            elif paths.intersection(args) or any(Path(arg).name == 'opencode' and i + 1 < len(args) and args[i + 1] == 'serve' for i, arg in enumerate(args)):
                agents.append(int(proc.name))
        except (OSError, UnicodeError):
            continue

    for pid in supervisors + agents:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    def alive(pid):
        try:
            os.kill(pid, 0)
            status = proc_root / str(pid) / 'status'
            if status.exists() and '\nState:\tZ' in '\n' + status.read_text():
                return False
            return True
        except ProcessLookupError:
            return False

    deadline = time.monotonic() + 10
    while (health() or any(alive(pid) for pid in supervisors + agents)) and time.monotonic() < deadline:
        time.sleep(0.1)
    for pid in supervisors + agents:
        if alive(pid):
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    if health():
        raise RuntimeError('Previous daemon did not stop; workspace remains intact')

    os.replace(staged_entrypoint, entrypoint)
    marker = state / 'workload.next'
    marker.write_text('environment\n')
    os.replace(marker, state / 'workload')
    for name in ['agent.current', 'agent.next', 'agent.prev', 'agent.pinned', 'agent.current.sha256', 'agent.next.sha256', 'agent.prev.sha256']:
        (runtime / name).unlink(missing_ok=True)
    with (state / 'environment-bootstrap.log').open('ab') as log:
        subprocess.Popen([str(entrypoint)], env=env, cwd=str(root), stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        if execution_ready(health()):
            print(json.dumps({'ready': True, 'changed': True, 'agentSha256': agent_sha}))
            return
        time.sleep(0.25)
    raise RuntimeError('Environment daemon did not become ready')


if __name__ == '__main__':
    try:
        bootstrap(Path(sys.argv[1]) if len(sys.argv) > 1 else Path('/'), len(sys.argv) > 2 and sys.argv[2] == 'reuse')
    except Exception as error:
        print(json.dumps({'ready': False, 'error': str(error)}))
        sys.exit(1)
