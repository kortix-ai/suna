# syntax=docker/dockerfile:1.7
#
# Kortix sandbox image — the base Daytona snapshot for every project
# session. Bakes:
#   - git + ca-certificates + curl  (project repo materialization)
#   - uv + uv-managed Python       (Python tools resolve dependencies per command)
#   - pnpm + Node.js + npm         (pinned runtime toolchain)
#   - kortix-agent                  (compiled daemon from
#                                    apps/kortix-sandbox-agent-server)
#   - kortix                        (compiled admin CLI from apps/cli — the
#                                    in-sandbox `kortix cr open`, `secrets`,
#                                    `sessions`, … surface every agent uses)
#
# Three-stage build:
#   1. `builder`     — installs the daemon's deps and runs
#                      `bun build --compile` for the target image architecture
#                      to produce dist/kortix-agent.
#   2. `cli-builder` — assembles a minimal workspace (apps/cli + the two
#                      `@kortix/*` packages it imports) and compiles the
#                      `kortix` CLI to a self-contained /cli/kortix binary.
#   3. final         — copies both binaries onto a clean runtime base
#                      alongside git.
#
# Build from the repo root:
#   docker build -f apps/sandbox/Dockerfile -t kortix/kortix-sandbox:dev .
#
# To register with Daytona, push to a registry then point the snapshot
# at the resulting image:tag.

# ─── Stage 1: build the agent binary ────────────────────────────────────

FROM oven/bun:1.4.3-debian@sha256:923bedb355f7746666659f71e724998159a5c8c54bd1cb1030e1975a0698415b AS builder

ARG TARGETARCH

# The daemon builds STANDALONE — its own package.json + bun.lock, no workspace
# root. It does share ONE module with apps/api: the relay wire contract
# (packages/api-contract/src/secret-relay.ts, dependency-free by design and
# asserted so by blocked-headers.test.ts). That is reached through a tsconfig
# `paths` mapping rather than a `"workspace:*"` dependency, because a workspace
# dependency makes `bun install --frozen-lockfile` in this directory fail
# outright ("Workspace dependency ... not found / Searched in ./*") and no
# sandbox image can be built at all. So mirror the repo layout here and copy the
# one package the mapping points at.
WORKDIR /repo/apps/kortix-sandbox-agent-server
COPY apps/kortix-sandbox-agent-server/package.json apps/kortix-sandbox-agent-server/bun.lock ./
COPY patches/undici@8.12.2.patch /repo/patches/undici@8.12.2.patch
RUN bun install --frozen-lockfile
COPY packages/api-contract /repo/packages/api-contract
COPY packages/shared/src/peer-message-prompt.ts /repo/packages/shared/src/peer-message-prompt.ts
COPY packages/shared/src/room-prompt.ts /repo/packages/shared/src/room-prompt.ts
COPY packages/shared/src/ssrf-guard.ts /repo/packages/shared/src/ssrf-guard.ts
COPY packages/sdk/src/core/session/wire-message-id.ts /repo/packages/sdk/src/core/session/wire-message-id.ts
COPY apps/kortix-sandbox-agent-server/ ./
RUN case "${TARGETARCH:-}" in \
        amd64) export BUN_COMPILE_TARGET=bun-linux-x64 ;; \
        arm64) export BUN_COMPILE_TARGET=bun-linux-arm64 ;; \
        *) echo "Unsupported Docker target architecture: ${TARGETARCH:-unknown}" >&2; exit 1 ;; \
    esac \
    && bash scripts/build.sh

# ─── Stage 2: build the kortix CLI binary ───────────────────────────────
#
# The CLI lives in apps/cli and imports the unified @kortix/sdk plus its other
# workspace packages and npm dependencies.
# `bun build --compile` inlines all of them, so the runtime image carries a
# single self-contained binary and never needs node_modules on PATH — the
# same shape as kortix-agent. We assemble a throwaway workspace root so bun
# can resolve the `@kortix/*` names to their source, then compile.

FROM oven/bun:1.4.3-debian@sha256:923bedb355f7746666659f71e724998159a5c8c54bd1cb1030e1975a0698415b AS cli-builder

ARG TARGETARCH

WORKDIR /cli
COPY apps/cli ./apps/cli
COPY packages/llm-catalog ./packages/llm-catalog
COPY packages/manifest-schema ./packages/manifest-schema
COPY packages/registry ./packages/registry
COPY packages/sdk ./packages/sdk
COPY packages/shared ./packages/shared
COPY packages/starter ./packages/starter
RUN printf '{"name":"kortix-cli-build","private":true,"workspaces":["apps/cli","packages/*"]}\n' > package.json \
    && case "${TARGETARCH:-}" in \
        amd64) export BUN_COMPILE_TARGET=bun-linux-x64 ;; \
        arm64) export BUN_COMPILE_TARGET=bun-linux-arm64 ;; \
        *) export BUN_COMPILE_TARGET=bun-linux-x64 ;; \
    esac \
    && bun install --no-save \
    && BUN_COMPILE_TARGET="$BUN_COMPILE_TARGET" bash apps/cli/scripts/build.sh \
    && cp apps/cli/dist/kortix /cli/kortix \
    && bun run packages/starter/scripts/write-managed-skills.ts /cli/managed-skills

