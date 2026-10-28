#!/usr/bin/env python3
"""Pinned daily release controller. GitHub issue + immutable refs are the ledger.

Only scheduled midnight creates a candidate. Subsequent ticks resume that ledger;
no shell interpolation of GitHub content, admin merge, branch reset or rollback.
"""
import argparse
import base64
import json
import subprocess
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

REPO = 'kortix-ai/suna'
REQUIRED = ['full suite + quality gates', 'Frontend build', 'App runtime Go tests',
            'Sandbox agent build', 'Sandbox image apt packages', 'CLI binary smoke',
            'Self-host schema bootstrap', 'Desktop installer smoke',
            'GHSA lockfile advisory check', 'Dependency + secret scan',
            'Analyze (javascript-typescript)', 'Migration files are well-formed',
            'Squawk (zero-downtime lint) on new migrations', 'Migrations are immutable',
            'Migrations are sequential', 'Applies cleanly to a fresh DB', 'Schema matches migrations',
            'Trivy filesystem (vuln + secret + misconfig)', 'Trivy image re-scan',
            'Checkov (Terraform + K8s)', 'Hadolint (Dockerfiles)', 'Gitleaks (full history)',
            'fmt + validate', 'tflint', 'checkov', 'nacl admin-port audit']


def boundary(day):
    return datetime.fromisoformat(day).replace(tzinfo=ZoneInfo('Europe/Belgrade')).astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def cutoff_candidate(events, cutoff, tip):
    """Reconstruct branch value from server push times, never author-controlled dates.

    Require an observed staging push at/before cutoff to bound the history. If
    GitHub no longer exposes it, hold rather than guess from commit timestamps.
    """
    pushes = sorted([e for e in events if e.get('type') == 'PushEvent' and
                     e['payload'].get('ref') == 'refs/heads/staging'],
                    key=lambda e: e['created_at'], reverse=True)
    current = tip
    for event in pushes:
        payload = event['payload']
        if payload['head'] != current:
            raise RuntimeError('Staging push history incomplete or raced; cannot prove cutoff')
        if event['created_at'] <= cutoff:
            return current
        current = payload['before']
    raise RuntimeError('No server-timestamped staging history at cutoff; cannot safely snapshot')


def admission(checks, required, sha):
    latest = {}
    for check in sorted(checks, key=lambda c: c.get('started_at') or ''):
        if check.get('head_sha') == sha:
            latest[check['name']] = check
    return all(name in latest and latest[name]['status'] == 'completed' and
               latest[name]['conclusion'] == 'success' for name in required)


def reconcile(pr, day):
    if not (pr['merged'] and pr['base']['ref'] == 'dev' and
            f'Daily release repair: {day}' in (pr.get('body') or '')):
        raise ValueError('Repair must be a merged dev factory PR explicitly scoped to this daily release')
    return pr['merge_commit_sha']


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def api(path, method='GET', data=None):
    args = ['gh', 'api', f'repos/{REPO}/{path}', '--method', method]
    if data is not None:
        return json.loads(subprocess.check_output(args + ['--input', '-'], input=json.dumps(data), text=True))
    return json.loads(run(*args))


def pages(path, key=None):
    rows = []
    for page in range(1, 101):
        result = api(f'{path}{"&" if "?" in path else "?"}per_page=100&page={page}')
        chunk = result[key] if key else result
        rows.extend(chunk)
        if len(chunk) < 100:
            return rows
    raise RuntimeError('Pagination bound reached; refusing incomplete evidence')


def body(state):
    return 'Daily release state (machine-owned; history in comments).\n\n```json\n' + json.dumps(state, indent=2) + '\n```'


def save(issue, state):
    api(f'issues/{issue}', 'PATCH', {'body': body(state)})
    print(json.dumps(state, sort_keys=True))


def hold(issue, state, reason):
    if state.get('hold') != reason:
        api(f'issues/{issue}/comments', 'POST', {'body': f'HOLD: {reason}\n\nCandidate `{state["candidate"]}`; cutoff `{state["cutoff"]}`. No production bypass. Repair on dev through factory intake. The repair PR must contain `Daily release repair: {state["day"]}`. Resume with workflow input repair_pr; never include unrelated staging updates. Rollback is operator-only after the kortix-rollback state/DB compatibility check.'})
    state['hold'] = reason
    save(issue, state)


