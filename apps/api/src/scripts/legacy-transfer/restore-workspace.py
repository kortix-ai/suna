import os,json,tarfile,pathlib,stat,hashlib,subprocess,tempfile,shutil

def restore(base, project, workspace="/workspace"):
 target=workspace+'/'+project
 assert len(project)==36 and all(c in '0123456789abcdef-' for c in project)
 with open(base+'/manifest.json') as manifest_file: m=json.load(manifest_file)
 with open(base+'/workspace.tar.gz','rb') as f: assert hashlib.file_digest(f,'sha256').hexdigest()==m['archive_sha256']
 assert m['root']=='/workspace'
 entries=m['entries']
 assert len({e['path'] for e in entries})==len(entries), 'Duplicate manifest paths'
 assert sum(e['path']=='.' and e['type']=='directory' for e in entries)==1, 'Missing root directory'
 for e in m['entries']:
  p=pathlib.PurePosixPath(e['path'])
  assert str(p)==e['path'] and not p.is_absolute() and '..' not in p.parts and e['type'] in ['file','directory']
 def verify(root):
  assert stat.S_ISDIR(os.lstat(root).st_mode), 'Root is not a real directory'
  actual={'.'}
  for path,dirs,files in os.walk(root):
   for name in dirs+files: actual.add(os.path.relpath(os.path.join(path,name),root))
  assert actual=={e['path'] for e in m['entries']}, 'Destination inventory differs from source'
  for e in m['entries']:
   p=os.path.join(root,e['path']); st=os.lstat(p)
   assert (stat.S_ISDIR(st.st_mode) if e['type']=='directory' else stat.S_ISREG(st.st_mode))
   assert stat.S_IMODE(st.st_mode)==e['mode'] and st.st_mtime_ns==e['mtime_ns']
   if e['type']=='file':
    assert st.st_size==e['size']
    with open(p,'rb') as f: assert hashlib.file_digest(f,'sha256').hexdigest()==e['sha256']
 if not os.path.lexists(target):
  staging=tempfile.mkdtemp(prefix='.legacy-restore-'+project+'-',dir=workspace)
  try:
   with tarfile.open(base+'/workspace.tar.gz') as t:
    for e in t.getmembers():
     p=pathlib.PurePosixPath(e.name)
     if p.is_absolute() or '..' in p.parts or not (e.isdir() or e.isfile()): raise RuntimeError('Unsupported archive entry; migration blocked')
    t.extractall(staging,filter='data')
   for e in reversed(m['entries']):
    p=os.path.join(staging,e['path']);os.chmod(p,e['mode']);os.utime(p,ns=(e['mtime_ns'],e['mtime_ns']))
   verify(staging)
   if os.path.lexists(target):raise RuntimeError('Target appeared during restore')
   os.rename(staging,target);staging=None
  finally:
   if staging:shutil.rmtree(staging)
 verify(target)
 r=subprocess.run(['git','-C',workspace,'rev-parse','--git-path','info/exclude'],capture_output=True,text=True)
 if r.returncode==0:
  exclude=r.stdout.strip()
  if not os.path.isabs(exclude):exclude=os.path.join(workspace,exclude)
  with open(exclude,'a') as f:f.write('\n/'+project+'/\n')
  assert subprocess.run(['git','-C',workspace,'check-ignore','-q',project+'/']).returncode==0
 print(json.dumps({'restored_entries':len(m['entries']),'regular_files':sum(e['type']=='file' for e in m['entries']),'target':target,'metadata_verified':True,'root_directory_verified':True,'file_hashes_verified':True,'exact_inventory_verified':True,'git_excluded':r.returncode==0,'uid_policy':'destination runtime user; originals retained in manifest'}))

if __name__ == "__main__":
 restore(os.environ["TRANSFER_DIR"], os.environ["LEGACY_PROJECT_ID"])