# ─── Stage 3: runtime ───────────────────────────────────────────────────

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl git gzip libatomic1 sudo tmux iproute2 iputils-arping util-linux \
        build-essential ffmpeg fonts-dejavu fonts-liberation fonts-noto fonts-noto-cjk \
        latexmk libreoffice pandoc pkg-config poppler-utils qpdf tesseract-ocr \
        texlive-bibtex-extra texlive-fonts-recommended texlive-latex-base \
        texlive-latex-extra texlive-latex-recommended \
        bat bc fd-find file fzf git-lfs htop iputils-ping jq less lsof moreutils nano netcat-openbsd openssh-client patch procps ripgrep rsync sqlite3 tree unzip wget xz-utils zip zstd \
    && rm -rf /var/lib/apt/lists/* \
    && (command -v fd >/dev/null || ln -s "$(command -v fdfind)" /usr/local/bin/fd) && (command -v bat >/dev/null || ln -s "$(command -v batcat)" /usr/local/bin/bat) && rg --version >/dev/null && fd --version >/dev/null && bat --version >/dev/null && jq --version >/dev/null && fzf --version >/dev/null

# The session desktop (Xvfb + XFCE + voxl on :6901). Verbatim copy of
# SANDBOX_DESKTOP_INSTALL_COMMAND (packages/shared/src/sandbox/desktop.ts);
# desktop.test.ts fails when the two differ.
# hadolint ignore=DL3008,DL4006,SC2015
RUN apt-get update && if apt-cache show libx264-164 libyuv0 >/dev/null 2>&1; then apt-get install -y --no-install-recommends adwaita-icon-theme dbus-x11 fonts-inter-variable greybird-gtk-theme libopus0 libpulse0 librsvg2-common libx264-164 libyuv0 pulseaudio thunar x11-xserver-utils xfce4-panel xfce4-session xfce4-settings xfce4-terminal xfdesktop4 xfwm4 xvfb && case "$(uname -m)" in x86_64) voxl_arch=amd64; voxl_sha=0e5b4d54023a82107677ee891eeff8926a3d32e86f8e96903847594f289067ac ;; aarch64|arm64) voxl_arch=arm64; voxl_sha=64381d2009b61fcad67e35b71758249c4b7e58e6dae38fc8c4fe81676dd92d3b ;; *) echo "unsupported voxl architecture: $(uname -m)" >&2; exit 1 ;; esac && curl -fsSL --retry 3 --retry-delay 2 -o /tmp/voxl.gz "https://github.com/kortix-ai/suna/releases/download/voxl-acdac72b79b3-kortix.2/voxl-linux-${voxl_arch}.gz" && echo "${voxl_sha}  /tmp/voxl.gz" | sha256sum -c - && gunzip -c /tmp/voxl.gz > /usr/local/bin/voxl && rm /tmp/voxl.gz && chmod 0755 /usr/local/bin/voxl && ! ldd /usr/local/bin/voxl | grep -q 'not found' && ln -sf /usr/local/bin/kortix-entrypoint /usr/local/bin/kortix-desktop && mkdir -p /usr/share/doc/voxl && printf %s TUlUIExpY2Vuc2UKCkNvcHlyaWdodCAoYykgMjAyNiBUZW1ibwoKUGVybWlzc2lvbiBpcyBoZXJlYnkgZ3JhbnRlZCwgZnJlZSBvZiBjaGFyZ2UsIHRvIGFueSBwZXJzb24gb2J0YWluaW5nIGEgY29weQpvZiB0aGlzIHNvZnR3YXJlIGFuZCBhc3NvY2lhdGVkIGRvY3VtZW50YXRpb24gZmlsZXMgKHRoZSAiU29mdHdhcmUiKSwgdG8gZGVhbAppbiB0aGUgU29mdHdhcmUgd2l0aG91dCByZXN0cmljdGlvbiwgaW5jbHVkaW5nIHdpdGhvdXQgbGltaXRhdGlvbiB0aGUgcmlnaHRzCnRvIHVzZSwgY29weSwgbW9kaWZ5LCBtZXJnZSwgcHVibGlzaCwgZGlzdHJpYnV0ZSwgc3VibGljZW5zZSwgYW5kL29yIHNlbGwKY29waWVzIG9mIHRoZSBTb2Z0d2FyZSwgYW5kIHRvIHBlcm1pdCBwZXJzb25zIHRvIHdob20gdGhlIFNvZnR3YXJlIGlzCmZ1cm5pc2hlZCB0byBkbyBzbywgc3ViamVjdCB0byB0aGUgZm9sbG93aW5nIGNvbmRpdGlvbnM6CgpUaGUgYWJvdmUgY29weXJpZ2h0IG5vdGljZSBhbmQgdGhpcyBwZXJtaXNzaW9uIG5vdGljZSBzaGFsbCBiZSBpbmNsdWRlZCBpbiBhbGwKY29waWVzIG9yIHN1YnN0YW50aWFsIHBvcnRpb25zIG9mIHRoZSBTb2Z0d2FyZS4KClRIRSBTT0ZUV0FSRSBJUyBQUk9WSURFRCAiQVMgSVMiLCBXSVRIT1VUIFdBUlJBTlRZIE9GIEFOWSBLSU5ELCBFWFBSRVNTIE9SCklNUExJRUQsIElOQ0xVRElORyBCVVQgTk9UIExJTUlURUQgVE8gVEhFIFdBUlJBTlRJRVMgT0YgTUVSQ0hBTlRBQklMSVRZLApGSVRORVNTIEZPUiBBIFBBUlRJQ1VMQVIgUFVSUE9TRSBBTkQgTk9OSU5GUklOR0VNRU5ULiBJTiBOTyBFVkVOVCBTSEFMTCBUSEUKQVVUSE9SUyBPUiBDT1BZUklHSFQgSE9MREVSUyBCRSBMSUFCTEUgRk9SIEFOWSBDTEFJTSwgREFNQUdFUyBPUiBPVEhFUgpMSUFCSUxJVFksIFdIRVRIRVIgSU4gQU4gQUNUSU9OIE9GIENPTlRSQUNULCBUT1JUIE9SIE9USEVSV0lTRSwgQVJJU0lORyBGUk9NLApPVVQgT0YgT1IgSU4gQ09OTkVDVElPTiBXSVRIIFRIRSBTT0ZUV0FSRSBPUiBUSEUgVVNFIE9SIE9USEVSIERFQUxJTkdTIElOIFRIRQpTT0ZUV0FSRS4K | base64 -d > /usr/share/doc/voxl/LICENSE && mkdir -p /usr/share/kortix/desktop && printf %s PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNTYwIiBoZWlnaHQ9IjE2MDAiIHZpZXdCb3g9IjAgMCAyNTYwIDE2MDAiPjxyZWN0IHdpZHRoPSIxMDAlIiBoZWlnaHQ9IjEwMCUiIGZpbGw9IiNGRkZGRkYiLz48cGF0aCBmaWxsPSIjMEEwQTBBIiB0cmFuc2Zvcm09InRyYW5zbGF0ZSgxMTcxLjIgNzA3LjEyMTk1MTIxOTUxMjIpIHNjYWxlKDEuMzI2ODI5MjY4MjkyNjgzKSIgZD0iTTEzOS43MzcgMTM5LjUzSDE2My4wNTVDMTYzLjA1NSAxMDkuOTMyIDE0Ny4yNjEgODQuMDIyNSAxMjMuNjQyIDY5Ljc2OTRDMTQ3LjI2MSA1NS41MTYzIDE2My4wNTQgMjkuNjA2OCAxNjMuMDU0IDAuMDA4NTkwN0gxMzkuNzM2QzEzOS43MzYgMjguMDE2NSAxMTkuNjcgNTEuNDQ3MSA5My4yOTIxIDU2Ljk0MDZWMC4wMDg1OTA3SDY5Ljk3NzNWNTYuOTQwNkM0My40NzU0IDUxLjU0MjggMjMuNTMzMSAyOC4xMDQ1IDIzLjUzMzEgMC4wMDg1OTA3SDAuMjE1Mjg1QzAuMjE1Mjg1IDI5LjYwNjggMTYuMDA4OCA1NS41MTYzIDM5LjYyODIgNjkuNzY5NEMxNi4wMDg2IDg0LjAyMjUgMC4yMTQ3NjcgMTA5LjkzMiAwLjIxNDc2NyAxMzkuNTNIMjMuNTMyNUMyMy41MzI1IDExMS40MzQgNDMuNDc1NCA4Ny45OTYgNjkuOTc3MyA4Mi41OTgxVjEzOS41NTZIOTMuMjkyMVY4Mi41OThDMTE5Ljc5NCA4Ny45OTU3IDEzOS43MzcgMTExLjQzNCAxMzkuNzM3IDEzOS41M1oiLz48L3N2Zz4= | base64 -d > /usr/share/kortix/desktop/wallpaper.svg && mkdir -p /usr/share/themes/Kortix/gtk-3.0 && printf %s QGltcG9ydCB1cmwoIi91c3Ivc2hhcmUvdGhlbWVzL0dyZXliaXJkL2d0ay0zLjAvZ3RrLmNzcyIpOwoueGZjZTQtcGFuZWwuYmFja2dyb3VuZCB7IGJhY2tncm91bmQtY29sb3I6ICNGRkZGRkY7IGNvbG9yOiAjMEEwQTBBOyBib3JkZXI6IDFweCBzb2xpZCAjRTVFNUU1OyBib3JkZXItYm90dG9tOiBub25lOyB9Ci54ZmNlNC1wYW5lbC5iYWNrZ3JvdW5kIGJ1dHRvbiB7IGJvcmRlci1yYWRpdXM6IDEwcHg7IGNvbG9yOiAjMEEwQTBBOyB0ZXh0LXNoYWRvdzogbm9uZTsgfQoueGZjZTQtcGFuZWwuYmFja2dyb3VuZCBidXR0b246aG92ZXIsIC54ZmNlNC1wYW5lbC5iYWNrZ3JvdW5kIGJ1dHRvbjphY3RpdmU6aG92ZXIsIC54ZmNlNC1wYW5lbC5iYWNrZ3JvdW5kIGJ1dHRvbjpjaGVja2VkOmhvdmVyIHsgYmFja2dyb3VuZC1pbWFnZTogbm9uZTsgYmFja2dyb3VuZC1jb2xvcjogI0YwRjBGMDsgYm9yZGVyLWNvbG9yOiB0cmFuc3BhcmVudDsgYm94LXNoYWRvdzogbm9uZTsgfQoueGZjZTQtcGFuZWwuYmFja2dyb3VuZCBidXR0b246YWN0aXZlLCAueGZjZTQtcGFuZWwuYmFja2dyb3VuZCBidXR0b246Y2hlY2tlZCB7IGJhY2tncm91bmQtaW1hZ2U6IG5vbmU7IGJhY2tncm91bmQtY29sb3I6ICNFNUU1RTU7IGJvcmRlci1jb2xvcjogdHJhbnNwYXJlbnQ7IGJveC1zaGFkb3c6IG5vbmU7IH0K | base64 -d > /usr/share/themes/Kortix/gtk-3.0/gtk.css && mkdir -p /etc/xdg/xfce4/xfconf/xfce-perchannel-xml && printf %s PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz4KPGNoYW5uZWwgbmFtZT0ieHNldHRpbmdzIiB2ZXJzaW9uPSIxLjAiPjxwcm9wZXJ0eSBuYW1lPSJOZXQiIHR5cGU9ImVtcHR5Ij48cHJvcGVydHkgbmFtZT0iVGhlbWVOYW1lIiB0eXBlPSJzdHJpbmciIHZhbHVlPSJLb3J0aXgiLz48cHJvcGVydHkgbmFtZT0iSWNvblRoZW1lTmFtZSIgdHlwZT0ic3RyaW5nIiB2YWx1ZT0iQWR3YWl0YSIvPjwvcHJvcGVydHk+PHByb3BlcnR5IG5hbWU9IlhmdCIgdHlwZT0iZW1wdHkiPjxwcm9wZXJ0eSBuYW1lPSJEUEkiIHR5cGU9ImludCIgdmFsdWU9IjE0NCIvPjwvcHJvcGVydHk+PHByb3BlcnR5IG5hbWU9Ikd0ayIgdHlwZT0iZW1wdHkiPjxwcm9wZXJ0eSBuYW1lPSJGb250TmFtZSIgdHlwZT0ic3RyaW5nIiB2YWx1ZT0iSW50ZXIgVmFyaWFibGUgMTAiLz48L3Byb3BlcnR5PjwvY2hhbm5lbD4K | base64 -d > /etc/xdg/xfce4/xfconf/xfce-perchannel-xml/xsettings.xml && mkdir -p /etc/xdg/xfce4/xfconf/xfce-perchannel-xml && printf %s PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz4KPGNoYW5uZWwgbmFtZT0ieGZ3bTQiIHZlcnNpb249IjEuMCI+PHByb3BlcnR5IG5hbWU9ImdlbmVyYWwiIHR5cGU9ImVtcHR5Ij48cHJvcGVydHkgbmFtZT0idGhlbWUiIHR5cGU9InN0cmluZyIgdmFsdWU9IkdyZXliaXJkIi8+PHByb3BlcnR5IG5hbWU9IndvcmtzcGFjZV9jb3VudCIgdHlwZT0iaW50IiB2YWx1ZT0iMSIvPjxwcm9wZXJ0eSBuYW1lPSJ1c2VfY29tcG9zaXRpbmciIHR5cGU9ImJvb2wiIHZhbHVlPSJmYWxzZSIvPjwvcHJvcGVydHk+PC9jaGFubmVsPgo= | base64 -d > /etc/xdg/xfce4/xfconf/xfce-perchannel-xml/xfwm4.xml && mkdir -p /etc/xdg/xfce4/xfconf/xfce-perchannel-xml && printf %s PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz4KPGNoYW5uZWwgbmFtZT0ieGZjZTQtZGVza3RvcCIgdmVyc2lvbj0iMS4wIj48cHJvcGVydHkgbmFtZT0iZGVza3RvcC1pY29ucyIgdHlwZT0iZW1wdHkiPjxwcm9wZXJ0eSBuYW1lPSJzdHlsZSIgdHlwZT0iaW50IiB2YWx1ZT0iMCIvPjwvcHJvcGVydHk+PHByb3BlcnR5IG5hbWU9ImJhY2tkcm9wIiB0eXBlPSJlbXB0eSI+PHByb3BlcnR5IG5hbWU9InNjcmVlbjAiIHR5cGU9ImVtcHR5Ij48cHJvcGVydHkgbmFtZT0ibW9uaXRvcnNjcmVlbiIgdHlwZT0iZW1wdHkiPjxwcm9wZXJ0eSBuYW1lPSJ3b3Jrc3BhY2UwIiB0eXBlPSJlbXB0eSI+PHByb3BlcnR5IG5hbWU9ImNvbG9yLXN0eWxlIiB0eXBlPSJpbnQiIHZhbHVlPSIwIi8+PHByb3BlcnR5IG5hbWU9InJnYmExIiB0eXBlPSJhcnJheSI+PHZhbHVlIHR5cGU9ImludCIgdmFsdWU9IjEiLz48dmFsdWUgdHlwZT0iaW50IiB2YWx1ZT0iMSIvPjx2YWx1ZSB0eXBlPSJpbnQiIHZhbHVlPSIxIi8+PHZhbHVlIHR5cGU9ImludCIgdmFsdWU9IjEiLz48L3Byb3BlcnR5Pjxwcm9wZXJ0eSBuYW1lPSJpbWFnZS1zdHlsZSIgdHlwZT0iaW50IiB2YWx1ZT0iNSIvPjxwcm9wZXJ0eSBuYW1lPSJsYXN0LWltYWdlIiB0eXBlPSJzdHJpbmciIHZhbHVlPSIvdXNyL3NoYXJlL2tvcnRpeC9kZXNrdG9wL3dhbGxwYXBlci5zdmciLz48L3Byb3BlcnR5PjwvcHJvcGVydHk+PC9wcm9wZXJ0eT48L3Byb3BlcnR5PjwvY2hhbm5lbD4K | base64 -d > /etc/xdg/xfce4/xfconf/xfce-perchannel-xml/xfce4-desktop.xml && mkdir -p /etc/xdg/xfce4/panel && printf %s PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz4KPGNoYW5uZWwgbmFtZT0ieGZjZTQtcGFuZWwiIHZlcnNpb249IjEuMCI+PHByb3BlcnR5IG5hbWU9ImNvbmZpZ3ZlciIgdHlwZT0iaW50IiB2YWx1ZT0iMiIvPjxwcm9wZXJ0eSBuYW1lPSJwYW5lbHMiIHR5cGU9ImFycmF5Ij48dmFsdWUgdHlwZT0iaW50IiB2YWx1ZT0iMSIvPjxwcm9wZXJ0eSBuYW1lPSJkYXJrLW1vZGUiIHR5cGU9ImJvb2wiIHZhbHVlPSJmYWxzZSIvPjxwcm9wZXJ0eSBuYW1lPSJwYW5lbC0xIiB0eXBlPSJlbXB0eSI+PHByb3BlcnR5IG5hbWU9InBvc2l0aW9uIiB0eXBlPSJzdHJpbmciIHZhbHVlPSJwPTEwO3g9MDt5PTAiLz48cHJvcGVydHkgbmFtZT0ibGVuZ3RoIiB0eXBlPSJpbnQiIHZhbHVlPSIxIi8+PHByb3BlcnR5IG5hbWU9InBvc2l0aW9uLWxvY2tlZCIgdHlwZT0iYm9vbCIgdmFsdWU9InRydWUiLz48cHJvcGVydHkgbmFtZT0ic2l6ZSIgdHlwZT0iaW50IiB2YWx1ZT0iNjQiLz48cHJvcGVydHkgbmFtZT0iaWNvbi1zaXplIiB0eXBlPSJpbnQiIHZhbHVlPSI0MCIvPjxwcm9wZXJ0eSBuYW1lPSJwbHVnaW4taWRzIiB0eXBlPSJhcnJheSI+PHZhbHVlIHR5cGU9ImludCIgdmFsdWU9IjEiLz48dmFsdWUgdHlwZT0iaW50IiB2YWx1ZT0iMiIvPjx2YWx1ZSB0eXBlPSJpbnQiIHZhbHVlPSIzIi8+PC9wcm9wZXJ0eT48L3Byb3BlcnR5PjwvcHJvcGVydHk+PHByb3BlcnR5IG5hbWU9InBsdWdpbnMiIHR5cGU9ImVtcHR5Ij48cHJvcGVydHkgbmFtZT0icGx1Z2luLTEiIHR5cGU9InN0cmluZyIgdmFsdWU9ImxhdW5jaGVyIj48cHJvcGVydHkgbmFtZT0iaXRlbXMiIHR5cGU9ImFycmF5Ij48dmFsdWUgdHlwZT0ic3RyaW5nIiB2YWx1ZT0ieGZjZTQtd2ViLWJyb3dzZXIuZGVza3RvcCIvPjwvcHJvcGVydHk+PC9wcm9wZXJ0eT48cHJvcGVydHkgbmFtZT0icGx1Z2luLTIiIHR5cGU9InN0cmluZyIgdmFsdWU9ImxhdW5jaGVyIj48cHJvcGVydHkgbmFtZT0iaXRlbXMiIHR5cGU9ImFycmF5Ij48dmFsdWUgdHlwZT0ic3RyaW5nIiB2YWx1ZT0ieGZjZTQtdGVybWluYWwtZW11bGF0b3IuZGVza3RvcCIvPjwvcHJvcGVydHk+PC9wcm9wZXJ0eT48cHJvcGVydHkgbmFtZT0icGx1Z2luLTMiIHR5cGU9InN0cmluZyIgdmFsdWU9ImxhdW5jaGVyIj48cHJvcGVydHkgbmFtZT0iaXRlbXMiIHR5cGU9ImFycmF5Ij48dmFsdWUgdHlwZT0ic3RyaW5nIiB2YWx1ZT0ieGZjZTQtZmlsZS1tYW5hZ2VyLmRlc2t0b3AiLz48L3Byb3BlcnR5PjwvcHJvcGVydHk+PC9wcm9wZXJ0eT48L2NoYW5uZWw+Cg== | base64 -d > /etc/xdg/xfce4/panel/default.xml && mkdir -p /usr/share/xfce4/helpers && printf %s W0Rlc2t0b3AgRW50cnldClR5cGU9WC1YRkNFLUhlbHBlcgpYLVhGQ0UtQ2F0ZWdvcnk9V2ViQnJvd3NlcgpOYW1lPUJyb3dzZXIKSWNvbj13ZWItYnJvd3NlcgpYLVhGQ0UtQ29tbWFuZHM9L3Vzci9sb2NhbC9iaW4va29ydGl4LWRlc2t0b3AgYnJvd3NlcgpYLVhGQ0UtQ29tbWFuZHNXaXRoUGFyYW1ldGVyPS91c3IvbG9jYWwvYmluL2tvcnRpeC1kZXNrdG9wIGJyb3dzZXIgIiVzIgo= | base64 -d > /usr/share/xfce4/helpers/kortix-browser.desktop && mkdir -p /etc/xdg/xfce4/terminal && printf %s W0NvbmZpZ3VyYXRpb25dCk1pc2NNZW51YmFyRGVmYXVsdD1GQUxTRQpNaXNjVG9vbGJhckRlZmF1bHQ9RkFMU0UKU2Nyb2xsaW5nQmFyPVRFUk1JTkFMX1NDUk9MTEJBUl9OT05FCkZvbnROYW1lPURlamFWdSBTYW5zIE1vbm8gMTAKQ29sb3JGb3JlZ3JvdW5kPSMwQTBBMEEKQ29sb3JCYWNrZ3JvdW5kPSNGRkZGRkYKQ29sb3JDdXJzb3I9IzBBMEEwQQpDb2xvckJvbGQ9IzBBMEEwQQpDb2xvclBhbGV0dGU9IzBBMEEwQTsjQzAxQzI4OyMyNkEyNjk7I0EyNzM0QzsjMTI0ODhCOyNBMzQ3QkE7IzJBN0JERTsjRDBDRkNDOyM1RTVDNjQ7I0Y2NjE1MTsjMzNEMTdBOyNDODg4MDA7IzJBN0JERTsjQzA2MUNCOyMzM0M3REU7I0ZGRkZGRgpNaXNjRGVmYXVsdEdlb21ldHJ5PTEwMHgzMAo= | base64 -d > /etc/xdg/xfce4/terminal/terminalrc && mkdir -p /etc/xdg/xfce4 && printf %s V2ViQnJvd3Nlcj1rb3J0aXgtYnJvd3NlcgpUZXJtaW5hbEVtdWxhdG9yPXhmY2U0LXRlcm1pbmFsCkZpbGVNYW5hZ2VyPXRodW5hcgo= | base64 -d > /etc/xdg/xfce4/helpers.rc; else echo "desktop: skipped, this base lacks the Ubuntu 24.04 libraries voxl links"; fi && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /bin/bash --user-group kortix \
    && echo 'kortix ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/kortix \
    && chmod 0440 /etc/sudoers.d/kortix \
    && mkdir -p /workspace /opt/kortix /opt/pw-browsers \
        /home/kortix/.local/bin /home/kortix/.local/share/pnpm/bin /home/kortix/.bun/bin \
    && chown -R kortix:kortix /workspace /opt/kortix /opt/pw-browsers /home/kortix

ENV PNPM_HOME=/home/kortix/.local/share/pnpm \
    PATH=/home/kortix/.local/bin:/home/kortix/.local/share/pnpm/bin:/home/kortix/.bun/bin:$PATH
USER kortix

COPY packages/shared/src/runtime-versions.json /tmp/kortix-runtime-versions.json
# No `SHELL -o pipefail` in this stage (DL4006): every pipe below already ends
# in its own check (`sha256sum -c`, `grep -q`, `test -n`), and pipefail would
# fail the build on the SIGPIPE that `find | head -n1` and `doctor | grep -q`
# raise when the reader exits first.
# hadolint ignore=DL4006
RUN UV_VERSION="$(sed -n 's/.*"uv": "\([^"]*\)".*/\1/p' /tmp/kortix-runtime-versions.json)" \
    && PYTHON_VERSION="$(sed -n 's/.*"python": "\([^"]*\)".*/\1/p' /tmp/kortix-runtime-versions.json)" \
    && UV_SHA256_AMD64="$(sed -n 's/.*"uvSha256Amd64": "\([^"]*\)".*/\1/p' /tmp/kortix-runtime-versions.json)" \
    && UV_SHA256_ARM64="$(sed -n 's/.*"uvSha256Arm64": "\([^"]*\)".*/\1/p' /tmp/kortix-runtime-versions.json)" \
    && test -n "$UV_VERSION" \
    && test -n "$PYTHON_VERSION" \
    && case "$(uname -m)" in \
         x86_64) uv_arch=x86_64; uv_sha="$UV_SHA256_AMD64" ;; \
         aarch64|arm64) uv_arch=aarch64; uv_sha="$UV_SHA256_ARM64" ;; \
         *) echo "unsupported uv architecture: $(uname -m)" >&2; exit 1 ;; \
       esac \
    && curl -fsSL --retry 3 --retry-delay 2 -o /tmp/uv.tar.gz \
         "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${uv_arch}-unknown-linux-gnu.tar.gz" \
    && echo "${uv_sha}  /tmp/uv.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/uv.tar.gz --strip-components=1 -C /home/kortix/.local/bin \
    && rm /tmp/uv.tar.gz \
    && uv --version | grep -Eq "^uv ${UV_VERSION}( |$)" \
    && UV_PYTHON_DOWNLOADS=automatic uv python install --default "$PYTHON_VERSION" \
    && python -c "import sys; assert '.'.join(map(str, sys.version_info[:3])) == '${PYTHON_VERSION}'; print('managed python:', sys.version)" \
    && python3 -c "import sys; assert '.'.join(map(str, sys.version_info[:3])) == '${PYTHON_VERSION}'"

