/**
 * The shell tool floor every Kortix sandbox image installs: the standard layer
 * (platform default AND every custom template), the fast cold-boot image, and
 * the meta-agent image. Agents reach for these in plain bash — `rg`, `fd`,
 * `jq` — and a missing one costs a failed tool call plus a detour.
 *
 * OpenCode downloads its own ripgrep into its data dir for its search tool,
 * but that binary is not on PATH, so `rg` in the agent's shell still failed.
 *
 * Every package must resolve on Ubuntu 22.04, Ubuntu 24.04, and Debian 12:
 * the standard layer is appended to user Dockerfiles on any apt base, and one
 * missing package name fails that template's whole image build. Verified with
 * `apt-cache policy` on all three bases (2026-09-15). Excluded for that
 * reason: eza, git-delta, yq. Excluded for size (measured over the standard
 * floor on ubuntu:24.04): dnsutils (+42 MB), shellcheck (+40 MB). This list
 * adds ~53 MB.
 */
export const SANDBOX_SHELL_TOOL_PACKAGES = [
  'bat',
  'bc',
  'fd-find',
  'file',
  'fzf',
  'git-lfs',
  'htop',
  'iputils-ping',
  'jq',
  'less',
  'lsof',
  'moreutils',
  'nano',
  'netcat-openbsd',
  'openssh-client',
  'patch',
  'procps',
  'ripgrep',
  'rsync',
  'sqlite3',
  'tree',
  'unzip',
  'wget',
  'xz-utils',
  'zip',
  'zstd',
] as const;

/** Space-joined package names for an `apt-get install` line. */
export const SANDBOX_SHELL_TOOL_APT_LIST = SANDBOX_SHELL_TOOL_PACKAGES.join(' ');

/**
 * Debian ships `fd` as `fdfind` and `bat` as `batcat` (name clashes with older
 * packages). Link the upstream names unless the base image already provides
 * them, then fail the build if any headline tool does not run. Runs as root.
 * Single line, no heredoc: E2B's Dockerfile parser cannot read heredocs.
 */
export const SANDBOX_SHELL_TOOL_LINK_COMMAND =
  '(command -v fd >/dev/null || ln -s "$(command -v fdfind)" /usr/local/bin/fd)' +
  ' && (command -v bat >/dev/null || ln -s "$(command -v batcat)" /usr/local/bin/bat)' +
  ' && rg --version >/dev/null && fd --version >/dev/null && bat --version >/dev/null' +
  ' && jq --version >/dev/null && fzf --version >/dev/null';
