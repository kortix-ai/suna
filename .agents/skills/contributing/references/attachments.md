# Attaching images and videos with `gh --attach`

`gh` ≥ 2.99.0 uploads local images and videos to GitHub's attachment storage. The file gets
a `https://github.com/user-attachments/assets/<uuid>` URL, the same storage as drag-and-drop
in the web UI. This is the only way to attach media in this repo. Every attachment goes
through `--attach`, never through a commit, branch, gist, or release asset.

## Commands

`--attach <path>[#alt text]` is repeatable (up to 50 files per command). It works on:

```bash
gh pr create  … --attach ./output/pr/demo.mp4
gh pr edit    <pr> --attach ./output/pr/demo.mp4
gh pr comment <pr> --attach ./output/pr/after.png --body "State after the fix"
gh issue create / edit / comment   # same flag
```

## Where the attachment lands

- **The body references the file** (`![Demo](./output/pr/demo.mp4)`, inline style): `gh`
  replaces that reference with the uploaded URL. A video becomes a bare URL on its own line,
  which GitHub renders as a player. An image keeps its alt text.
- **The body does not reference it:** `gh` appends it to the end of the body. An image is
  appended as `![alt](url)`, and a video as a bare URL.
- **`gh pr edit --attach` without `--body`/`--body-file`:** keeps the current body and
  appends.
- Matching uses the **absolute path**. Relative paths resolve against the current working
  directory, not the body file's directory. Run `gh` from the repo root when the body uses
  repo-relative paths.
- A reference-style embed of a video (`![x][ref]` with `[ref]: ./demo.mp4`) is refused. Use
  inline style.

## Limits

| Kind | Extensions | Max size |
| --- | --- | --- |
| Image | `.png` `.jpg` `.jpeg` `.gif` `.webp` `.svg` | 10 MB |
| Video | `.mp4` `.mov` `.webm` | 100 MB |

Empty files and other extensions are refused before upload. Video has no alt text.

## Token types

Uploads need **write access** to the repository and one of these tokens:

| Prefix | Kind | Works |
| --- | --- | --- |
| `gho_` | `gh auth login` OAuth | yes |
| `ghp_` | classic PAT | yes |
| `github_pat_` | fine-grained PAT | yes |
| `ghs_` | GitHub App installation token, including Actions `GITHUB_TOKEN` | no. The upload endpoint returns 404 (cli/cli#14309) |
| `ghu_` | GitHub App user-to-server token | no. `gh` refuses it before sending |

Find the prefix without printing the token: `gh auth token | cut -c1-4`. If the token
cannot attach, stop and report the blocker. Media always goes through `--attach`, never a
commit or a branch.

## Failure modes

- **Some files upload and others fail:** the PR is still created or updated with the files
  that uploaded. The command exits non-zero, and `pr create` still prints the URL. Read
  the body back (`gh pr view <pr> --json body`) and re-run `gh pr edit --attach` for the
  missing file.
- **`attaching files requires write access to the repository`:** the token's user cannot
  push to `kortix-ai/suna`.
- **The same file twice in one command:** refused.
- **GitHub Enterprise Server:** not supported. github.com only.

## Visibility

`kortix-ai/suna` is public, so anyone with an attachment URL can open it. Record synthetic
data only.