# Python package floor — everything the starter skills import, baked into the
# managed interpreter so bare `python3` needs no per-script resolution or
# runtime downloads. Pins live in runtime-versions.json (`pythonPackages`);
# `uv run --with` stays the escape hatch for packages outside the floor.
# `--break-system-packages` overrides uv's externally-managed marker on the
# interpreter installed above — our frozen build-time interpreter, not a
# distro Python. The interpreter is named by EXPLICIT PATH: `--system` skips
# uv-managed interpreters and would resolve the distro python3 that
# LibreOffice's apt deps drag in. Unquoted $(...) expansion is safe here: pins
# contain no whitespace, and the `markitdown[pptx]` glob matches no file here.
# hadolint ignore=SC2046
RUN uv pip install --python /home/kortix/.local/bin/python3 --break-system-packages \
        $(python3 -c "import json; print(' '.join(f'{k}=={v}' for k, v in sorted(json.load(open('/tmp/kortix-runtime-versions.json'))['pythonPackages'].items())))") \
    && python3 -c "import importlib; [importlib.import_module(m) for m in ['PIL', 'docx', 'fitz', 'lxml', 'markitdown', 'openpyxl', 'pandas', 'pdf2docx', 'pdf2image', 'pdfplumber', 'playwright', 'pptx', 'pypdf', 'pypdfium2', 'pytesseract', 'reportlab']]; print('python package floor OK')"

