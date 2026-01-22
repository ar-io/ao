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

For integration tests, we recommend using a testcontainers approach that waits for the CU to be ready before running assertions.

### Wait-for-CU Script

Create a script that waits for the CU to have evaluated a process:

```bash
#!/bin/bash
# scripts/wait-for-cu.sh

PROCESS_ID="${1:?Process ID required}"
CU_URL="${CU_URL:-http://localhost:6363}"
TIMEOUT="${TIMEOUT:-300}"
POLL_INTERVAL="${POLL_INTERVAL:-5}"

echo "Waiting for CU to evaluate process: $PROCESS_ID"

start_time=$(date +%s)
while true; do
  current_time=$(date +%s)
  elapsed=$((current_time - start_time))
  
  if [ $elapsed -ge $TIMEOUT ]; then
    echo "Timeout waiting for CU after ${TIMEOUT}s"
    exit 1
  fi
  
  # Trigger state evaluation and check response
  response=$(curl -s -w "\n%{http_code}" "$CU_URL/state/$PROCESS_ID" 2>/dev/null)
  http_code=$(echo "$response" | tail -n1)
  body=$(echo "$response" | sed '$d')
  
  if [ "$http_code" = "200" ]; then
    # Check if we have ordinate (evaluation progress)
    ordinate=$(echo "$body" | jq -r '.ordinate // empty' 2>/dev/null)
    if [ -n "$ordinate" ] && [ "$ordinate" != "null" ]; then
      echo "CU ready! Process evaluated to ordinate: $ordinate"
      exit 0
    fi
  fi
  
  echo "Waiting... (${elapsed}s elapsed, status: $http_code)"
  sleep $POLL_INTERVAL
done
```

### Wait-for-Verification Script

Wait for verification data to be available:

```bash
#!/bin/bash
# scripts/wait-for-verification.sh

PROCESS_ID="${1:?Process ID required}"
CRANK_CHECK_URL="${CRANK_CHECK_URL:-http://localhost:3000}"
MIN_MESSAGES="${MIN_MESSAGES:-1}"
TIMEOUT="${TIMEOUT:-180}"
POLL_INTERVAL="${POLL_INTERVAL:-5}"

echo "Waiting for verification data for process: $PROCESS_ID"

start_time=$(date +%s)
while true; do
  current_time=$(date +%s)
  elapsed=$((current_time - start_time))
  
  if [ $elapsed -ge $TIMEOUT ]; then
    echo "Timeout waiting for verification data after ${TIMEOUT}s"
    exit 1
  fi
  
  response=$(curl -s "$CRANK_CHECK_URL/stats/$PROCESS_ID" 2>/dev/null)
  total=$(echo "$response" | jq -r '.total // 0' 2>/dev/null)
  
  if [ "$total" -ge "$MIN_MESSAGES" ]; then
    echo "Verification data ready! Total messages: $total"
    echo "$response" | jq .
    exit 0
  fi
  
  echo "Waiting... (${elapsed}s elapsed, total: $total)"
  sleep $POLL_INTERVAL
done
```

### Docker Compose Test Setup

```yaml
# docker-compose.test.yml
services:
  ao-cu-verifier:
    image: ghcr.io/atticusofsparta/ao-cu-verifier:latest
    environment:
      # ... your config
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:6363/"]
      interval: 10s
      timeout: 5s
      retries: 30
      start_period: 30s

  ao-crank-check:
    image: ghcr.io/atticusofsparta/ao-crank-check:latest
    depends_on:
      ao-cu-verifier:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 5s
      timeout: 3s
      retries: 10

  test-runner:
    image: curlimages/curl:latest
    depends_on:
      ao-crank-check:
        condition: service_healthy
    entrypoint: ["/bin/sh", "-c"]
    command:
      - |
        echo "Triggering state evaluation..."
        curl -s "http://ao-cu-verifier:6363/state/$PROCESS_ID"
        
        echo "Waiting for verification..."
        sleep 90
        
        echo "Checking stats..."
        curl -s "http://ao-crank-check:3000/stats/$PROCESS_ID" | jq .
```

### Node.js Testcontainers Example

```typescript
import { GenericContainer, Wait, Network } from 'testcontainers';

describe('Crank Check Integration', () => {
  let cuContainer: StartedTestContainer;
  let crankCheckContainer: StartedTestContainer;
  let network: StartedNetwork;

  beforeAll(async () => {
    network = await new Network().start();

    cuContainer = await new GenericContainer('ghcr.io/atticusofsparta/ao-cu-verifier:latest')
      .withNetwork(network)
      .withNetworkAliases('cu')
      .withEnvironment({
        WALLET: process.env.WALLET!,
        ALLOW_PROCESSES: process.env.TEST_PROCESS_ID!,
        VERIFIER_PROCESS_IDS: process.env.TEST_PROCESS_ID!,
        VERIFIER_USE_CACHE: '/db/ao-cache.sqlite',
        MESSAGE_TRACKING_ENABLED: 'true',
      })
      .withExposedPorts(6363)
      .withWaitStrategy(Wait.forHttp('/', 6363).forStatusCode(200))
      .start();

    crankCheckContainer = await new GenericContainer('ghcr.io/atticusofsparta/ao-crank-check:latest')
      .withNetwork(network)
      .withEnvironment({
        VERIFICATION_DB_DIR: '/data/verification',
      })
      .withBindMounts([{
        source: await cuContainer.exec(['cat', '/data/verification']),
        target: '/data/verification',
        mode: 'ro',
      }])
      .withExposedPorts(3000)
      .withWaitStrategy(Wait.forHttp('/health', 3000))
      .start();
  }, 120000);

  it('should return stats after state evaluation', async () => {
    const cuUrl = `http://${cuContainer.getHost()}:${cuContainer.getMappedPort(6363)}`;
    const crankUrl = `http://${crankCheckContainer.getHost()}:${crankCheckContainer.getMappedPort(3000)}`;
    
    // Trigger state evaluation
    await fetch(`${cuUrl}/state/${process.env.TEST_PROCESS_ID}`);
    
    // Wait for verification cycle
    await new Promise(resolve => setTimeout(resolve, 90000));
    
    // Check stats
    const response = await fetch(`${crankUrl}/stats/${process.env.TEST_PROCESS_ID}`);
    const stats = await response.json();
    
    expect(stats.total).toBeGreaterThan(0);
  }, 180000);

  afterAll(async () => {
    await crankCheckContainer?.stop();
    await cuContainer?.stop();
    await network?.stop();
  });
});
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
