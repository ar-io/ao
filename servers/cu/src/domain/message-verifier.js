import Database from 'better-sqlite3'
import { createVerificationDb } from './message-verifier-db.js'
import { createProcessMessagesDb } from './process-messages-db.js'

/**
 * Sleep for a given number of milliseconds
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * MessageVerifier handles verification of output messages by checking
 * if they have been published to Arweave.
 */
export class MessageVerifier {
  constructor ({
    processId,
    discoveryDbDir = './data/process-messages',
    verificationDbDir = './data/verification',
    cacheDbPath = null, // Optional path to ao-cache.sqlite to use as source
    graphqlUrl = 'https://arweave-search.goldsky.com/graphql',
    retryAfterMinutes = 10,
    batchSize = 100,
    // Known MU owner addresses that publish messages
    muOwners = [
      'fcoN_xJeisVsPXA-trzVAuIiqO3ydLQxM-L4XbrQKzY',
      '-HFe6PleLxj1EdFMYMSetT2NIJioDsZIktn-Y0AwP54',
      'WjnS-s03HWsDSdMnyTdzB1eHZB2QheUWP_FVRVYxkXk'
    ],
    // Retry configuration for GraphQL requests
    maxRetries = 5,
    initialRetryDelayMs = 1000,
    maxRetryDelayMs = 5 * 60 * 1000, // 5 minutes
    logger = console
  } = {}) {
    this.processId = processId
    this.discoveryDbDir = discoveryDbDir
    this.verificationDbDir = verificationDbDir
    this.cacheDbPath = cacheDbPath
    this.graphqlUrl = graphqlUrl
    this.retryAfterMs = retryAfterMinutes * 60 * 1000
    this.batchSize = batchSize
    this.muOwners = muOwners
    this.maxRetries = maxRetries
    this.initialRetryDelayMs = initialRetryDelayMs
    this.maxRetryDelayMs = maxRetryDelayMs
    this.logger = logger

    this.verificationDb = null
    this.discoveryDb = null
    this.cacheDb = null
  }

  /**
   * Initialize database connections
   */
  init () {
    this.verificationDb = createVerificationDb({
      processId: this.processId,
      baseDir: this.verificationDbDir
    })

    if (this.cacheDbPath) {
      // Use ao-cache.sqlite as source
      this.cacheDb = new Database(this.cacheDbPath, { readonly: true })
      this.logger.info(`MessageVerifier initialized for process ${this.processId} using cache DB: ${this.cacheDbPath}`)
    } else {
      // Use process-messages discovery DB as source
      this.discoveryDb = createProcessMessagesDb({
        processId: this.processId,
        baseDir: this.discoveryDbDir
      })
      this.logger.info(`MessageVerifier initialized for process ${this.processId} using discovery DB`)
    }
  }

  /**
   * Sync new messages from source DB to verification DB
   * Routes to appropriate sync method based on configuration
   */
  async syncFromDiscoveryDb () {
    if (this.cacheDb) {
      return this.syncFromCacheDb()
    }
    return this.syncFromProcessMessagesDb()
  }

  /**
   * Sync from process-messages discovery DB
   * Uses nonce as cursor for incremental sync
   */
  syncFromProcessMessagesDb () {
    const lastNonce = this.verificationDb.getLastSyncedNonce(this.processId)

    // Query discovery DB for rows with nonce > lastNonce
    const newRows = this.discoveryDb.query(
      'SELECT * FROM process_messages WHERE nonce > ? ORDER BY nonce ASC, output_message_index ASC',
      [lastNonce]
    )

    if (newRows.length === 0) {
      this.logger.debug('No new messages to sync from discovery DB')
      return 0
    }

    // Insert into verification DB
    this.verificationDb.insertMessages(newRows)

    // Update cursor to highest nonce
    const maxNonce = Math.max(...newRows.map(r => r.nonce))
    this.verificationDb.updateCursor(this.processId, maxNonce)

    this.logger.info(`Synced ${newRows.length} messages from discovery DB (nonce ${lastNonce} -> ${maxNonce})`)
    return newRows.length
  }

