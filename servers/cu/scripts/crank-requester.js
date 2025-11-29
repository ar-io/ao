#!/usr/bin/env node

/**
 * Crank Requester Script
 *
 * Queries the crank-check service for messages that need cranking,
 * then sends requests to the AO control API to resolve unpushed messages.
 *
 * Usage:
 *   node scripts/crank-requester.js <processId> --service-url <url> [options]
 *
 * Options:
 *   --service-url <url>        URL of the crank-check service (required)
 *   --crank-url <url>          URL of the crank API (default: https://aocontrol.ao-testnet.xyz/api/resolve-unpushed)
 *   --auth-token <token>       Authorization bearer token for crank API (required)
 *   --start-time <timestamp>   Start timestamp (ms) for the search window
 *   --lookback-minutes <n>     Minutes back from now to search (default: 1440 = 24 hours)
 *   --batch-size <n>           Number of messages per query (default: 100)
 *   --max-per-min <n>          Max crank requests per minute (default: 60)
 *   --max-ids <n>              Stop after processing this many rows
 *   --skip-file <path>         CSV file with nonce,reference of messages to skip (from will-never-crank.js)
 *   --once                     Run one cycle and exit
 *   --dry-run                  Query but don't send crank requests
 *
 * Examples:
 *   node scripts/crank-requester.js qNvAoz0TgcH7DMg8BCVn8jF32QH5L6T29VjHxhHqqGE \
 *     --service-url http://localhost:3000 \
 *     --auth-token "your-token" \
 *     --lookback-minutes 60 \
 *     --dry-run
 */

import { readFileSync } from 'node:fs'

// Cancellable sleep that resolves immediately if shutdown is requested
let shutdownRequested = false
let shutdownResolvers = []

const sleep = (ms) => new Promise(resolve => {
  if (shutdownRequested) {
    resolve()
    return
  }

  const timeout = setTimeout(resolve, ms)
  const shutdownResolver = () => {
    clearTimeout(timeout)
    resolve()
  }
  shutdownResolvers.push(shutdownResolver)
})

const requestShutdown = () => {
  shutdownRequested = true
  shutdownResolvers.forEach(resolve => resolve())
  shutdownResolvers = []
}

function parseArgs () {
  const args = process.argv.slice(2)

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(`
Crank Requester - Request re-cranking for unverified messages

Usage:
  node scripts/crank-requester.js <processId> --service-url <url> --auth-token <token> [options]

Options:
  --service-url <url>        URL of the crank-check service (required)
  --crank-url <url>          URL of the crank API (default: https://aocontrol.ao-testnet.xyz/api/resolve-unpushed)
  --auth-token <token>       Authorization bearer token for crank API (required)
  --start-time <timestamp>   Start timestamp (ms) for the search window
  --lookback-minutes <n>     Minutes back from now to search (default: 1440 = 24 hours)
  --batch-size <n>           Number of messages per query (default: 100)
  --max-per-min <n>          Max crank requests per minute (default: 60)
  --max-ids <n>              Stop after processing this many rows
  --skip-file <path>         CSV file with nonce,reference of messages to skip
  --once                     Run one cycle and exit
  --dry-run                  Query but don't send crank requests

Examples:
  node scripts/crank-requester.js qNvAoz0TgcH7DMg8BCVn8jF32QH5L6T29VjHxhHqqGE \\
    --service-url http://localhost:3000 \\
    --auth-token "your-token" \\
    --lookback-minutes 60

  node scripts/crank-requester.js qNvAoz0TgcH7DMg8BCVn8jF32QH5L6T29VjHxhHqqGE \\
    --service-url http://localhost:3000 \\
    --auth-token "your-token" \\
    --dry-run --once
`)
    process.exit(0)
  }

  const processId = args[0]
  const options = {
    processId,
    serviceUrl: null,
    crankUrl: 'https://aocontrol.ao-testnet.xyz/api/resolve-unpushed',
    authToken: null,
    startTime: null,
    lookbackMinutes: 1440, // 24 hours
    batchSize: 100,
    maxPerMin: 60,
    maxIds: null,
    skipFile: null,
    once: false,
    dryRun: false
  }

  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case '--service-url':
        options.serviceUrl = args[++i]
        break
      case '--crank-url':
        options.crankUrl = args[++i]
        break
      case '--auth-token':
        options.authToken = args[++i]
        break
      case '--start-time':
        options.startTime = parseInt(args[++i], 10)
        break
      case '--lookback-minutes':
        options.lookbackMinutes = parseInt(args[++i], 10)
        break
      case '--batch-size':
        options.batchSize = parseInt(args[++i], 10)
        break
      case '--max-per-min':
        options.maxPerMin = parseInt(args[++i], 10)
        break
      case '--max-ids':
        options.maxIds = parseInt(args[++i], 10)
        break
      case '--skip-file':
        options.skipFile = args[++i]
        break
      case '--once':
        options.once = true
        break
      case '--dry-run':
        options.dryRun = true
        break
      default:
        console.error(`Unknown option: ${args[i]}`)
        process.exit(1)
    }
  }

  if (!options.serviceUrl) {
    console.error('Error: --service-url is required')
    process.exit(1)
  }

  if (!options.authToken && !options.dryRun) {
    console.error('Error: --auth-token is required (unless --dry-run)')
    process.exit(1)
  }

  return options
}

