/**
 * Commands as jobs, for the MCP run_command tool (./index.ts).
 *
 * One proxied daemon call gets ~50 s and one MCP request ~55 s, but a build or
 * a test run takes minutes. So a command never runs inside a request: it runs
 * detached in the sandbox, its stdout, stderr and exit code land in files, and
 * each run_command call waits on it for whatever the request budget allows. A
 * job still running when the budget ends comes back with its job_id and the
 * output so far; run_command with that job_id keeps waiting.
 *
 * Files live under ~/.cache, not /tmp: Platinum's /tmp is tmpfs in RAM.
 * setsid makes the job its own session, and cancel kills that session: GNU
 * timeout moves the command into its own process group, so killing the job's
 * group would leave the command running (verified on ubuntu:24.04, the sandbox
 * base image).
 */

export const JOB_DEFAULT_TIMEOUT_SECONDS = 600;
export const JOB_MAX_TIMEOUT_SECONDS = 86_400;
/** A job's directory (its output) is deleted by the next launch after this long. */
const JOB_KEEP_MINUTES = 1_440;
/** Output returned per stream: the tail, so a long log shows its end. */
export const JOB_TAIL_BYTES = 24_000;
/** Every job script starts here: env values are never shell-expanded, so the path is built in the shell. */
const JOB_DIR = 'export KMCP_DIR="${HOME:-/root}/.cache/kortix-mcp/jobs/$KMCP_JOB"\n';

export const JOB_LAUNCH = `${JOB_DIR}mkdir -p "$KMCP_DIR" || exit 1
find "$(dirname "$KMCP_DIR")" -mindepth 1 -maxdepth 1 -mmin +${JOB_KEEP_MINUTES} -exec rm -rf {} + 2>/dev/null
export KMCP_TIMEOUT_BIN="$(command -v timeout || true)"
S="$(command -v setsid || true)"
nohup $S bash -c '
  U="env -u KMCP_CMD -u KMCP_TIMEOUT -u KMCP_TIMEOUT_BIN -u KMCP_JOB -u KMCP_DIR"
  if [ -n "$KMCP_TIMEOUT_BIN" ]; then "$KMCP_TIMEOUT_BIN" -k 5 "$KMCP_TIMEOUT" $U bash -lc "$KMCP_CMD"; else $U bash -lc "$KMCP_CMD"; fi \\
    > "$KMCP_DIR/stdout" 2> "$KMCP_DIR/stderr" < /dev/null
  echo $? > "$KMCP_DIR/exit.tmp" && mv "$KMCP_DIR/exit.tmp" "$KMCP_DIR/exit"
' > /dev/null 2>&1 < /dev/null &
echo $! > "$KMCP_DIR/pid"`;

export const JOB_POLL = `${JOB_DIR}D="$KMCP_DIR"
[ -d "$D" ] || { echo missing; exit 0; }
if [ -f "$D/exit" ]; then echo "done $(cat "$D/exit")"; else echo running; fi
echo "$(wc -c < "$D/stdout" 2>/dev/null || echo 0) $(wc -c < "$D/stderr" 2>/dev/null || echo 0)"
# The tail of a stream: from a line start when the tail holds one, else marked.
tailof() {
  [ "$(wc -c < "$D/$1" 2>/dev/null || echo 0)" -gt "$KMCP_TAIL" ] || { cat "$D/$1" 2>/dev/null; return; }
  if [ "$(tail -c "$KMCP_TAIL" "$D/$1" | wc -l)" -gt 0 ]; then tail -c "$KMCP_TAIL" "$D/$1" | tail -n +2
  else printf '(started mid-line) '; tail -c "$KMCP_TAIL" "$D/$1"; fi
}
printf '%s\\n' "$KMCP_SEP"; tailof stdout
printf '\\n%s\\n' "$KMCP_SEP"; tailof stderr`;

export const JOB_CANCEL = `${JOB_DIR}P="$(cat "$KMCP_DIR/pid" 2>/dev/null)"
[ -n "$P" ] || { echo missing; exit 0; }
[ -f "$KMCP_DIR/exit" ] && { echo finished; exit 0; }
pkill -TERM -s "$P" 2>/dev/null || kill -TERM -- "-$P" 2>/dev/null
sleep 1
pkill -KILL -s "$P" 2>/dev/null
[ -f "$KMCP_DIR/exit" ] || echo cancelled > "$KMCP_DIR/exit"
echo cancelled`;

export type JobState = { state: 'missing' } | { state: 'running' | 'done'; exit: string | null; sizes: [number, number]; stdout: string; stderr: string };

export function parseJobPoll(stdout: string, sep: string): JobState {
  const [status = '', sizes = '', ...rest] = stdout.split('\n');
  if (status.trim() === 'missing') return { state: 'missing' };
  const body = rest.join('\n');
  const first = body.indexOf(`${sep}\n`);
  const second = body.indexOf(`\n${sep}\n`, first + sep.length);
  const [out, err] = [Number(sizes.split(' ')[0]) || 0, Number(sizes.split(' ')[1]) || 0];
  return {
    state: status.startsWith('done') ? 'done' : 'running',
    exit: status.startsWith('done') ? status.slice(5).trim() : null,
    sizes: [out, err],
    stdout: first < 0 || second < 0 ? '' : body.slice(first + sep.length + 1, second),
    stderr: second < 0 ? '' : body.slice(second + sep.length + 2).replace(/\n$/, ''),
  };
}

export function renderJob(jobId: string, job: Exclude<JobState, { state: 'missing' }>, elapsedMs: number): string {
  const truncated = (size: number) => (size > JOB_TAIL_BYTES ? ` (last ${JOB_TAIL_BYTES} of ${size} bytes; full: ~/.cache/kortix-mcp/jobs/${jobId}/)` : '');
  const head =
    job.state === 'done'
      ? job.exit === 'cancelled'
        ? 'status: cancelled'
        : `exit_code: ${job.exit}${job.exit === '124' ? ' (timed out)' : ''}`
      : `status: running (${Math.round(elapsedMs / 1000)} s in this call)\njob_id: ${jobId}\nThe command is still running. Call run_command with this session_id and job_id to keep waiting, or with cancel: true to stop it.`;
  return [
    head,
    job.stdout ? `stdout${truncated(job.sizes[0])}:\n${job.stdout}` : '',
    job.stderr ? `stderr${truncated(job.sizes[1])}:\n${job.stderr}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
