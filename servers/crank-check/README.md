# AO Crank Check

A verification and monitoring stack for AO process output messages. This system tracks whether output messages from AO process evaluations have been properly "cranked" (published to Arweave).

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Docker Compose Stack                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              ao-cu-verifier (port 6363)                 │   │
│  │  ┌───────────────┐  ┌─────────────────────────────────┐ │   │
│  │  │   AO CU       │  │     Message Verifier(s)         │ │   │
│  │  │               │──│  - Syncs from ao-cache.sqlite   │ │   │
│  │  │ MESSAGE_      │  │  - Checks Arweave for messages  │ │   │
│  │  │ TRACKING=true │  │  - Writes to verification DB    │ │   │
│  │  └───────────────┘  └─────────────────────────────────┘ │   │
│  │         │                        │                       │   │
│  │         ▼                        ▼                       │   │
│  │    /db/ao-cache.sqlite    /data/verification/*.sqlite    │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                    │                            │
│                    ┌───────────────┘                            │
│                    ▼ (shared volume)                            │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              ao-crank-check (port 3000)                 │   │
│  │                                                         │   │
│  │  REST API for querying verification status              │   │
│  │  - GET /stats/:processId                                │   │
│  │  - GET /messages/:processId                             │   │
│  │  - GET /health                                          │   │
│  │  - GET /api-docs (Swagger UI)                           │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Quick Start

### 1. Create your environment file

```bash
cp env.example .env
```

Edit `.env` with your configuration:

```bash
# Required: Your Arweave wallet JSON (inline)
WALLET='{"kty":"RSA",...}'

# Required: Process IDs to evaluate and verify
ALLOW_PROCESSES=your-process-id-here
VERIFIER_PROCESS_IDS=your-process-id-here

# Required for historical sync (recommended)
VERIFIER_USE_CACHE=/db/ao-cache.sqlite
```

### 2. Start the stack

```bash
docker compose --env-file .env -f docker-compose.example.yml up -d
```

### 3. Trigger state evaluation

The CU needs to evaluate a process before verification data is available:

```bash
curl "http://localhost:6363/state/YOUR_PROCESS_ID"
```

### 4. Check verification stats

```bash
curl "http://localhost:3000/stats/YOUR_PROCESS_ID" | jq .
```

## Published Images

| Image | Description |
|-------|-------------|
| `ghcr.io/atticusofsparta/ao-cu-verifier:latest` | CU with message tracking + verifier |
| `ghcr.io/atticusofsparta/ao-crank-check:latest` | Read-only API for verification data |

## Environment Variables

### CU Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `WALLET` | Arweave wallet JSON (inline) | Required |
| `WALLET_FILE` | Path to wallet file (alternative to inline) | - |
| `ALLOW_PROCESSES` | Comma-separated process IDs to evaluate | Required |
| `GATEWAY_URL` | Arweave gateway URL | `https://arweave.net` |
| `GRAPHQL_URL` | GraphQL endpoint for queries | `https://arweave-search.goldsky.com/graphql` |
| `CHECKPOINT_GRAPHQL_URL` | GraphQL endpoint for checkpoints | Same as GRAPHQL_URL |
| `PROCESS_WASM_MEMORY_MAX_LIMIT` | Max WASM memory (bytes) | `17179869184` (16GB) |
| `PROCESS_WASM_COMPUTE_MAX_LIMIT` | Max compute limit | `9000000000000` |
| `PROCESS_CHECKPOINT_TRUSTED_OWNERS` | Trusted checkpoint wallet addresses | - |
| `DISABLE_PROCESS_FILE_CHECKPOINT_CREATION` | Disable file checkpoints | `false` |
| `DISABLE_PROCESS_CHECKPOINT_CREATION` | Disable all checkpoints | `false` |

### Verifier Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `VERIFIER_PROCESS_IDS` | Comma-separated process IDs to verify | Required for verification |
| `VERIFIER_USE_CACHE` | Path to ao-cache.sqlite for historical sync | - |
| `VERIFIER_INTERVAL_MS` | Milliseconds between verification cycles | `60000` |
| `VERIFIER_BATCH_SIZE` | Messages to verify per cycle | `100` |
| `VERIFIER_RETRY_AFTER_MINUTES` | Minutes before retrying unfound messages | `10` |
| `VERIFIER_STARTUP_DELAY` | Seconds to wait before starting verifiers | `30` |
| `VERIFIER_RESTART_DELAY` | Seconds to wait before restarting failed verifier | `60` |

### Crank Check Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | API server port | `3000` |
| `VERIFICATION_DB_DIR` | Directory containing verification DBs | `/data/verification` |

### Port Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `CU_PORT` | Host port for CU | `6363` |
| `CRANK_CHECK_PORT` | Host port for crank-check API | `3000` |

## API Endpoints

### `GET /stats/:processId`

Returns aggregate verification statistics.

```json
{
  "processId": "ijCygKzV48PHx_TUdFN7NNJgbBUatQDL_h8FfqVzXfE",
  "total": 148,
  "discovered": 24,
  "corrupted": 0,
  "uncrankableWallet": 121,
  "uncrankableTags": 0,
  "pending": 0,
  "needsRetry": 3,
  "discoveryRate": "16.22%",
  "minNonce": 6,
  "maxNonce": 113
}
```

| Field | Description |
|-------|-------------|
| `total` | Total output messages tracked |
| `discovered` | Messages found on Arweave (successfully cranked) |
| `corrupted` | Messages found but with tag mismatches |
| `uncrankableWallet` | Messages targeting wallets (won't be cranked) |
| `uncrankableTags` | Messages with numeric tag values (can't be cranked) |
| `pending` | Messages not yet checked |
| `needsRetry` | Messages checked but not found, awaiting retry |

### `GET /messages/:processId`

Query individual verification messages with filtering and pagination.

**Query Parameters:**

| Parameter | Description |
|-----------|-------------|
| `input_message_id` | Filter by input message ID |
| `nonce` | Filter by nonce |
| `cranked` | `true` or `false` - filter by discovery status |
| `after` | Filter `input_message_timestamp > value` (ms) |
| `before` | Filter `input_message_timestamp < value` (ms) |
| `cursor` | Pagination cursor (timestamp ms) |
| `limit` | Max rows (default 100, max 1000) |

### `GET /health`

Health check endpoint.

### `GET /api-docs`

Swagger UI for interactive API documentation.

## Testing with Testcontainers

Uses the Docker Compose file directly with testcontainers:

```typescript
// crank-check.integration.spec.ts
import { DockerComposeEnvironment, Wait } from 'testcontainers';
import { resolve } from 'path';

const COMPOSE_DIR = resolve(__dirname, '..');
const TEST_PROCESS_ID = process.env.TEST_PROCESS_ID!;

interface CrankCheckStats {
  processId: string;
  total: number;
  discovered: number;
  corrupted: number;
  uncrankableWallet: number;
  uncrankableTags: number;
  pending: number;
  needsRetry: number;
  discoveryRate: string;
  minNonce: number | null;
  maxNonce: number | null;
}

/** Poll an endpoint until condition is met */
async function waitFor<T>(
  url: string,
  check: (data: T) => boolean,
  timeout = 120000,
  interval = 5000
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json() as T;
        if (check(data)) return data;
      }
    } catch { /* keep polling */ }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`Timeout waiting for ${url}`);
}

