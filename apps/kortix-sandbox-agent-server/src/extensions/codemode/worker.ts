/**
 * The codemode sandbox worker, a second `bun build --compile` entrypoint (scripts/build.sh).
 * In a compiled binary pi starts it by this exact path (pi-coding-agent `getCodemodeWorkerSpecifier`),
 * so the file must stay at `src/extensions/codemode/worker.ts`.
 */
import '@earendil-works/pi-codemode/worker'
