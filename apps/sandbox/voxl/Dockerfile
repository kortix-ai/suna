# Builds the voxl desktop streamer (github.com/tembo/voxl, MIT) on the same
# base as the sandbox runtime, so the binary links the ubuntu:24.04 x264,
# libyuv, opus and pulse libraries the image installs. release.sh runs this
# per architecture and uploads the result; the image never compiles Rust.
#
# The web client voxl serves is user-facing: its default tab title and its
# favicon are rebranded to Kortix Computer before the build embeds them, and
# the build fails if "Tembo" is left anywhere in the served web files.
#
# voxl paces every viewer to the slowest one and drops a viewer from that
# pacing only after 4 s without acks; one stalled tab froze every viewer at
# ~1 fps. The patch cuts that to 1 s, and the build fails if the line moved.
#
# size-owner.patch: one viewer sizes the desktop. With --enable-resize every
# viewer asked for its own window's size again after each resize, so two
# viewers of different sizes resized the desktop back and forth about once a
# second, and every resize restarts the stream on a black frame (the Desktop
# panel blinked). With the patch the first viewer owns the size, a viewer that
# acts on the desktop takes it over, and the others watch it scaled. `git
# apply` fails the build when the patch no longer applies to VOXL_REV.
# Upstream: github.com/tembo/voxl/pull/86. Delete the patch once VOXL_REV has it.
FROM ubuntu:24.04 AS build
ARG VOXL_REV
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl git build-essential pkg-config clang libclang-dev \
        libx264-dev libyuv-dev libopus-dev libpulse-dev libxcb1-dev npm \
    && npm install -g esbuild@0.25.11 \
    && curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal
# Ubuntu's libyuv-dev ships no pkg-config file; voxl's build.rs probes for one.
RUN printf 'libdir=/usr/lib/%s-linux-gnu\nName: libyuv\nDescription: libyuv\nVersion: 0\nLibs: -L${libdir} -lyuv\nCflags: -I/usr/include\n' "$(uname -m)" \
        > /usr/share/pkgconfig/libyuv.pc \
    && git clone https://github.com/tembo/voxl /src && git -C /src checkout --detach "$VOXL_REV"
COPY size-owner.patch /tmp/size-owner.patch
RUN git -C /src apply /tmp/size-owner.patch
# `brand` is apps/web/public (release.sh passes it as a named build context).
COPY --from=brand favicon.ico /src/web/favicon.ico
RUN grep -q '"Voxl Computer Stream"' /src/src/lib.rs \
    && sed -i 's/"Voxl Computer Stream"/"Kortix Computer"/' /src/src/lib.rs \
    && sed -i '/\/\*.*Tembo.*\*\//d' /src/web/index.html \
    && sed -i 's/Icons from the Tembo UI package.s icon set/Icons/' /src/web/src/client/files.ts \
    && ! grep -rqi tembo /src/web \
    && grep -q 'if age > 4000 {' /src/src/video.rs \
    && sed -i 's/if age > 4000 {/if age > 1000 {/' /src/src/video.rs \
    && /root/.cargo/bin/cargo install --path /src --locked --root /out \
    && strip /out/bin/voxl

# Only the binary leaves the build: exporting the whole toolchain rootfs to a
# local directory stalled release.sh after the compile finished.
FROM scratch
COPY --from=build /out/bin/voxl /out/bin/voxl
