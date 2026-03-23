import { execSync } from 'node:child_process'
import Database from 'better-sqlite3'
import { createDb } from './db.js'
import { getLatestCheckpoint, findCheckpointAtNonce, findCheckpointAfterNonce } from './gql.js'

const PROCESS_ID = process.env.PROCESS_ID || 'qNvAoz0TgcH7DMg8BCVn8jF32QH5L6T29VjHxhHqqGE'
const NONCE_THRESHOLD = parseInt(process.env.NONCE_THRESHOLD || '1000', 10)
const GRAPHQL_URL = process.env.GRAPHQL_URL || 'https://arweave-search.goldsky.com/graphql'
const DB_PATH = process.env.DB_PATH || '/data/checkpoints.sqlite'
const BUNDLER_URL = process.env.BUNDLER_URL || 'https://upload.ardrive.io'
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '60000', 10)
const INDEX_POLL_MAX_ATTEMPTS = 5 // 5 attempts * 1 minute = 5 minutes
const AO_CACHE_DB_PATH = process.env.AO_CACHE_DB_PATH || '/usr/app/db/ao-cache.sqlite'
const DRY_RUN = process.env.DRY_RUN === 'true'
const CU_URL = process.env.CU_URL || 'http://localhost:6363'
const CHECKPOINT_TRUSTED_OWNERS = process.env.CHECKPOINT_TRUSTED_OWNERS
  ? process.env.CHECKPOINT_TRUSTED_OWNERS.split(',').map(s => s.trim()).filter(Boolean)
  : []

function log (...args) {
  console.log(`[${new Date().toISOString()}]`, ...args)
}

/**
 * Read the latest evaluation for a process from the CU's ao-cache.sqlite.
 * Returns { nonce, evaluatedAt } so callers can assess freshness.
 *
 * evaluatedAt is the timestamp (ms) when the CU wrote this evaluation.
 * If the CU restarted and hasn't caught up yet, the highest nonce will
 * have a stale evaluatedAt from a previous run. We use this to detect
 * whether the CU is actively hydrated to that nonce.
 */
function readLatestEvaluationFromCu (processId) {
  try {
    const cacheDb = new Database(AO_CACHE_DB_PATH, { readonly: true })
    const row = cacheDb.prepare(
      'SELECT nonce, evaluatedAt FROM evaluations WHERE processId = ? ORDER BY nonce DESC LIMIT 1'
    ).get(processId)
    cacheDb.close()
    return row || null
  } catch (err) {
    log('Error reading ao-cache.sqlite:', err.message)
    return null
  }
}

/**
 * Fetch the CU's wallet address from its healthcheck endpoint
 * and combine with any additional trusted owners from config.
 */
async function getTrustedOwners () {
  let cuAddress = null
  try {
    const res = await fetch(CU_URL)
    if (!res.ok) throw new Error(`CU healthcheck returned ${res.status}`)
    const { address } = await res.json()
    if (!address) throw new Error('No address in CU healthcheck response')
    cuAddress = address
    log(`CU wallet address: ${cuAddress}`)
  } catch (err) {
    log('Error fetching CU wallet address:', err.message)
  }

  const owners = new Set([
    ...(cuAddress ? [cuAddress] : []),
    ...CHECKPOINT_TRUSTED_OWNERS
  ])

  if (owners.size === 0) return null
  return [...owners]
}

function sendCheckpointSignal () {
  try {
    const pid = execSync('pgrep -f "^node.*app.js"', { encoding: 'utf-8' }).trim()
    if (!pid) throw new Error('Could not find CU node process')
    log(`Sending SIGUSR2 to CU process (PID ${pid})`)
    process.kill(parseInt(pid, 10), 'SIGUSR2')
    return true
  } catch (err) {
    log('Failed to send SIGUSR2:', err.message)
    return false
  }
}

/**
 * Poll GQL for index info on pending checkpoints.
 * Returns true if there are still pending checkpoints that need more polling.
 */
async function pollPendingCheckpoints (db, owners) {
  const pending = db.getPendingCheckpoints()
  if (pending.length === 0) return false

  log(`Found ${pending.length} checkpoint(s) awaiting index info. Searching owners: [${owners.join(', ')}]`)

  for (const cp of pending) {
    try {
      log(`Polling for checkpoint: process=${cp.process_id} nonce=${cp.last_known_nonce} requested=${cp.time_requested}`)

      // First try exact nonce match
      let result = await findCheckpointAtNonce(GRAPHQL_URL, cp.process_id, cp.last_known_nonce, owners)

      // If no exact match, check if a checkpoint with higher nonce exists
      // (the CU may have checkpointed at a slightly different nonce than we recorded)
      if (!result) {
        result = await findCheckpointAfterNonce(GRAPHQL_URL, cp.process_id, cp.last_known_nonce - 100, owners)
        if (result && result.nonce < cp.last_known_nonce) result = null
      }

      if (result) {
        log(`Checkpoint indexed: process=${cp.process_id} nonce=${result.nonce} txId=${result.dataItemId} blockHeight=${result.blockHeight} owner=${result.owner || 'unknown'}`)
        db.updateCheckpointIndexInfo(cp.id, result.dataItemId, result.blockHeight)
      } else {
        log(`Checkpoint not yet indexed: process=${cp.process_id} nonce=${cp.last_known_nonce} (searching owners: [${owners.join(', ')}])`)
      }
    } catch (err) {
      log(`Error polling checkpoint index info for id=${cp.id}:`, err.message)
    }
  }

  return db.getPendingCheckpoints().length > 0
}