/**
 * Load skip list from CSV file
 * Returns a Set of nonces that should be skipped
 */
function loadSkipList (filePath) {
  const skipNonces = new Set()

  try {
    const content = readFileSync(filePath, 'utf-8')
    const lines = content.trim().split('\n')

    // Skip header row
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line) continue

      const [nonceStr] = line.split(',')
      const nonce = parseInt(nonceStr, 10)
      if (!isNaN(nonce)) {
        skipNonces.add(nonce)
      }
    }

    console.log(`Loaded ${skipNonces.size} nonces to skip from ${filePath}`)
  } catch (err) {
    console.error(`Error loading skip file: ${err.message}`)
    process.exit(1)
  }

  return skipNonces
}

async function fetchMessages (serviceUrl, processId, { cursor, before, limit }) {
  const params = new URLSearchParams({
    cranked: 'false',
    limit: String(limit)
  })

  if (cursor !== null) {
    // Send both cursor and after for compatibility with older service versions
    params.set('cursor', String(cursor))
    params.set('after', String(cursor))
  }

  if (before !== null) {
    params.set('before', String(before))
  }

  const url = `${serviceUrl}/messages/${processId}?${params.toString()}`

  const response = await fetch(url)

  if (!response.ok) {
    throw new Error(`Service request failed: ${response.status} ${response.statusText}`)
  }

  return response.json()
}

async function sendCrankRequest (crankUrl, authToken, txIds, processId, dryRun) {
  if (dryRun) {
    console.log(`[DRY RUN] Would send crank request for ${txIds.length} tx(s): ${txIds.slice(0, 3).join(', ')}${txIds.length > 3 ? '...' : ''}`)
    return { success: true, dryRun: true }
  }

  const response = await fetch(crankUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`
    },
    body: JSON.stringify({ txs: txIds, processes: [processId] })
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Crank request failed: ${response.status} ${response.statusText} - ${text}`)
  }

  return response.json()
}

