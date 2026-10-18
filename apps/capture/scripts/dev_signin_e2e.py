"""`python3 -I apps/capture/scripts/dev_signin_e2e.py <kortix-capture binary>`

End to end on dev with the REAL app binary: Sign in with Kortix (device grant through
Cloudflare), approve as the account owner, sync connects, a probe upload lands, Kortix lists
the device. Uses the Kortix CLI's `dev` host token (~/.config/kortix/config.json), a
throwaway account and a scratch library; cleans up; never prints a token or a code."""
import json, os, re, subprocess, sys, tempfile, time, urllib.request, urllib.error
BIN = sys.argv[1]
cfg = json.load(open(os.path.expanduser('~/.config/kortix/config.json')))['hosts']['dev']
ROOT = cfg['url'].rstrip('/'); API = ROOT + '/v1'; TOK = cfg['token']
def call(m, p, b=None):
    r = urllib.request.Request(API + p, method=m, data=None if b is None else json.dumps(b).encode(),
        headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {TOK}', 'User-Agent': 'kortix-e2e'})
    try:
        with urllib.request.urlopen(r, timeout=60) as x: return x.status, json.loads(x.read() or b'null')
    except urllib.error.HTTPError as e:
        raw = e.read()
        try: return e.code, json.loads(raw)
        except Exception: return e.code, raw[:200]
def step(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + (f' — {detail}' if detail else ''), flush=True)
    if not ok: raise SystemExit(1)
lib = tempfile.mkdtemp(prefix='kc-e2e-'); env = dict(os.environ, KORTIX_CAPTURE_DIR=lib)
def app(*a, timeout=60):
    return subprocess.run([BIN, *a], env=env, capture_output=True, text=True, timeout=timeout)
acct = device = None; proc = None
try:
    s, b = call('POST', '/accounts', {'name': f'capture-e2e-{int(time.time())}'}); acct = b.get('account_id') or b.get('id')
    step('throwaway account', s in (200, 201))
    step('Capture on', call('PATCH', f'/accounts/{acct}/capture', {'enabled': True})[0] == 200)
    proc = subprocess.Popen([BIN, 'sync', 'setup', '--provider', 'kortix', '--issuer', ROOT, '--no-browser'],
                            env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    code = None; out = []
    t0 = time.time()
    while time.time() - t0 < 30:
        line = proc.stdout.readline()
        if not line: break
        out.append(line)
        m = re.search(r'user_code=([A-Z0-9-]+)', line)
        if m: code = m.group(1); break
    step('the app starts sign-in through Cloudflare (device authorize)', code is not None,
         re.sub(r'[A-Z]{4}-[0-9]{4}', '<code>', ''.join(out)[-300:]) if not code else '')
    s, b = call('POST', f'/capture/device/grants/{code}/approve', {'account_id': acct})
    step('approve the sign-in as the account owner', s == 200, f'{s} {b if s != 200 else ""}')
    try: rest, _ = proc.communicate(timeout=60)
    except subprocess.TimeoutExpired: proc.kill(); rest = '(timeout)'
    step('the app finishes sign-in and connects', proc.returncode == 0, rest[-300:] if proc.returncode else '')
    r = app('sync', 'test', timeout=120)
    step('a probe upload with the issued credentials', r.returncode == 0, (r.stdout + r.stderr)[-300:])
    st = app('sync', 'status', '--json', timeout=60)
    try: sj = json.loads(st.stdout)
    except Exception: sj = {}
    device = ((sj.get('kortix') or {}).get('device_id')) or sj.get('device_id')
    s, b = call('GET', f'/accounts/{acct}/capture/devices?scope=account')
    devs = b.get('devices', []) if isinstance(b, dict) else []
    step('Kortix lists the signed-in computer', s == 200 and len(devs) == 1, f'{s} {len(devs)} device(s)')
    device = devs[0]['device_id'] if devs else device
finally:
    if proc and proc.poll() is None: proc.kill()
    if acct and device: print('cleanup revoke device', call('DELETE', f'/accounts/{acct}/capture/devices/{device}')[0])
    if acct: print('cleanup Capture off', call('PATCH', f'/accounts/{acct}/capture', {'enabled': False})[0])
    subprocess.run(['rm', '-rf', lib])
