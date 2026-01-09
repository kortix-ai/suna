# Snapshot Test Script

This script tests if your Daytona snapshot is working correctly.

## Prerequisites

1. Daytona API key and server URL configured in environment variables:
   - `DAYTONA_API_KEY`
   - `DAYTONA_SERVER_URL`
   - `DAYTONA_TARGET` (optional)

2. Snapshot `pablokortix/suna:0.1.3.28` exists in Daytona dashboard and is "Active"

## Usage

From the `backend` directory:

```bash
python test_snapshot.py
```

Or make it executable and run directly:

```bash
chmod +x test_snapshot.py
./test_snapshot.py
```

## What It Tests

1. **Daytona Connection**: Verifies API key and connection to Daytona
2. **Sandbox Creation**: Creates a test sandbox from your snapshot
3. **Skills Directory**: Verifies `/skills` directory exists and contains `slack-gif-creator`
4. **File Access**: Tests reading files from `/skills/slack-gif-creator`

## Expected Output

```
============================================================
Daytona Snapshot Test Suite
============================================================

ℹ Testing snapshot: pablokortix/suna:0.1.3.28
ℹ Image name: pablokortix/suna:0.1.3.28

============================================================
Testing Daytona Connection
============================================================

ℹ Snapshot name: pablokortix/suna:0.1.3.28
✓ Daytona connection successful (found X existing sandboxes)

============================================================
Testing Sandbox Creation
============================================================

ℹ Creating test sandbox...
✓ Sandbox created successfully!
ℹ Sandbox ID: <sandbox-id>
ℹ Sandbox State: STARTED

============================================================
Testing /skills Directory
============================================================

ℹ Checking if /skills directory exists...
✓ /skills directory exists
ℹ Listing /skills directory contents...
✓ Directory listing:
  ...
✓ slack-gif-creator directory found
✓ Found X items in slack-gif-creator:
  - README.md
  - LICENSE.txt
  - core/
  ...

============================================================
Test Summary
============================================================

✓ Daytona connection: PASSED
✓ Sandbox creation: PASSED
✓ /skills directory: PASSED

✅ All tests passed!
```

## Troubleshooting

### "Snapshot not found" error
- Verify snapshot exists in Daytona dashboard
- Check snapshot name matches exactly: `pablokortix/suna:0.1.3.28`
- Ensure snapshot status is "Active"

### "Daytona connection failed"
- Check `DAYTONA_API_KEY` is set
- Check `DAYTONA_SERVER_URL` is correct
- Verify you can access Daytona dashboard

### "/skills directory not found"
- Verify Docker image was built with the `/skills` setup
- Check Dockerfile includes the sparse checkout steps
- Rebuild and push the Docker image

## Cleanup

The script will ask if you want to delete the test sandbox. If you choose "no", you can delete it manually from the Daytona dashboard.

