# syntax=docker/dockerfile:1
FROM rust:1.99.1-bookworm AS builder
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY tests ./tests
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    cargo test --locked --all-targets && cargo build --release --locked

FROM debian:bookworm-slim AS runner
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /app/target/release/nostube-search /usr/local/bin/nostube-search
COPY src/franc-LICENSE /usr/local/share/licenses/nostube-search/franc-LICENSE
ENV PORT=3001
EXPOSE 3001
CMD ["nostube-search"]
