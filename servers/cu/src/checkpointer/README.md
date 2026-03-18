# CU Checkpointer Sidecar

A sidecar service that monitors an ao Compute Unit and triggers Arweave
checkpoint uploads when a configurable number of new nonces have been
processed.

<!-- toc -->

- [How it works](#how-it-works)
- [Prerequisites](#prerequisites)
- [Usage](#usage)
- [Environment Variables](#environment-variables)
- [Database Schema](#database-schema)
- [Architecture](#architecture)
- [Safety](#safety)

<!-- tocstop -->

## How it works

The checkpointer runs as a Docker container that shares the CU's PID
namespace. On each polling cycle it:

1. **Checks for pending checkpoint confirmations.** If a previous cycle
   triggered a checkpoint, it polls Goldsky's GraphQL index (up to 5
   minutes) to find the resulting data item ID and block height, then
   records them in its local SQLite database.

2. **Reads the CU's current evaluation state.** It opens the CU's
   `ao-cache.sqlite` (mounted read-only) and queries the `evaluations`
   table for the highest nonce and its `evaluatedAt` timestamp.

3. **Checks freshness.** If the latest evaluation was written more than
   `STALE_THRESHOLD_MS` ago, the CU is likely still catching up from a
   checkpoint and doesn't have that nonce hydrated in WASM memory. The
   cycle is skipped.

4. **Compares against the last checkpoint.** It looks up the last
   checkpoint nonce from its own database (or falls back to querying
   Goldsky). If the difference exceeds `NONCE_THRESHOLD`, it's time to
   checkpoint.

5. **Sends SIGUSR2 to the CU.** Because the sidecar shares the CU's PID
   namespace, it can signal the CU's node process directly. The CU's
   built-in SIGUSR2 handler then checkpoints all processes in its WASM
   heap cache to Arweave.

## Prerequisites

The CU must have checkpoint creation enabled:

```
DISABLE_PROCESS_CHECKPOINT_CREATION=false
```

The CU's `PROCESS_CHECKPOINT_CREATION_THROTTLE` (default 30 minutes) still
applies. If the sidecar triggers SIGUSR2 more frequently than the throttle
allows, the CU will skip the duplicate upload.

## Usage

**Important:** Always use `-d` (detached mode) when starting the sidecar.
Running `docker compose up` without `-d` attaches to **all** services in
the project. If you then hit Ctrl+C, it will stop the CU server too, not
just the sidecar.

Start the sidecar alongside an already-running CU:

```sh
DRY_RUN=true docker compose --profile checkpointing up -d checkpointer
```

This does not restart or disrupt the CU server. Dry-run mode is the
default -- the sidecar runs the full loop (reads nonces, queries GraphQL,
evaluates the threshold) but logs what it *would* do instead of sending
SIGUSR2 or writing to its database.

View the sidecar's logs:

```sh
docker compose logs -f checkpointer
```

Ctrl+C here only exits the log viewer, not the containers.

Enable live checkpointing:

```sh
DRY_RUN=false docker compose --profile checkpointing up -d checkpointer
```

Stop only the sidecar:

```sh
docker compose --profile checkpointing stop checkpointer
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PROCESS_ID` | `qNvAoz0TgcH7DMg8BCVn8jF32QH5L6T29VjHxhHqqGE` | The ao process ID to monitor and checkpoint. |
| `NONCE_THRESHOLD` | `1000` | Minimum nonces since last checkpoint before triggering a new one. |
| `GRAPHQL_URL` | `https://arweave-search.goldsky.com/graphql` | Arweave GraphQL endpoint for querying checkpoint index info. |
| `DB_PATH` | `/data/checkpoints.sqlite` | Path to the sidecar's own SQLite database (persisted via volume). |
| `BUNDLER_URL` | `https://upload.ardrive.io` | Recorded in the database for reference (the CU uses its own `UPLOADER_URL`). |
| `POLL_INTERVAL_MS` | `60000` | Milliseconds between polling cycles. |
| `STALE_THRESHOLD_MS` | `600000` (10 min) | If the CU's latest evaluation is older than this, assume it is catching up and skip the cycle. |
| `DRY_RUN` | `true` | When `true`, logs decisions without sending signals or writing to the database. |
| `AO_CACHE_DB_PATH` | `/usr/app/db/ao-cache.sqlite` | Path to the CU's cache database (mounted read-only). |

All variables can be set in your `.env` file or passed directly to
`docker compose`.

## Database Schema

The sidecar maintains its own SQLite database at `DB_PATH` with a single
`checkpoints` table:

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER | Auto-incrementing primary key. |
| `process_id` | TEXT | The ao process ID. |
| `time_requested` | TEXT | ISO timestamp of when the checkpoint was triggered. |
| `last_known_nonce` | INTEGER | The nonce the CU was at when the checkpoint was requested. |
| `bundler_url` | TEXT | The bundler URL recorded for reference. |
| `data_item_id` | TEXT | The Arweave data item ID, populated after indexing confirms the upload. |
| `block_height` | INTEGER | The Arweave block height, populated after indexing. |

You can inspect it directly:

```sh
docker exec <checkpointer-container> sqlite3 /data/checkpoints.sqlite \
  "SELECT * FROM checkpoints ORDER BY id DESC LIMIT 10;"
```

## Architecture

```
                          shared PID namespace
  +------------------+  <--------------------->  +------------------+
  |   checkpointer   |                           |    CU (server)   |
  |                  |  -- SIGUSR2 signal ------> |                  |
  |  reads ao-cache  |                           |  checkpoints to  |
  |  (read-only)     |                           |  Arweave         |
  +------------------+                           +------------------+
         |                                              |
         | polls for index info                         | uploads checkpoint
         v                                              v
  +------------------+                           +------------------+
  |  Goldsky GraphQL |                           |  Arweave/Bundler |
  +------------------+                           +------------------+
```

## Safety

- **Stale evaluation guard.** The sidecar checks the `evaluatedAt`
  timestamp of the CU's latest evaluation. If it is stale, the CU likely
  restarted and is re-evaluating from a prior checkpoint. No signal is
  sent until the CU has freshly evaluated to the latest nonce.

- **No duplicate uploads.** The CU's own `PROCESS_CHECKPOINT_CREATION_THROTTLE`
  prevents duplicate Arweave uploads even if SIGUSR2 is sent multiple times.
  The CU also checks the gateway for an existing checkpoint at the same
  nonce before uploading.

- **Dry-run by default.** The sidecar starts in dry-run mode so you can
  observe its behavior before enabling live checkpointing.

- **Read-only DB access.** The sidecar mounts the CU's database directory
  read-only. It cannot modify the CU's state.