async function runCycle (options, skipNonces = new Set()) {
  const {
    processId,
    serviceUrl,
    crankUrl,
    authToken,
    startTime,
    lookbackMinutes,
    batchSize,
    maxPerMin,
    maxIds,
    dryRun
  } = options

  // Calculate the time window
  const now = Date.now()
  const windowStart = startTime !== null ? startTime : (now - lookbackMinutes * 60 * 1000)
  const windowEnd = now

  // Limit batch size to max-ids if set
  const effectiveBatchSize = maxIds !== null ? Math.min(batchSize, maxIds) : batchSize

  console.log(`\nStarting cycle for process ${processId}`)
  console.log(`Time window: ${new Date(windowStart).toISOString()} to ${new Date(windowEnd).toISOString()}`)
  if (dryRun) {
    console.log('[DRY RUN MODE - no crank requests will be sent]')
  }

  // Track rate limiting (tx IDs per minute)
  let txIdsSentThisMinute = 0
  let minuteStartTime = Date.now()

  let cursor = windowStart - 1 // Start just before window to include first timestamp
  let totalRows = 0
  let totalUniqueIds = 0
  let totalCrankRequests = 0
  let done = false

  while (!done) {
    // Fetch a batch
    console.log(`\nFetching batch (cursor: ${cursor}, limit: ${effectiveBatchSize})...`)
    const result = await fetchMessages(serviceUrl, processId, {
      cursor,
      before: windowEnd,
      limit: effectiveBatchSize
    })

    console.log(`Received ${result.count} messages`)

    if (result.count === 0) {
      console.log('No more messages in window')
      break
    }

    totalRows += result.count

    // Log each message and whether it will be skipped or requested
    for (const msg of result.messages) {
      if (skipNonces.has(msg.nonce)) {
        console.log(`Skipping input message ${msg.input_message_id} with nonce ${msg.nonce} and output reference ${msg.output_message_reference} (in skip list)`)
      } else {
        console.log(`Requesting recrank for input message ${msg.input_message_id} with nonce ${msg.nonce} and output reference ${msg.output_message_reference}`)
      }
    }

    // Extract unique input message IDs, filtering out skipped nonces
    const filteredMessages = skipNonces.size > 0
      ? result.messages.filter(m => !skipNonces.has(m.nonce))
      : result.messages
    const skippedCount = result.messages.length - filteredMessages.length

    const uniqueInputIds = [...new Set(filteredMessages.map(m => m.input_message_id))]
    totalUniqueIds += uniqueInputIds.length

    if (skippedCount > 0) {
      console.log(`Unique input message IDs in batch: ${uniqueInputIds.length} (skipped ${skippedCount} messages)`)
    } else {
      console.log(`Unique input message IDs in batch: ${uniqueInputIds.length}`)
    }

    // Send crank request
    if (uniqueInputIds.length > 0) {
      try {
        const crankResult = await sendCrankRequest(crankUrl, authToken, uniqueInputIds, processId, dryRun)
        totalCrankRequests++
        if (!dryRun) {
          console.log(`Crank request sent successfully: ${JSON.stringify(crankResult)}`)
        }
      } catch (err) {
        console.error(`Crank request failed: ${err.message}`)
      }
    }

    // Check if we've hit max-ids limit
    if (maxIds !== null && totalRows >= maxIds) {
      console.log(`Reached max-ids limit (${maxIds})`)
      done = true
      break
    }

    // Update cursor for next batch
    if (result.nextCursor !== null && result.nextCursor !== undefined) {
      cursor = result.nextCursor
    } else {
      // Fallback: calculate cursor from max timestamp in batch
      const timestamps = result.messages
        .map(m => m.input_message_timestamp)
        .filter(t => t !== null && t !== undefined)

      if (timestamps.length === 0) {
        console.log('No more pages (no valid timestamps for cursor)')
        break
      }

      const maxTimestamp = Math.max(...timestamps)
      cursor = maxTimestamp
      console.log(`No nextCursor from service, using max timestamp: ${maxTimestamp}`)
    }

    // Check if we've made progress (avoid infinite loop on same batch)
    if (result.count < effectiveBatchSize) {
      console.log('Last page (fewer results than batch size)')
      break
    }

    // Rate limit delay based on tx IDs sent
    if (!done) {
      txIdsSentThisMinute += uniqueInputIds.length

      // Check if we need to wait for the rate limit
      const elapsedMs = Date.now() - minuteStartTime
      const expectedElapsedMs = (txIdsSentThisMinute / maxPerMin) * 60000

      if (expectedElapsedMs > elapsedMs) {
        const delayMs = Math.ceil(expectedElapsedMs - elapsedMs)
        console.log(`Rate limit: sent ${txIdsSentThisMinute} tx IDs, waiting ${Math.round(delayMs / 1000)}s (max ${maxPerMin}/min)...`)
        await sleep(delayMs)
      }

      // Reset counter if a minute has passed
      if (Date.now() - minuteStartTime >= 60000) {
        txIdsSentThisMinute = 0
        minuteStartTime = Date.now()
      }
    }
  }

  console.log('\nCycle complete:')
  console.log(`  Total rows processed: ${totalRows}`)
  console.log(`  Total unique input IDs: ${totalUniqueIds}`)
  console.log(`  Total crank requests: ${totalCrankRequests}`)

  const reachedMaxIds = maxIds !== null && totalRows >= maxIds

  return {
    totalRows,
    totalUniqueIds,
    totalCrankRequests,
    reachedMaxIds
  }
}

async function main () {
  const options = parseArgs()

  console.log('Crank Requester')
  console.log(`Process ID: ${options.processId}`)
  console.log(`Service URL: ${options.serviceUrl}`)
  console.log(`Crank URL: ${options.crankUrl}`)
  console.log(`Batch size: ${options.batchSize}`)
  console.log(`Max requests/min: ${options.maxPerMin}`)
  if (options.startTime) {
    console.log(`Start time: ${new Date(options.startTime).toISOString()}`)
  } else {
    console.log(`Lookback: ${options.lookbackMinutes} minutes`)
  }
  if (options.maxIds) {
    console.log(`Max IDs: ${options.maxIds}`)
  }
  if (options.skipFile) {
    console.log(`Skip file: ${options.skipFile}`)
  }
  if (options.once) {
    console.log('Mode: single cycle')
  }
  if (options.dryRun) {
    console.log('Mode: DRY RUN')
  }

  // Load skip list if provided
  const skipNonces = options.skipFile ? loadSkipList(options.skipFile) : new Set()

  if (options.once) {
    await runCycle(options, skipNonces)
    return
  }

  // Continuous mode
  let running = true

  process.on('SIGINT', () => {
    console.log('\nShutting down...')
    running = false
    requestShutdown()
  })

  // eslint-disable-next-line no-unmodified-loop-condition
  while (running) {
    try {
      const result = await runCycle(options, skipNonces)

      // Exit if max-ids limit was reached
      if (result.reachedMaxIds) {
        console.log('Max IDs limit reached, exiting.')
        return
      }

      // After each cycle, update start time for next cycle if using lookback
      // (the lookback is recalculated from 'now' each cycle)
      console.log('\nWaiting 60 seconds before next cycle...')
      await sleep(60000)
    } catch (err) {
      console.error(`Cycle error: ${err.message}`)
      console.log('Waiting 60 seconds before retry...')
      await sleep(60000)
    }
  }
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