ENV SHELL=/bin/bash
# hadolint ignore=DL4006
RUN PNPM_VERSION="$(python -c "import json; print(json.load(open('/tmp/kortix-runtime-versions.json'))['pnpm'])")" \
    && NODE_VERSION="$(python -c "import json; print(json.load(open('/tmp/kortix-runtime-versions.json'))['node'])")" \
    && NPM_VERSION="$(python -c "import json; print(json.load(open('/tmp/kortix-runtime-versions.json'))['npm'])")" \
    && PNPM_SHA256_AMD64="$(python -c "import json; print(json.load(open('/tmp/kortix-runtime-versions.json'))['pnpmSha256Amd64'])")" \
    && PNPM_SHA256_ARM64="$(python -c "import json; print(json.load(open('/tmp/kortix-runtime-versions.json'))['pnpmSha256Arm64'])")" \
    && case "$(uname -m)" in \
         x86_64) pnpm_arch=x64; pnpm_sha="$PNPM_SHA256_AMD64" ;; \
         aarch64|arm64) pnpm_arch=arm64; pnpm_sha="$PNPM_SHA256_ARM64" ;; \
         *) echo "unsupported pnpm architecture: $(uname -m)" >&2; exit 1 ;; \
       esac \
    && curl -fsSL --retry 3 --retry-delay 2 -o /tmp/pnpm.tar.gz \
         "https://github.com/pnpm/pnpm/releases/download/v${PNPM_VERSION}/pnpm-linux-${pnpm_arch}.tar.gz" \
    && echo "${pnpm_sha}  /tmp/pnpm.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/pnpm.tar.gz -C /home/kortix/.local/bin \
    && rm /tmp/pnpm.tar.gz \
    && test "$(pnpm --version)" = "$PNPM_VERSION" \
    && pnpm runtime set node "$NODE_VERSION" -g \
    && test "$(node --version)" = "v${NODE_VERSION}" \
    && pnpm add -g "npm@${NPM_VERSION}" \
    && test "$(npm --version)" = "$NPM_VERSION"

ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers \
    AGENT_BROWSER_EXECUTABLE_PATH=/home/kortix/.local/bin/chromium \
    AGENT_BROWSER_ARGS=--no-sandbox,--disable-dev-shm-usage,--test-type,--disable-infobars \
    PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT=1800000
