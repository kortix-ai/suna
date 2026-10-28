import unittest
from daily import boundary, admission, reconcile

class DailyTests(unittest.TestCase):
    def test_dst(self):
        self.assertEqual(boundary('2026-03-29'), '2026-03-28T23:00:00Z')
        self.assertEqual(boundary('2026-03-30'), '2026-03-29T22:00:00Z')
        self.assertEqual(boundary('2026-10-25'), '2026-10-24T22:00:00Z')
        self.assertEqual(boundary('2026-10-26'), '2026-10-25T23:00:00Z')
    def test_missing_skipped_failure_and_stale_never_admit(self):
        for conclusion in ['skipped', 'neutral', 'failure', None]:
            self.assertFalse(admission([{'name':'gate','head_sha':'abc','status':'completed','conclusion':conclusion}], ['gate'], 'abc'))
        self.assertFalse(admission([], ['gate'], 'abc'))
        self.assertFalse(admission([{'name':'gate','head_sha':'old','status':'completed','conclusion':'success'}], ['gate'], 'abc'))
    def test_success(self):
        self.assertTrue(admission([{'name':'gate','head_sha':'abc','status':'completed','conclusion':'success'}], ['gate'], 'abc'))
    def test_only_reviewed_fix_can_resume(self):
        pr={'merged':True,'base':{'ref':'dev'},'merge_commit_sha':'fix','body':'Daily release repair: 2026-10-29','changed_files':2}
        self.assertEqual(reconcile(pr, '2026-10-29'), 'fix')
        for field,value in [('merged',False), ('body','unrelated')]:
            bad={**pr,field:value}
            with self.assertRaises(ValueError): reconcile(bad, '2026-10-29')


class ControllerTests(unittest.TestCase):
    def setUp(self):
        from unittest.mock import patch
        self.patch = patch
        import daily
        self.daily = daily
        self.state = {'day':'2026-10-29','cutoff':boundary('2026-10-29'),'candidate':'candidate','original':'candidate','prod':'oldprod','attempt':1,'phase':'validate','pr':10,'head':'tested'}
        self.writes = []
        self.commands = []
    def api(self, path, method='GET', data=None):
        if method != 'GET':
            self.writes.append((path, method, data))
            if path.endswith('/merge'): return {'merged':True,'sha':'merged'}
            return {}
        if path.startswith('git/matching-refs/tags/daily-candidate/'): return [{'ref':'refs/tags/daily-candidate/2026-10-29','object':{'sha':'candidate'}}]
        if path == 'pulls/10': return {'head':{'sha':self.head},'draft':False,'state':'open'}
        raise AssertionError(path)
    def pages(self, path, key=None):
        if path.startswith('issues?'):
            return [{'number':7,'state':'open','title':'Daily production release: 2026-10-29','body':'```json\n'+__import__('json').dumps(self.state)+'\n```'}]
        if path.endswith('/reviews'): return [{'state':'APPROVED','commit_id':'tested'}]
        if '/jobs?' in path: return [{'name':'test','conclusion':'success'}]
        if 'check-runs' in path:
            return [{'name':n,'head_sha':'tested','status':'completed','conclusion':self.result} for n in self.daily.REQUIRED]
        raise AssertionError(path)
    def command(self,*args):
        self.commands.append(args)
        if args[:2] == ('git','show'): return 'EXPECTED_SHA: ${{ inputs.expected_sha }}'
        if args[:3] == ('git','rev-parse','origin/prod'): return 'oldprod'
        if args[:2] == ('git','ls-remote'):
            calls = sum(c[:2] == ('git','ls-remote') for c in self.commands)
            return ('oldprod' if calls == 1 else 'merged') + ' refs/heads/prod'
        return ''
    def exercise(self, head='tested', result='success'):
        self.head,self.result=head,result
        with self.patch('sys.argv',['daily.py']), self.patch.object(self.daily,'api',self.api), self.patch.object(self.daily,'pages',self.pages), self.patch.object(self.daily,'run',self.command), self.patch.object(self.daily,'workflow_runs',return_value=[{'id':1,'status':'completed','conclusion':'success'}]):
            self.daily.main()
    def test_success_merges_only_tested_sha_and_pins_deploy(self):
        self.exercise()
        merge = [w for w in self.writes if w[0].endswith('/merge')]
        self.assertEqual(merge[0][2]['sha'],'tested')
        self.assertTrue(any('expected_sha=merged' in c for c in self.commands))
    def test_head_race_never_merges(self):
        self.exercise(head='newhead')
        self.assertFalse(any(w[0].endswith('/merge') for w in self.writes))
    def test_failed_check_never_merges(self):
        self.exercise(result='failure')
        self.assertFalse(any(w[0].endswith('/merge') for w in self.writes))
    def test_overlap_fails_before_write(self):
        with self.patch('sys.argv',['daily.py']), self.patch.object(self.daily,'pages',return_value=[{'number':1,'state':'open','title':'Daily production release: a'}, {'number':2,'state':'open','title':'Daily production release: b'}]), self.patch.object(self.daily,'api',self.api):
            with self.assertRaisesRegex(RuntimeError,'Multiple active'):
                self.daily.main()
        self.assertEqual(self.writes,[])
    def test_dry_run_does_not_write_or_dispatch(self):
        with self.patch('sys.argv',['daily.py','--dry-run']), self.patch.object(self.daily,'pages',self.pages), self.patch.object(self.daily,'api',self.api), self.patch.object(self.daily,'run',self.command):
            self.daily.main()
        self.assertEqual(self.writes,[])
        self.assertEqual(self.commands,[])
    def test_prod_race_holds(self):
        self.state['prod']='unexpected'
        self.exercise()
        self.assertFalse(any(w[0].endswith('/merge') for w in self.writes))


class CutoffTests(unittest.TestCase):
    def test_server_push_time_not_commit_time(self):
        from daily import cutoff_candidate
        events = [{'type':'PushEvent','created_at':'2026-10-28T23:05:00Z','payload':{'ref':'refs/heads/staging','head':'later','before':'cutoff'}},
                  {'type':'PushEvent','created_at':'2026-10-28T22:05:00Z','payload':{'ref':'refs/heads/staging','head':'cutoff','before':'prior'}}]
        self.assertEqual(cutoff_candidate(events, boundary('2026-10-29'), 'later'), 'cutoff')
        with self.assertRaises(RuntimeError): cutoff_candidate(events, boundary('2026-10-29'), 'raced')
        with self.assertRaises(RuntimeError): cutoff_candidate(events[:1], boundary('2026-10-29'), 'later')


if __name__ == '__main__':
    unittest.main()