describe('Crank Check Integration', () => {
  let environment: Awaited<ReturnType<DockerComposeEnvironment['up']>>;
  let cuUrl: string;
  let crankCheckUrl: string;

  beforeAll(async () => {
    environment = await new DockerComposeEnvironment(COMPOSE_DIR, 'docker-compose.example.yml')
      .withEnvironment({
        WALLET: process.env.WALLET!,
        ALLOW_PROCESSES: TEST_PROCESS_ID,
        VERIFIER_PROCESS_IDS: TEST_PROCESS_ID,
        VERIFIER_USE_CACHE: '/db/ao-cache.sqlite',
      })
      .withWaitStrategy('ao-cu-verifier-1', Wait.forHttp('/', 6363))
      .withWaitStrategy('ao-crank-check-1', Wait.forHttp('/health', 3000))
      .up();

    const cuContainer = environment.getContainer('ao-cu-verifier-1');
    const crankContainer = environment.getContainer('ao-crank-check-1');

    cuUrl = `http://${cuContainer.getHost()}:${cuContainer.getMappedPort(6363)}`;
    crankCheckUrl = `http://${crankContainer.getHost()}:${crankContainer.getMappedPort(3000)}`;
  }, 180000);

  afterAll(async () => {
    await environment?.down();
  });

  it('should return stats after triggering state evaluation', async () => {
    // Trigger CU to evaluate the process
    await fetch(`${cuUrl}/state/${TEST_PROCESS_ID}`);

    // Wait for verification data to be populated
    const stats = await waitFor<CrankCheckStats>(
      `${crankCheckUrl}/stats/${TEST_PROCESS_ID}`,
      (s) => s.total > 0,
      180000
    );

    expect(stats.processId).toBe(TEST_PROCESS_ID);
    expect(stats.total).toBeGreaterThan(0);
  }, 300000);
});
```

**Run with:**

```bash
TEST_PROCESS_ID=your-process-id WALLET='{"kty":"RSA",...}' npx vitest run
```

**Required devDependencies:**

```json
{
  "devDependencies": {
    "testcontainers": "^10.0.0",
    "vitest": "^1.0.0"
  }
}
```

## Tuning Guide

### For High-Volume Processes

```bash
# Increase batch size for faster sync
VERIFIER_BATCH_SIZE=500

