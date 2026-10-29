# Builds the voxl desktop streamer (github.com/tembo/voxl, MIT) on the same
# base as the sandbox runtime, so the binary links the ubuntu:24.04 x264,
# libyuv, opus and pulse libraries the image installs. release.sh runs this
# per architecture and uploads the result; the image never compiles Rust.
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
    && /root/.cargo/bin/cargo install --git https://github.com/tembo/voxl --rev "$VOXL_REV" --locked --root /out voxl-server \
    && strip /out/bin/voxl