  /**
   * Sync from ao-cache.sqlite evaluations table
   * Extracts output messages from JSONB output field
   */
  syncFromCacheDb () {
    const lastNonce = this.verificationDb.getLastSyncedNonce(this.processId)

    // Query evaluations table for rows with Messages in output, for this process
    const stmt = this.cacheDb.prepare(`
      SELECT
        messageId,
        nonce,
        timestamp,
        json_extract(output, '$.Messages') as messages
      FROM evaluations
      WHERE processId = ?
        AND nonce > ?
        AND json_array_length(json_extract(output, '$.Messages')) > 0
      ORDER BY nonce ASC
    `)

    const rows = stmt.all(this.processId, lastNonce)

    if (rows.length === 0) {
      this.logger.debug('No new messages to sync from cache DB')
      return 0
    }

    // Transform cache rows into verification rows
    const verificationRows = []
    for (const row of rows) {
      const messages = JSON.parse(row.messages)
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i]
        // Extract Reference and Action from Tags array
        const tags = msg.Tags || []
        const referenceTag = tags.find(t => t.name === 'Reference')
        const actionTag = tags.find(t => t.name === 'Action')

        if (!referenceTag) {
          // Skip messages without Reference tag
          continue
        }

        verificationRows.push({
          nonce: row.nonce,
          input_message_id: row.messageId,
          output_message_reference: referenceTag.value,
          output_message_target: msg.Target,
          output_message_action: actionTag ? actionTag.value : null,
          output_message_index: i,
          created_at: row.timestamp
        })
      }
    }

    if (verificationRows.length === 0) {
      this.logger.debug('No messages with Reference tags found in cache DB')
      return 0
    }

    // Insert into verification DB
    this.verificationDb.insertMessages(verificationRows)

    // Update cursor to highest nonce
    const maxNonce = Math.max(...rows.map(r => r.nonce))
    this.verificationDb.updateCursor(this.processId, maxNonce)

    this.logger.info(`Synced ${verificationRows.length} messages from cache DB (nonce ${lastNonce} -> ${maxNonce})`)
    return verificationRows.length
  }

  /**
   * Get pending rows that need verification
   */
  getRowsToVerify () {
    return this.verificationDb.getRowsToVerify(this.retryAfterMs, this.batchSize)
  }

  /**
   * Build GraphQL query for finding messages by multiple Reference tags (batched)
   */
  buildBatchQuery (references) {
    return {
      query: `query FindMessages($references: [String!]!, $processId: [String!]!, $owners: [String!]!) {
        transactions(
          tags: [
            { name: "Reference", values: $references }
            { name: "Data-Protocol", values: ["ao"] }
            { name: "From-Process", values: $processId }
          ],
          owners: $owners,
          first: ${Math.min(references.length * 2, 100)},
          sort: HEIGHT_DESC
        ) {
          edges {
            node {
              id
              tags {
                name
                value
              }
              block {
                height
                timestamp
              }
              owner {
                address
              }
            }
          }
        }
      }`,
      variables: {
        references,
        processId: [this.processId],
        owners: this.muOwners
      }
    }
  }

  /**
   * Check if an error is retryable (network issues, rate limiting, server errors)
   */
  isRetryableError (error, response) {
    // Network errors
    if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND') {
      return true
    }

    // HTTP status codes that warrant retry
    if (response) {
      const status = response.status
      // 429 Too Many Requests, 502 Bad Gateway, 503 Service Unavailable, 504 Gateway Timeout
      if (status === 429 || status === 502 || status === 503 || status === 504) {
        return true
      }
    }

    return false
  }

  /**
   * Query Arweave gateway to find messages by multiple References (batched)
   * Returns a Map of reference -> messageId (or undefined if not found)
   * Implements exponential backoff for retries
   */
  async findMessagesOnArweave (rows) {
    // Extract unique references
    const references = [...new Set(rows.map(r => r.output_message_reference))]
    const query = this.buildBatchQuery(references)

    let lastError = null
    let delay = this.initialRetryDelayMs

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let response = null

      try {
        response = await fetch(this.graphqlUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(query)
        })

        if (!response.ok) {
          const error = new Error(`GraphQL request failed: ${response.status} ${response.statusText}`)

          if (this.isRetryableError(error, response)) {
            lastError = error
            if (attempt < this.maxRetries) {
              this.logger.warn(
                `GraphQL batch request failed (attempt ${attempt + 1}/${this.maxRetries + 1}): ${response.status}. Retrying in ${delay}ms...`
              )
              await sleep(delay)
              delay = Math.min(delay * 2, this.maxRetryDelayMs)
              continue
            }
          }

          throw error
        }

        const result = await response.json()

        if (result.errors) {
          throw new Error(`GraphQL errors: ${JSON.stringify(result.errors)}`)
        }

        const edges = result.data?.transactions?.edges || []

        // Build a map of reference -> messageId
        const foundMessages = new Map()

        for (const edge of edges) {
          const node = edge.node
          const tags = node.tags || []

          const refTag = tags.find(t => t.name === 'Reference')
          if (!refTag) continue

          const reference = refTag.value

          // Only set if we haven't found this reference yet (first match wins)
          if (!foundMessages.has(reference)) {
            foundMessages.set(reference, node.id)
          }
        }

        return foundMessages
      } catch (error) {
        lastError = error

        if (this.isRetryableError(error, response) && attempt < this.maxRetries) {
          this.logger.warn(
            `GraphQL batch request error (attempt ${attempt + 1}/${this.maxRetries + 1}): ${error.message}. Retrying in ${delay}ms...`
          )
          await sleep(delay)
          delay = Math.min(delay * 2, this.maxRetryDelayMs)
          continue
        }

        // Non-retryable error or max retries exceeded
        break
      }
    }

    // If we get here, we've exhausted retries
    this.logger.error(`GraphQL batch request failed after ${this.maxRetries + 1} attempts: ${lastError.message}`)
    this.logger.error('Max retries exceeded. Terminating process.')
    process.exit(1)
  }

  /**
   * Run verification cycle with batched queries
   * Returns stats about what was processed
   */
  async runVerificationCycle () {
    // First sync any new messages from discovery
    const synced = await this.syncFromDiscoveryDb()

    // Get rows to verify
    const rows = this.getRowsToVerify()

    if (rows.length === 0) {
      return {
        synced,
        verified: 0,
        found: 0,
        notFound: 0
      }
    }

    // Query for all references in one batch
    const foundMessages = await this.findMessagesOnArweave(rows)

    let found = 0
    let notFound = 0

    // Process results and update database
    for (const row of rows) {
      const messageId = foundMessages.get(row.output_message_reference)

      if (messageId) {
        this.verificationDb.updateDiscovered(
          row.nonce,
          row.output_message_index,
          messageId
        )
        found++
      } else {
        this.verificationDb.updateAttemptOnly(row.nonce, row.output_message_index)
        notFound++
      }
    }

    this.logger.info(
      `Batch verified ${rows.length} messages: ${found} found, ${notFound} not found`
    )

    return {
      synced,
      verified: rows.length,
      found,
      notFound
    }
  }

  /**
   * Get current verification statistics
   */
  getStats () {
    return this.verificationDb.getStats()
  }

  /**
   * Close database connections
   */
  close () {
    if (this.verificationDb) {
      this.verificationDb.close()
    }
    if (this.discoveryDb) {
      this.discoveryDb.close()
    }
    if (this.cacheDb) {
      this.cacheDb.close()
    }
  }
}

