# Agent Sandbox

This directory contains the agent sandbox implementation - a Docker-based virtual environment that agents use as their own computer to execute tasks, access the web, and manipulate files.

## Overview

The sandbox provides a complete containerized Linux environment with:
- Chrome browser for web interactions
- VNC server for accessing the Web User
- Web server for serving content (port 8080) -> loading html files from the /workspace directory
- Full file system access
- Full sudo access

## Customizing the Sandbox

You can modify the sandbox environment for development or to add new capabilities:

1. Edit files in the `docker/` directory
2. Build a custom image:
   ```
   cd backend/sandbox/docker
   docker compose build
   docker push kortix/suna:0.1.3.16
   ```
3. Test your changes locally using docker-compose

## Using a Custom Snapshot

To use your custom sandbox snapshot:

1. Change the `image` parameter in `docker-compose.yml` (that defines the image name `kortix/suna:___`)
2. Build and create a snapshot in Daytona with the same name
3. Update the snapshot name in `backend/sandbox/sandbox.py` in the `create_sandbox` function
4. If using Daytona for deployment, update the snapshot reference there as well

## Publishing New Versions

When publishing a new version of the sandbox:

1. Update the version number in `docker-compose.yml` (e.g., from `0.1.2` to `0.1.3`)
2. Build the new image: `docker compose build`
3. Push the new version: `docker push kortix/suna:0.1.3`
4. Create a new snapshot in Daytona with the same name
5. Update all references to the snapshot version in:
   - `backend/utils/config.py`
   - Daytona snapshots
   - Any other services using this snapshot