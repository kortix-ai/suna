import contextlib, hashlib, importlib.util, io, json, os, pathlib, tarfile, tempfile, unittest

spec = importlib.util.spec_from_file_location('restore', pathlib.Path(__file__).with_name('restore-workspace.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
PROJECT = '11111111-1111-4111-8111-111111111111'

class RestoreTests(unittest.TestCase):
 def setUp(self):
  self.tmp = tempfile.TemporaryDirectory()
  self.addCleanup(self.tmp.cleanup)
  self.base = pathlib.Path(self.tmp.name)
  self.source = self.base/'source'; self.source.mkdir()
  (self.source/'empty').mkdir()
  (self.source/'file').write_bytes(b'original bytes\x00')
  (self.source/'external').symlink_to('/mnt/source/archive')
  self.workspace = self.base/'workspace'; self.workspace.mkdir()
  entries=[]
  for p in [self.source, self.source/'empty', self.source/'file', self.source/'external']:
   st=p.lstat(); row=dict(path=str(p.relative_to(self.source)), type='symlink' if p.is_symlink() else 'directory' if p.is_dir() else 'file',mode=st.st_mode & 0o7777,mtime_ns=st.st_mtime_ns)
   if p.is_file(): row.update(size=st.st_size,sha256=hashlib.sha256(p.read_bytes()).hexdigest())
   if p.is_symlink(): row.update(target=os.readlink(p))
   entries.append(row)
  with tarfile.open(self.base/'workspace.tar.gz','w:gz') as t: t.add(self.source,arcname='.')
  self.manifest=dict(root='/workspace',entries=entries,archive_sha256=hashlib.sha256((self.base/'workspace.tar.gz').read_bytes()).hexdigest())
 def run_restore(self):
  (self.base/'manifest.json').write_text(json.dumps(self.manifest))
  with contextlib.redirect_stdout(io.StringIO()) as output:
   module.restore(str(self.base),PROJECT,str(self.workspace))
  return json.loads(output.getvalue())
 def test_files_empty_directories_and_resume(self):
  proof=self.run_restore()
  self.assertTrue((self.workspace/PROJECT/'empty').is_dir())
  self.assertTrue((self.workspace/PROJECT/'external').is_symlink())
  self.assertEqual(os.readlink(self.workspace/PROJECT/'external'),'/mnt/source/archive')
  self.assertTrue(proof['root_directory_verified'])
  self.assertTrue(proof['file_hashes_verified'])
  self.assertEqual(proof,self.run_restore())
 def test_missing_root_rejected(self):
  self.manifest['entries']=self.manifest['entries'][1:]
  with self.assertRaisesRegex(AssertionError,'Missing root'): self.run_restore()
  self.assertFalse((self.workspace/PROJECT).exists())
 def test_duplicate_path_rejected(self):
  self.manifest['entries'].append(self.manifest['entries'][0])
  with self.assertRaisesRegex(AssertionError,'Duplicate'): self.run_restore()
 def test_changed_destination_is_preserved_and_rejected(self):
  self.run_restore(); p=self.workspace/PROJECT/'file'; p.write_bytes(b'user changes')
  with self.assertRaises(AssertionError): self.run_restore()
  self.assertEqual(p.read_bytes(),b'user changes')
 def test_missing_empty_directory_rejected(self):
  self.run_restore(); (self.workspace/PROJECT/'empty').rmdir()
  with self.assertRaisesRegex(AssertionError,'inventory'): self.run_restore()
 def test_destination_root_symlink_rejected(self):
  (self.workspace/PROJECT).symlink_to(self.source,target_is_directory=True)
  with self.assertRaisesRegex(AssertionError,'real directory'): self.run_restore()
 def test_archive_corruption_rejected(self):
  (self.base/'workspace.tar.gz').write_bytes(b'corrupted')
  with self.assertRaises(AssertionError): self.run_restore()
  self.assertFalse((self.workspace/PROJECT).exists())
 def test_changed_symlink_target_is_rejected(self):
  self.run_restore(); p=self.workspace/PROJECT/'external';p.unlink();p.symlink_to('/mnt/other')
  with self.assertRaises(AssertionError):self.run_restore()

if __name__=='__main__': unittest.main()