# The non-root sandbox user has passwordless sudo by design (sudoers above);
# playwright --with-deps installs apt packages as root.
# hadolint ignore=DL3004,DL4006
RUN AGENT_BROWSER_VERSION="$(node -e "console.log(require('/tmp/kortix-runtime-versions.json').agentBrowser)")" \
    && PLAYWRIGHT_VERSION="$(node -e "console.log(require('/tmp/kortix-runtime-versions.json').playwright)")" \
    && pnpm add -g --allow-build=agent-browser "agent-browser@${AGENT_BROWSER_VERSION}" \
    && agent-browser --version \
    && for pw_try in 1 2 3 4 5; do \
        pnpm dlx "playwright@${PLAYWRIGHT_VERSION}" install --with-deps --no-shell chromium && break; \
        echo "playwright chromium install attempt $pw_try failed, retrying..."; \
        sleep $((pw_try*10)); \
    done \
    && sudo rm -rf /var/lib/apt/lists/* \
    && pw_chrome="$(find /opt/pw-browsers -type f -path '*chrome-linux*/chrome' | head -n1)" \
    && test -n "$pw_chrome" \
    && ln -sf "$pw_chrome" /home/kortix/.local/bin/chromium \
    && mkdir -p /home/kortix/.agent-browser/browsers \
    && ln -sf "$(dirname "$pw_chrome")" /home/kortix/.agent-browser/browsers/chrome-linux64 \
    && pw_rev="${pw_chrome#/opt/pw-browsers/chromium-}" && pw_rev="${pw_rev%%/*}" \
    && pw_shell_dir="/opt/pw-browsers/chromium_headless_shell-${pw_rev}" \
    && case "$(uname -m)" in x86_64) pw_shell=chrome-headless-shell-linux64/chrome-headless-shell ;; *) pw_shell=chrome-linux/headless_shell ;; esac \
    && mkdir -p "$(dirname "${pw_shell_dir}/${pw_shell}")" \
    && ln -sf "$pw_chrome" "${pw_shell_dir}/${pw_shell}" \
    && touch "${pw_shell_dir}/INSTALLATION_COMPLETE" "${pw_shell_dir}/DEPENDENCIES_VALIDATED" \
    && test -x "${pw_shell_dir}/${pw_shell}" \
    && chromium --version \
    && env -u AGENT_BROWSER_EXECUTABLE_PATH agent-browser doctor 2>&1 | grep -qE 'pass.+chrome-linux64/chrome'

