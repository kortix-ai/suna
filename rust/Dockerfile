FROM rust:1.85-bookworm AS builder
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN cargo build --locked --release -p kortix-api

FROM debian:bookworm-slim AS runtime
ARG KORTIX_VERSION=dev
ARG KORTIX_COMMIT=unknown
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --no-create-home kortix
COPY --from=builder /build/target/release/kortix-api /usr/local/bin/kortix-api
USER 10001
ENV HOST=0.0.0.0 \
    PORT=8008 \
    RUST_LOG=info \
    KORTIX_VERSION=${KORTIX_VERSION} \
    KORTIX_COMMIT=${KORTIX_COMMIT}
EXPOSE 8008
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/kortix-api"]
