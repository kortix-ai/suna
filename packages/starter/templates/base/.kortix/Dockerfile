# syntax=docker/dockerfile:1.7
#
# Project sandbox base image. Kortix layers its agent daemon +
# opencode CLI on top of whatever you build here. Customize freely.
#
# Docs: https://docs.kortix.ai/projects/sandbox

FROM ubuntu:24.04

# Bring in baseline tooling. The Kortix layer on top also installs
# git/curl/ca-certificates/nodejs/npm, but having them in your base
# makes interactive sessions snappier.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

# Add your project-specific tooling below. Examples:
#
# RUN curl -fsSL https://bun.sh/install | bash
# RUN apt-get update && apt-get install -y --no-install-recommends python3.12 python3.12-venv
# RUN curl -fsSL https://go.dev/dl/go1.23.0.linux-amd64.tar.gz | tar -C /usr/local -xzf -