# hadolint ignore=DL4006
RUN BUN_VERSION="$(node -e "console.log(require('/tmp/kortix-runtime-versions.json').bun)")" \
    && BUN_SHA256_AMD64="$(node -e "console.log(require('/tmp/kortix-runtime-versions.json').bunSha256Amd64)")" \
    && BUN_SHA256_ARM64="$(node -e "console.log(require('/tmp/kortix-runtime-versions.json').bunSha256Arm64)")" \
    && case "$(uname -m)" in \
         x86_64) bun_arch=x64; bun_sha="$BUN_SHA256_AMD64" ;; \
         aarch64|arm64) bun_arch=aarch64; bun_sha="$BUN_SHA256_ARM64" ;; \
         *) echo "unsupported Bun architecture: $(uname -m)" >&2; exit 1 ;; \
       esac \
    && curl -fsSL --retry 3 --retry-delay 2 -o /tmp/bun.zip \
         "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${bun_arch}.zip" \
    && echo "${bun_sha}  /tmp/bun.zip" | sha256sum -c - \
    && unzip -q /tmp/bun.zip -d /tmp/bun \
    && install -m 0755 "/tmp/bun/bun-linux-${bun_arch}/bun" /home/kortix/.bun/bin/bun \
    && ln -sf bun /home/kortix/.bun/bin/bunx \
    && rm -rf /tmp/bun /tmp/bun.zip \
    && test "$(bun --version)" = "$BUN_VERSION"