async function checkAndMaybeCheckpoint (db, owners) {
  // Expire pending checkpoints older than 1 hour (upload likely failed)
  const expired = db.expireStalePendingCheckpoints(PROCESS_ID)
  if (expired.changes > 0) {
    log(`Expired ${expired.changes} stale pending checkpoint(s)`)
  }

  // Step 1: Get latest evaluation from the CU's ao-cache.sqlite
  const latest = readLatestEvaluationFromCu(PROCESS_ID)
  if (!latest) {
    log('Could not determine latest evaluation from ao-cache.sqlite. Skipping cycle.')
    return
  }

  const { nonce: latestNonce, evaluatedAt } = latest
  const age = Date.now() - evaluatedAt
  log(`Latest nonce for process: ${latestNonce} (evaluatedAt: ${new Date(evaluatedAt).toISOString()}, age: ${Math.round(age / 1000)}s)`)

  // Step 2: If we already have a pending (unconfirmed) checkpoint, don't trigger another
  if (db.hasPendingCheckpoint(PROCESS_ID)) {
    log('A checkpoint request is already pending confirmation. Skipping.')
    return
  }

  // Step 3: Determine the nonce of the last confirmed checkpoint (from our DB or GQL)
  let lastCheckpointNonce = null
  const dbCheckpoint = db.getLatestConfirmedCheckpoint(PROCESS_ID)
  if (dbCheckpoint) {
    lastCheckpointNonce = dbCheckpoint.last_known_nonce
    log(`Last confirmed checkpoint nonce (from local DB): ${lastCheckpointNonce} txId=${dbCheckpoint.data_item_id}`)
  } else {
    // No local record; check GQL for existing checkpoints
    try {
      const gqlCheckpoint = await getLatestCheckpoint(GRAPHQL_URL, PROCESS_ID, owners)
      if (gqlCheckpoint) {
        lastCheckpointNonce = gqlCheckpoint.nonce
        log(`Last checkpoint nonce (from GQL): ${lastCheckpointNonce} txId=${gqlCheckpoint.dataItemId} owner=${gqlCheckpoint.owner}`)
      } else {
        log('No existing checkpoints found on GQL. Assuming nonce 0.')
        lastCheckpointNonce = 0
      }
    } catch (err) {
      log('Error fetching latest checkpoint from GQL:', err.message)
      log('Cannot determine last checkpoint nonce. Skipping cycle.')
      return
    }
  }

  // Step 4: Check if threshold is met
  const noncesSinceCheckpoint = latestNonce - lastCheckpointNonce
  log(`Nonces since last checkpoint: ${noncesSinceCheckpoint} (threshold: ${NONCE_THRESHOLD})`)

  if (noncesSinceCheckpoint < NONCE_THRESHOLD) {
    log('Threshold not met. Skipping.')
    return
  }

  // Step 5: Send SIGUSR2 and record the checkpoint request
  if (DRY_RUN) {
    log(`[DRY RUN] Would trigger checkpoint at nonce ${latestNonce} (SIGUSR2 not sent, DB not updated)`)
    return
  }
  log(`Threshold met! Triggering checkpoint at nonce ${latestNonce}`)
  const sent = sendCheckpointSignal()
  if (sent) {
    db.insertCheckpointRequest(PROCESS_ID, latestNonce, BUNDLER_URL)
    log('Checkpoint request recorded.')
  }
}

async function mainLoop () {
  log('Starting checkpointer sidecar')
  log(`Process ID: ${PROCESS_ID}`)
  log(`Nonce threshold: ${NONCE_THRESHOLD}`)
  log(`GraphQL endpoint: ${GRAPHQL_URL}`)
  log(`DB path: ${DB_PATH}`)
  log(`Bundler URL: ${BUNDLER_URL}`)
  log(`Poll interval: ${POLL_INTERVAL_MS}ms`)
  log(`AO cache DB: ${AO_CACHE_DB_PATH}`)
  log(`CU URL: ${CU_URL}`)
  if (CHECKPOINT_TRUSTED_OWNERS.length > 0) log(`Additional trusted owners: [${CHECKPOINT_TRUSTED_OWNERS.join(', ')}]`)
  if (DRY_RUN) log('DRY RUN MODE: will not send signals or write to checkpoint DB')

  const db = createDb(DB_PATH)

  process.on('SIGTERM', () => {
    log('Received SIGTERM. Shutting down.')
    db.close()
    process.exit(0)
  })

  process.on('SIGINT', () => {
    log('Received SIGINT. Shutting down.')
    db.close()
    process.exit(0)
  })

  while (true) {
    try {
      // Resolve trusted owners (CU wallet + configured owners)
      const owners = await getTrustedOwners()
      if (!owners) {
        log('Could not determine trusted owners. Skipping cycle.')
        await sleep(POLL_INTERVAL_MS)
        continue
      }
      log(`Trusted checkpoint owners: [${owners.join(', ')}]`)

      // Phase 1: Poll for index info on pending checkpoints
      // Keep polling once per minute for up to 5 minutes
      let hasPending = await pollPendingCheckpoints(db, owners)
      let pollAttempts = 0
      while (hasPending && pollAttempts < INDEX_POLL_MAX_ATTEMPTS - 1) {
        pollAttempts++
        log(`Pending checkpoints still unresolved. Polling again (${pollAttempts}/${INDEX_POLL_MAX_ATTEMPTS - 1})...`)
        await sleep(POLL_INTERVAL_MS)
        hasPending = await pollPendingCheckpoints(db, owners)
      }

      // Phase 2: Check if it's time to checkpoint
      await checkAndMaybeCheckpoint(db, owners)
    } catch (err) {
      log('Unexpected error in main loop:', err.message)
    }

    await sleep(POLL_INTERVAL_MS)
  }
}

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

mainLoop()