def workflow_runs(workflow, sha):
    return pages(f'actions/workflows/{workflow}/runs?head_sha={sha}', 'workflow_runs')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--snapshot', action='store_true')
    parser.add_argument('--repair-pr', type=int)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    now = datetime.now(ZoneInfo('Europe/Belgrade'))
    day = now.date().isoformat()
    cutoff = boundary(day)
    # The workflow concurrency group serializes writers. A durable open issue
    # also prevents tomorrow's candidate from overtaking today's held release.
    issues = pages('issues?state=all&creator=github-actions%5Bbot%5D&sort=created&direction=desc')
    ledgers = [i for i in issues if i['title'].startswith('Daily production release: ') and not i.get('pull_request')]
    active = [i for i in ledgers if i['state'] == 'open']
    if len(active) > 1:
        raise RuntimeError('Multiple active release ledgers: operator reconciliation required')
    if active:
        ledger = active[0]
        state = json.loads(ledger['body'].split('```json\n', 1)[1].split('\n```', 1)[0])
    else:
        if not args.snapshot or any(i['title'] == f'Daily production release: {day}' for i in ledgers):
            print('daily-release: no active candidate; no snapshot requested/already processed')
            return
        run('git', 'fetch', '--no-tags', 'origin', 'staging', 'prod')
        # The cron may be late. Read the first-parent staging history as of the
        # intended local midnight, using server push times, never commit dates.
        candidate = cutoff_candidate(pages('events'), cutoff, run('git', 'rev-parse', 'origin/staging'))
        if not candidate:
            raise RuntimeError('No staging commit at cutoff')
        previous = run('git', 'show', 'origin/prod:RELEASE_SOURCE_SHA')
        state = {'day': day, 'cutoff': cutoff, 'candidate': candidate, 'original': candidate,
                 'prod': run('git', 'rev-parse', 'origin/prod'), 'attempt': 0, 'phase': 'prepare'}
        if args.dry_run:
            print(json.dumps({**state, 'unchanged': previous == candidate})); return
        ledger = api('issues', 'POST', {'title': f'Daily production release: {day}', 'body': body(state)})
        if previous == candidate:
            state['phase'] = 'unchanged'
            save(ledger['number'], state)
            api(f'issues/{ledger["number"]}', 'PATCH', {'state': 'closed'})
            return
        # Immutable evidence ref: a create collision is an error, not a reset.
        api('git/refs', 'POST', {'ref': f'refs/tags/daily-candidate/{day}', 'sha': candidate})
        save(ledger['number'], state)
    issue = ledger['number']
    if state['phase'] in ['unchanged', 'verified'] and not args.dry_run:
        api(f'issues/{issue}', 'PATCH', {'state': 'closed'})
        return
    if args.dry_run:
        print(json.dumps(state)); return
    run('git', 'fetch', '--no-tags', 'origin', 'staging', 'prod', 'dev')
    refs = api('git/matching-refs/tags/daily-candidate/' + state['day'])
    if not refs:
        api('git/refs', 'POST', {'ref': f'refs/tags/daily-candidate/{state["day"]}', 'sha': state['original']})
        refs = api('git/matching-refs/tags/daily-candidate/' + state['day'])
    tag = next(r for r in refs if r['ref'] == f'refs/tags/daily-candidate/{state["day"]}')
    if tag['object']['sha'] != state['original']:
        raise RuntimeError('Immutable original candidate evidence differs from ledger')
    if args.repair_pr:
        if state['phase'] in ['deploy', 'merge']:
            raise RuntimeError('Cannot repair after production merge; assess rollback/fix-forward')
        if state['attempt'] >= 3:
            hold(issue, state, 'Three candidate attempts exhausted; owner intervention required'); return
        pr = api(f'pulls/{args.repair_pr}')
        fix = reconcile(pr, state['day'])
        reviews = pages(f'pulls/{args.repair_pr}/reviews')
        if not any(r['state'] == 'APPROVED' and r['commit_id'] == pr['head']['sha'] for r in reviews):
            raise RuntimeError('Repair lacks an approval of its exact final head')
        # Cherry-pick only the reviewed merge delta onto the pinned candidate.
        # A new PR into staging is reviewed/merged by existing protections. Do
        # not merge a moving staging tip or push directly to staging.
        branch = f'daily-repair/{state["day"]}-{args.repair_pr}'
        if state.get('repair_pr') == args.repair_pr:
            hold(issue, state, 'Repair already recorded; resume without repair_pr'); return
        state['repair_pr'] = args.repair_pr
        save(issue, state)
        run('git', 'fetch', 'origin', fix)
        run('git', 'switch', '--detach', state['candidate'])
        parents = run('git', 'rev-list', '--parents', '-n', '1', fix).split()
        run('git', 'cherry-pick', *(['-m', '1'] if len(parents) > 2 else []), fix)
        run('git', 'push', 'origin', f'HEAD:refs/heads/{branch}')
        repair_head = run('git', 'rev-parse', 'HEAD')
        run('gh', 'pr', 'create', '--repo', REPO, '--base', 'staging', '--head', branch,
            '--title', f'Daily release repair {state["day"]}: #{args.repair_pr}',
            '--body', f'Fix-only candidate `{repair_head}` from pinned `{state["candidate"]}` plus reviewed dev PR #{args.repair_pr}. Do not merge unrelated staging content. Daily controller will not deploy until this exact tree is staged and all gates rerun.')
        state['repair_head'] = repair_head
        hold(issue, state, f'Repair branch {branch} needs protected staging review and exact-tree deployment'); return
    if state.get('repair_head'):
        # Staging's merge must have exactly the fix-only tree, so a normal merge
        # that accidentally includes later staging changes cannot be admitted.
        staging = run('git', 'rev-parse', 'origin/staging')
        if run('git', 'rev-parse', staging + '^{tree}') != run('git', 'rev-parse', state['repair_head'] + '^{tree}'):
            hold(issue, state, 'Staging does not equal reviewed fix-only repair tree'); return
        state.update(candidate=staging, phase='prepare')
        state.pop('repair_head')
        state.pop('build_requested', None)
        state.pop('pr', None)
        state.pop('head', None)
        save(issue, state)
    if run('git', 'rev-parse', 'origin/prod') != state['prod'] and state['phase'] not in ['deploy', 'merge']:
        hold(issue, state, 'Production advanced outside this attempt; reconcile before continuing'); return
    if state['phase'] == 'prepare':
        if state['attempt'] >= 3:
            hold(issue, state, 'Three candidate attempts exhausted'); return
        # Existing build preflight proves immutable images exist. Reuse promote
        # (no dev leg) and the canonical release PR suite, not another pipeline.
        checks = pages(f'commits/{state["candidate"]}/check-runs', 'check_runs')
        manifests = ['Publish API manifest (staging)', 'Publish gateway manifest (staging)', 'Publish frontend manifest (staging)']
        if not admission(checks, manifests, state['candidate']):
            if not state.get('build_requested'):
                state['build_requested'] = True
                save(issue, state)
                run('gh', 'workflow', 'run', 'build-staging.yml', '--repo', REPO, '--ref', 'staging', '-f', f'sha={state["candidate"]}')
            hold(issue, state, 'Pinned staging manifests pending; inspect build-staging for candidate'); return
        state['attempt'] += 1
        state['phase'] = 'promote'
        save(issue, state)  # persist intent before dispatch; ambiguous dispatch holds
        notes = run('git', 'log', '--no-merges', '--format=- %s (%h)', f'{state["prod"]}..{state["candidate"]}')
        run('gh', 'workflow', 'run', 'promote.yml', '--repo', REPO, '--ref', 'dev',
            '-f', f'ref={state["candidate"]}', '-f', f'title=Daily release {state["day"]}',
            '-f', f'notes=### Improved\n{notes}', '-f', 'bump=patch', '-f', f'candidate_key={state["day"]}-{state["attempt"]}')
        return
    if state['phase'] == 'promote':
        prs = pages('pulls?state=open&base=prod')
        matches = []
        for pr in prs:
            if not pr['head']['ref'].endswith(f'-daily-{state["day"]}-{state["attempt"]}'):
                continue
            source = api(f'contents/RELEASE_SOURCE_SHA?ref={pr["head"]["sha"]}')
            if base64.b64decode(source['content']).decode().strip() == state['candidate']:
                matches.append(pr)
        if len(matches) != 1:
            hold(issue, state, 'Awaiting exactly one promote PR for the pinned source; inspect Promote workflow failures'); return
        pr = matches[0]
        state.update(pr=pr['number'], head=pr['head']['sha'], phase='validate')
        save(issue, state)
        # Force canonical build and migration workflows to run unfiltered on
        # the exact release branch; no changed-path skip is release evidence.
        for workflow in ['ci.yml', 'db-migrations.yml', 'security-scan.yml', 'terraform-ci.yml']:
            run('gh', 'workflow', 'run', workflow, '--repo', REPO, '--ref', pr['head']['ref'])
        return
    if state['phase'] == 'validate':
        pr = api(f'pulls/{state["pr"]}')
        if pr['head']['sha'] != state['head']:
            hold(issue, state, 'Release PR head changed after pinning; never merge stale evidence'); return
        checks = pages(f'commits/{state["head"]}/check-runs', 'check_runs')
        if not admission(checks, REQUIRED, state['head']):
            failed = [c['name'] for c in checks if c.get('head_sha') == state['head'] and c.get('conclusion') in ['failure', 'timed_out', 'cancelled', 'action_required']]
            reason = f'Required checks failed on {state["head"]}: {failed}' if failed else f'Required checks pending on {state["head"]}'
            hold(issue, state, reason); return
        for workflow in ['ci.yml', 'db-migrations.yml', 'security-scan.yml', 'terraform-ci.yml', 'tests-release.yml', 'codeql.yml']:
            runs = workflow_runs(workflow, state['head'])
            if not runs or runs[0]['status'] != 'completed' or runs[0]['conclusion'] != 'success':
                hold(issue, state, f'{workflow} has no successful latest exact-head run'); return
            jobs = pages(f'actions/runs/{runs[0]["id"]}/jobs?filter=latest', 'jobs')
            allowed_skips = {
                'security-scan.yml': set(),
                'terraform-ci.yml': set(),
                'tests-release.yml': {'contract / trunk verdict', 'request-rerun'},
                'codeql.yml': set(), 'ci.yml': set(), 'db-migrations.yml': set(),
            }
            bad = [j['name'] for j in jobs if j['conclusion'] != 'success' and not (j['conclusion'] == 'skipped' and j['name'] in allowed_skips[workflow])]
            if not jobs or bad:
                hold(issue, state, f'{workflow} jobs missing/not successful: {bad}'); return
        migrations = run('git', 'diff', '--name-only', state['prod'], state['candidate'], '--', 'packages/db/migrations')
        reviews = pages(f'pulls/{state["pr"]}/reviews')
        approved = [r for r in reviews if r['state'] == 'APPROVED' and r['commit_id'] == state['head']]
        if not approved:
            hold(issue, state, 'Final-head production approval required; no automatic approval or bypass'); return
        if migrations and not any('Migration costing: verified' in (r.get('body') or '') for r in approved):
            hold(issue, state, 'New migrations need read-only production costing; approving reviewer must attest Migration costing: verified'); return
        if pr.get('draft') or pr['state'] != 'open':
            hold(issue, state, 'Release PR is draft or closed'); return
        deploy_workflow = run('git', 'show', state['candidate'] + ':.github/workflows/deploy-prod.yml')
        if 'EXPECTED_SHA: ${{ inputs.expected_sha }}' not in deploy_workflow:
            hold(issue, state, 'Candidate lacks immutable deploy dispatch guard; reviewed repair required'); return
        # Prod is pinned. The release branch must include that exact ancestor;
        # otherwise GitHub's merge tree can differ from the tested head tree.
        run('git', 'fetch', 'origin', state['head'])
        run('git', 'merge-base', '--is-ancestor', state['prod'], state['head'])
        # GitHub enforces last-push approval and required checks. Never --admin,
        # auto-approve, or bypass protections. REST SHA guard prevents head race.
        if run('git', 'ls-remote', 'origin', 'refs/heads/prod').split()[0] != state['prod']:
            hold(issue, state, 'Production raced admission; refusing merge'); return
        state['phase'] = 'merge'
        save(issue, state)
        result = api(f'pulls/{state["pr"]}/merge', 'PUT', {'sha': state['head'], 'merge_method': 'merge'})
        if not result.get('merged'):
            hold(issue, state, f'Protected merge refused: {result.get("message")}'); return
        run('git', 'fetch', 'origin', result['sha'])
        if run('git', 'rev-parse', result['sha'] + '^{tree}') != run('git', 'rev-parse', state['head'] + '^{tree}'):
            hold(issue, state, 'Merged tree differs from tested head; stop before deployment and assess production race'); return
        state.update(phase='deploy', merge=result['sha'])
        save(issue, state)
        # GITHUB_TOKEN merge does not fire push workflows. Explicit dispatch on
        # prod; deploy-prod checks prod ref and the controller checks exact SHA.
        if run('git', 'ls-remote', 'origin', 'refs/heads/prod').split()[0] != state['merge']:
            hold(issue, state, 'Prod raced merge; refusing dispatch'); return
        run('gh', 'workflow', 'run', 'deploy-prod.yml', '--repo', REPO, '--ref', 'prod', '-f', f'expected_sha={state["merge"]}')
        return
    if state['phase'] == 'merge':
        pr = api(f'pulls/{state["pr"]}')
        if pr['head']['sha'] != state['head']:
            hold(issue, state, 'Release head changed during protected merge'); return
        if not pr['merged']:
            # Re-admit all evidence on the next tick before retrying merge.
            state['phase'] = 'validate'
            hold(issue, state, 'Protected merge pending/refused; final-head approval required, no bypass'); return
        run('git', 'fetch', 'origin', pr['merge_commit_sha'])
        if run('git', 'rev-parse', pr['merge_commit_sha'] + '^{tree}') != run('git', 'rev-parse', state['head'] + '^{tree}'):
            hold(issue, state, 'Recovered merge differs from tested tree; operator reconciliation required'); return
        state.update(phase='deploy', merge=pr['merge_commit_sha'])
        save(issue, state)
    if state['phase'] == 'deploy':
        runs = workflow_runs('deploy-prod.yml', state['merge'])
        if not runs or runs[0]['status'] != 'completed':
            hold(issue, state, f'Awaiting Deploy Prod for {state["merge"]}; if dispatch was interrupted, run deploy-prod.yml on prod with expected_sha={state["merge"]}'); return
        if runs[0]['conclusion'] != 'success':
            hold(issue, state, f'Deploy Prod failed: {runs[0]["html_url"]}; inspect rollback compatibility, never reverse migrations'); return
        version = run('git', 'show', state['merge'] + ':VERSION')
        import urllib.request
        for url in ['https://api.kortix.com/v1/health', 'https://gateway.kortix.com/health', 'https://kortix.com/api/health']:
            with urllib.request.urlopen(url, timeout=20) as response:
                health = json.load(response)
            if health.get('version') != version or health.get('commit') not in [state['candidate'], state['merge']]:
                hold(issue, state, f'Live identity mismatch at {url}; operator rollback assessment required'); return
        for url in ['https://kortix.com/', 'https://api.kortix.com/v1/health', 'https://gateway.kortix.com/health/live']:
            with urllib.request.urlopen(url, timeout=20) as response:
                if response.status != 200:
                    hold(issue, state, f'Read-only smoke failed at {url}'); return
        state.update(phase='verified', deploy=runs[0]['html_url'])
        state.pop('hold', None)
        save(issue, state)
        api(f'issues/{issue}', 'PATCH', {'state': 'closed'})


if __name__ == '__main__':
    main()