# anydoc (Firecrawl) — document→Markdown converter for the
# convert-documents-to-markdown skill. Prebuilt napi binaries; no build scripts.
RUN ANYDOC_VERSION="$(node -e "console.log(require('/tmp/kortix-runtime-versions.json').anydoc)")" \
    && pnpm add -g "@firecrawl/anydoc@${ANYDOC_VERSION}" \
    && command -v anydoc \
    && test "$(anydoc --version)" = "$ANYDOC_VERSION"

# pi system packages (runtime-versions.json `piSystemPackages`), installed the
# way `pi install` installs a global one. Same step as `piSystemPackageLines` in
# packages/shared/src/sandbox/dockerfile-layer.ts; keep both in sync.
RUN PI_PACKAGES="$(node -e "console.log((require('/tmp/kortix-runtime-versions.json').piSystemPackages || []).map((s) => s.slice(4)).join(' '))")" \
    && if [ -n "$PI_PACKAGES" ]; then \
         mkdir -p /opt/kortix/pi-agent/npm/pi-supplied \
         && printf '%s' '{"name":"kortix-pi-supplied","version":"0.0.0","private":true}' > /opt/kortix/pi-agent/npm/pi-supplied/package.json \
         && node -e "const s='file:./pi-supplied'; const deps={ '@earendil-works/pi-agent-core': s, '@earendil-works/pi-ai': s, '@earendil-works/pi-coding-agent': s, '@earendil-works/pi-tui': s }; for (const p of require('/tmp/kortix-runtime-versions.json').piSystemPackages) { const spec=p.slice(4); const at=spec.lastIndexOf('@'); deps[spec.slice(0, at)]=spec.slice(at + 1); } require('fs').writeFileSync('/opt/kortix/pi-agent/npm/package.json', JSON.stringify({ name: 'kortix-pi-system-packages', private: true, dependencies: deps }))" \
         && npm install --prefix /opt/kortix/pi-agent/npm --omit=dev --ignore-scripts --no-audit --no-fund \
         && node -e "require('fs').writeFileSync('/opt/kortix/pi-agent/settings.json', JSON.stringify({ packages: require('/tmp/kortix-runtime-versions.json').piSystemPackages }))"; \
       fi

