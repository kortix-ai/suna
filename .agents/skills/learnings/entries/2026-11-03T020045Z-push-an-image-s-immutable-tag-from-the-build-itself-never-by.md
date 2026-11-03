---
recorded: 2026-11-03T02:00:45Z
incident_date: 2026-11-03
---
# Push an image's immutable tag from the build itself, never by reading back a moving tag

**Rule:** A build pushes its immutable tag (`:dev-<sha8>`, `:staging-<sha>`) in the same push as any moving tag. A later step that reads a moving tag (`:dev-latest`) back from Docker Hub to name the build's image can get the previous push, because the registry serves tag reads with a delay.

**Trigger surface:** `.github/workflows/deploy-*.yml` and `build-*.yml`: any `docker buildx imagetools create` whose source is a moving tag that the same job just pushed.

**Incident:** 2026-11-03, deploy-dev run 41560287370 for 68fd3646bc. The frontend job pushed `:dev-latest` at 01:35:58, and its retag step read `:dev-latest` back at 01:36:03 and tagged `:dev-68fd3646`. That tag held the previous run's image: its server files had mtime 01:19:14, the d34d3283a5 build. ECS rolled it with the new version env, so `/api/health` answered `version 0.14.17-dev.68fd3646` with `commit d34d3283…`. The frontend verify step waited 160 checks for the commit and was cancelled after 15 min. The API build already pushed `:dev-<sha8>` directly for this reason (comment in `deploy-dev.yml` build-api); the frontend did not.

**Enforcement:** the dev frontend build now pushes `:dev-<sha8>` itself. The verify step's commit check (`deploy-dev.yml`, "Verify ECS health…") is what caught it. To build: a workflow test that fails on `imagetools create` from a `-latest` source in the job that pushed it.
