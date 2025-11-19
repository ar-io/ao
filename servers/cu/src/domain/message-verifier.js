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
  }

  /**
   * Initialize database connections
   */
  init () {
    this.verificationDb = createVerificationDb({
      processId: this.processId,
      baseDir: this.verificationDbDir
    })

    this.discoveryDb = createProcessMessagesDb({
      processId: this.processId,
      baseDir: this.discoveryDbDir
    })

    this.logger.info(`MessageVerifier initialized for process ${this.processId}`)
  }

  /**
   * Sync new messages from discovery DB to verification DB
   * Uses nonce as cursor for incremental sync
   */
  async syncFromDiscoveryDb () {
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
  console.log(`Cycle interval: ${intervalMs}ms (skipped when work pending)`)

  let running = true

  const runCycle = async () => {
    try {
      const stats = await verifier.runVerificationCycle()
      const dbStats = verifier.getStats()

      console.log(`Cycle complete: synced=${stats.synced}, verified=${stats.verified}, found=${stats.found}, notFound=${stats.notFound}`)
      console.log(`DB stats: total=${dbStats.total}, discovered=${dbStats.discovered}, pending=${dbStats.pending}, needsRetry=${dbStats.needsRetry}, maxNonce=${dbStats.maxNonce}`)

      // Continue immediately only if there are still pending (never-checked) messages
      return stats.verified > 0 && dbStats.pending > 0
    } catch (error) {
      console.error('Verification cycle error:', error)
      return false
    }
  }

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
    const hadWork = await runCycle()

    if (hadWork) {
      // More work to do, continue immediately
      continue
    } else {
      // No work available, wait for interval
      await new Promise(resolve => setTimeout(resolve, intervalMs))
    }
  }

  return verifier
}