USER root
# Modes and ownership are set BY THE COPY, never by a later chmod/chown.
# A RUN that changes a file's mode or owner copies that file into a NEW layer,
# so the old `chmod +x … && chown -R /opt/kortix …` at the bottom of this block
# rewrote the 106 MB CLI, the compiled agent and the whole managed-skills tree
# a second time — 288 MB of pure duplication in every sandbox image, measured
# with `docker history`. `--chmod`/`--chown` apply it in the layer that already
# carries the bytes.
COPY --from=builder --chmod=755 /repo/apps/kortix-sandbox-agent-server/dist/kortix-agent /usr/local/bin/kortix-agent
# The admin CLI every in-sandbox agent reaches for: `kortix cr open`,
# `kortix secrets`, `kortix sessions`, … Pre-authenticated at runtime via the
# project-scoped token the platform injects (KORTIX_TOKEN).
COPY --from=cli-builder --chown=kortix:kortix --chmod=755 /cli/kortix /usr/local/bin/kortix
# Always-latest managed Kortix skills (kortix-cli + the kortix-* family). The
# agent server overlays these into every session's skills dir at boot
# so no project ever goes stale on Kortix internals.
COPY --from=cli-builder --chown=kortix:kortix /cli/managed-skills /opt/kortix/managed-skills
COPY --chmod=755 apps/sandbox/entrypoint.sh /usr/local/bin/kortix-entrypoint
COPY apps/sandbox/MACHINE.md /MACHINE.md
# Channel shims delegate Connector calls to the compiled `kortix` CLI.
COPY --chown=kortix:kortix --chmod=755 apps/sandbox/slack-cli/ /opt/kortix/apps/sandbox/slack-cli/
# The daemon converges the CLI in place at /usr/local/bin/kortix (runtime-assets.ts
# DEFAULT_CLI_PATH) and runs as kortix. It writes a temp file next to the target
# and renames it, so the permission it needs comes from the DIRECTORY — owning
# only the file left every digest mismatch failing EACCES with `cli: failed`.
# The DIRECTORY ONLY: the CLI above already arrives `--chown=kortix:kortix`, so
# naming the file here changed no ownership and still forced overlayfs to copy
# the whole ~105 MB binary up into this layer.
# The command is SANDBOX_CLI_OWNERSHIP_COMMAND in
# packages/shared/src/sandbox/platform-binaries.ts, asserted on all three image
# definitions.
RUN bash /opt/kortix/apps/sandbox/slack-cli/install-shims.sh /opt/kortix/apps/sandbox/slack-cli \
    && kortix --version \
    && chown kortix:kortix /usr/local/bin \
    && chown -R kortix:kortix /workspace

# Platform-owned secret delivery. The daemon writes live project secrets to
# /dev/shm/kortix/agent-env.sh (tmpfs — never on the persisted disk); these
# baked hooks source it into every shell — login/non-login, interactive PTY
# shells, and any terminal the user opens — so secrets load automatically and
# CANNOT be removed via user config. (The agent's non-interactive `bash -c`
# is covered by BASH_ENV, which the daemon sets.)
RUN printf '%s\n' '[ -r /dev/shm/kortix/agent-env.sh ] && . /dev/shm/kortix/agent-env.sh' \
      > /etc/profile.d/kortix-agent-env.sh \
    && printf '%s\n' '[ -r /dev/shm/kortix/agent-env.sh ] && . /dev/shm/kortix/agent-env.sh' \
      >> /etc/bash.bashrc

ENV KORTIX_WORKSPACE=/workspace
USER kortix
# Warm jiti's cache for the pi system packages with the daemon itself; a package
# that fails to load fails the build. Same step as `piSystemPackageWarmLines`.
# The second command states what this image carries, so a box booted from it
# can answer "which bytes am I running" on its FIRST health read and its first
# reconcile is a no-op. Both run as `kortix`, so the state file it writes is
# the one the daemon later rewrites in place. One RUN, not two: hadolint DL3059
# and one fewer layer. See packages/shared/src/sandbox/platform-binaries.ts —
# the bake is asserted on all three image definitions.
RUN if [ -f /opt/kortix/pi-agent/settings.json ]; then /usr/local/bin/kortix-agent warm-pi-packages; fi \
    && /usr/local/bin/kortix-agent bake-runtime-assets-state
WORKDIR /workspace

EXPOSE 8000

ENTRYPOINT ["/usr/local/bin/kortix-entrypoint"]