# Reduce interval for more frequent checks
VERIFIER_INTERVAL_MS=30000

# Increase memory for large processes
PROCESS_WASM_MEMORY_MAX_LIMIT=34359738368  # 32GB
```

### For Multiple Processes

```bash
# Verify multiple processes
VERIFIER_PROCESS_IDS=process1,process2,process3

# Each gets its own verifier loop
ALLOW_PROCESSES=process1,process2,process3
```

### For Cold Start Optimization

```bash
# Longer startup delay if CU takes time to initialize
VERIFIER_STARTUP_DELAY=60

# Shorter restart delay for faster recovery
VERIFIER_RESTART_DELAY=30

# Use cache for immediate historical sync
VERIFIER_USE_CACHE=/db/ao-cache.sqlite
```

## Troubleshooting

### Verifier keeps restarting

This is normal on cold start. The verifier will restart every 60 seconds until the CU has evaluated data in the cache DB.

**Solution:** Trigger `/state/:processId` to populate the cache.

### Stats show 0 messages

The verification DB is empty because:
1. CU hasn't evaluated the process yet
2. Verifier hasn't completed a sync cycle

**Solution:**
```bash
# 1. Trigger evaluation
curl "http://localhost:6363/state/YOUR_PROCESS_ID"

# 2. Wait for verifier cycle (check logs)
docker logs crank-check-ao-cu-verifier-1 -f
```

### "No verification DB found"

The crank-check API can't find the SQLite file for that process.

**Solutions:**
- Verify the process ID is correct
- Check that verification volume is shared correctly
- Ensure verifier has synced at least one message

### High uncrankableWallet count

This is expected! Messages targeting wallet addresses (not processes) cannot be cranked by the network. The verifier marks these appropriately.

## Development

### Building locally

```bash
# Build CU verifier image
cd ../cu
docker build -f Dockerfile.verifier -t ao-cu-verifier:local .

# Build crank-check image
cd ../crank-check
docker build -t ao-crank-check:local .
```

### Running with local images

```bash
docker compose --env-file .env -f docker-compose.local.yml up
```

## License

See repository root for license information.
