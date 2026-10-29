# Builds the voxl desktop streamer (github.com/tembo/voxl, MIT) on the same
# base as the sandbox runtime, so the binary links the ubuntu:24.04 x264,
# libyuv, opus and pulse libraries the image installs. release.sh runs this
# per architecture and uploads the result; the image never compiles Rust.
#
# The web client voxl serves is user-facing: its tab title and favicon are
# rebranded to Kortix Computer before the build embeds them, and the build
# fails if "Tembo" is left anywhere in the served web files.
FROM ubuntu:24.04
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
# `brand` is apps/web/public (release.sh passes it as a named build context).
COPY --from=brand favicon.ico /src/web/favicon.ico
RUN sed -i -e 's/Tembo Computer/Kortix Computer/g' -e '/\/\*.*Tembo.*\*\//d' /src/web/index.html \
    && sed -i 's/Icons from the Tembo UI package.s icon set/Icons/' /src/web/src/client/files.ts \
    && ! grep -rqi tembo /src/web \
    && /root/.cargo/bin/cargo install --path /src --locked --root /out \
    && strip /out/bin/voxl