/**
 * Run the verifier as a continuous process
 */
export async function runVerifier ({
  processId,
  intervalMs = 60000, // 1 minute between cycles
  ...options
}) {
  const verifier = new MessageVerifier({ processId, ...options })
  verifier.init()

  console.log(`Starting verifier for process ${processId}`)
  console.log(`Retry after: ${options.retryAfterMinutes || 10} minutes`)
  console.log(`Batch size: ${options.batchSize || 100}`)
  console.log(`Cycle interval: ${intervalMs}ms`)

  let running = true

  // Handle shutdown
  process.on('SIGINT', () => {
    console.log('Shutting down verifier...')
    running = false
    verifier.close()
    process.exit(0)
  })

  // Run continuously
  // eslint-disable-next-line no-unmodified-loop-condition
  while (running) {
    const cycleStartTime = Date.now()

    try {
      // Sync new messages from discovery DB
      const synced = await verifier.syncFromDiscoveryDb()

      // Process all available work in batches
      let totalVerified = 0
      let totalFound = 0
      let totalNotFound = 0
      let batchCount = 0

      // eslint-disable-next-line no-unmodified-loop-condition
      while (running) {
        const rows = verifier.getRowsToVerify()
        if (rows.length === 0) break

        const foundMessages = await verifier.findMessagesOnArweave(rows)

        let found = 0
        let notFound = 0

        for (const row of rows) {
          const messageId = foundMessages.get(row.output_message_reference)
          if (messageId) {
            verifier.verificationDb.updateDiscovered(row.nonce, row.output_message_index, messageId)
            found++
          } else {
            verifier.verificationDb.updateAttemptOnly(row.nonce, row.output_message_index)
            notFound++
          }
        }

        totalVerified += rows.length
        totalFound += found
        totalNotFound += notFound
        batchCount++

        console.log(`Batch ${batchCount}: verified=${rows.length}, found=${found}, notFound=${notFound}`)
      }

      const dbStats = verifier.getStats()
      console.log(`Cycle complete: synced=${synced}, totalVerified=${totalVerified}, found=${totalFound}, notFound=${totalNotFound}`)
      console.log(`DB stats: total=${dbStats.total}, discovered=${dbStats.discovered}, pending=${dbStats.pending}, needsRetry=${dbStats.needsRetry}, maxNonce=${dbStats.maxNonce}`)

      // Show when next retries will be eligible
      if (dbStats.needsRetry > 0 && dbStats.earliestRetryAttempt) {
        const nextEligibleTime = dbStats.earliestRetryAttempt + verifier.retryAfterMs
        const nextEligibleDate = new Date(nextEligibleTime)
        console.log(`Next retry eligible: ${nextEligibleDate.toLocaleString()}`)
      }

      // Calculate remaining time in interval
      const elapsedMs = Date.now() - cycleStartTime
      const remainingMs = intervalMs - elapsedMs

      if (remainingMs > 0) {
        console.log(`Waiting ${Math.round(remainingMs / 1000)}s until next cycle...`)
        await sleep(remainingMs)
      } else {
        console.log(`Cycle took ${Math.round(elapsedMs / 1000)}s (longer than interval), continuing immediately...`)
      }
    } catch (error) {
      console.error('Verification cycle error:', error)
      // Wait before retrying on error
      await sleep(intervalMs)
    }
  }

  return verifier
}
