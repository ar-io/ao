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
    retryLookbackSeconds = null, // Optional: only look at messages from the last N seconds
    batchSize = 100,
    syncBatchSize = 10000, // Batch size for syncing from source DB
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
    this.retryLookbackMs = retryLookbackSeconds ? retryLookbackSeconds * 1000 : null
    this.batchSize = batchSize
    this.syncBatchSize = syncBatchSize
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
   * Uses batched fetching to avoid OOM on large datasets
   */
  syncFromProcessMessagesDb () {
    let currentNonce = this.verificationDb.getLastSyncedNonce(this.processId)
    let totalSynced = 0
    let batchNum = 0

    while (true) {
      batchNum++
      this.logger.info(`Sync batch ${batchNum}: querying discovery DB for rows with nonce > ${currentNonce} (limit ${this.syncBatchSize})...`)
      const queryStart = Date.now()

      const rows = this.discoveryDb.query(
        'SELECT * FROM process_messages WHERE nonce > ? ORDER BY nonce ASC, output_message_index ASC LIMIT ?',
        [currentNonce, this.syncBatchSize]
      )
      const queryMs = Date.now() - queryStart
      this.logger.info(`Sync batch ${batchNum}: discovery DB query returned ${rows.length} rows in ${queryMs}ms`)

      if (rows.length === 0) {
        break
      }

      // Insert into verification DB
      this.verificationDb.insertMessages(rows)
      totalSynced += rows.length

      // Update cursor to highest nonce in this batch
      const maxNonce = rows[rows.length - 1].nonce
      this.verificationDb.updateCursor(this.processId, maxNonce)
      currentNonce = maxNonce

      this.logger.info(`Sync batch ${batchNum}: synced ${rows.length} messages (cursor now at nonce ${maxNonce})`)

      // If we got fewer rows than the batch size, we've reached the end
      if (rows.length < this.syncBatchSize) {
        break
      }
    }

    if (totalSynced > 0) {
      this.logger.info(`Sync complete: ${totalSynced} total messages synced from discovery DB`)
    } else {
      this.logger.debug('No new messages to sync from discovery DB')
    }

    return totalSynced
  }

  /**
   * Sync from ao-cache.sqlite evaluations table
   * Extracts output messages from JSONB output field
   * Uses batched fetching to avoid OOM on large datasets
   */
  syncFromCacheDb () {
    let currentNonce = this.verificationDb.getLastSyncedNonce(this.processId)
    let totalSynced = 0
    let batchNum = 0

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
      LIMIT ?
    `)

    while (true) {
      batchNum++
      this.logger.info(`Sync batch ${batchNum}: querying cache DB for rows with nonce > ${currentNonce} (limit ${this.syncBatchSize})...`)
      const queryStart = Date.now()

      const rows = stmt.all(this.processId, currentNonce, this.syncBatchSize)
      const queryMs = Date.now() - queryStart
      this.logger.info(`Sync batch ${batchNum}: cache DB query returned ${rows.length} rows in ${queryMs}ms`)

      if (rows.length === 0) {
        break
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
            input_message_timestamp: row.timestamp,
            output_message_reference: referenceTag.value,
            output_message_target: msg.Target,
            output_message_action: actionTag ? actionTag.value : null,
            output_message_tags: JSON.stringify(tags),
            output_message_index: i,
            created_at: row.timestamp
          })
        }
      }

      if (verificationRows.length > 0) {
        // Insert into verification DB
        this.verificationDb.insertMessages(verificationRows)
        totalSynced += verificationRows.length
      }

      // Update cursor to highest nonce in this batch
      const maxNonce = rows[rows.length - 1].nonce
      this.verificationDb.updateCursor(this.processId, maxNonce)
      currentNonce = maxNonce

      this.logger.info(`Sync batch ${batchNum}: synced ${verificationRows.length} messages (cursor now at nonce ${maxNonce})`)

      // If we got fewer rows than the batch size, we've reached the end
      if (rows.length < this.syncBatchSize) {
        break
      }
    }

    if (totalSynced > 0) {
      this.logger.info(`Sync complete: ${totalSynced} total messages synced from cache DB`)
    } else {
      this.logger.debug('No new messages to sync from cache DB')
    }

    return totalSynced
  }

  /**
   * Get nonce range from source DB (cache or discovery)
   */
  getSourceNonceRange () {
    if (this.cacheDb) {
      // Use separate MIN/MAX queries to leverage index, avoid COUNT(*)
      this.logger.info('Source range: querying cache DB MIN(nonce)...')
      let start = Date.now()
      const minResult = this.cacheDb.prepare(`
        SELECT MIN(nonce) as minNonce
        FROM evaluations
        WHERE processId = ?
          AND json_array_length(json_extract(output, '$.Messages')) > 0
      `).get(this.processId)
      this.logger.info(`Source range: cache DB MIN query took ${Date.now() - start}ms`)

      // If no min, there are no rows
      if (minResult.minNonce === null) {
        return { minNonce: null, maxNonce: null, count: 0 }
      }

      this.logger.info('Source range: querying cache DB MAX(nonce)...')
      start = Date.now()
      const maxResult = this.cacheDb.prepare(`
        SELECT MAX(nonce) as maxNonce
        FROM evaluations
        WHERE processId = ?
          AND json_array_length(json_extract(output, '$.Messages')) > 0
      `).get(this.processId)
      this.logger.info(`Source range: cache DB MAX query took ${Date.now() - start}ms`)

      return {
        minNonce: minResult.minNonce,
        maxNonce: maxResult.maxNonce,
        count: -1 // Unknown, but not zero
      }
    } else {
      // Use separate queries for discovery DB too
      this.logger.info('Source range: querying discovery DB MIN(nonce)...')
      let start = Date.now()
      const minResult = this.discoveryDb.query(
        'SELECT MIN(nonce) as minNonce FROM process_messages'
      )[0]
      this.logger.info(`Source range: discovery DB MIN query took ${Date.now() - start}ms`)

      if (minResult.minNonce === null) {
        return { minNonce: null, maxNonce: null, count: 0 }
      }

      this.logger.info('Source range: querying discovery DB MAX(nonce)...')
      start = Date.now()
      const maxResult = this.discoveryDb.query(
        'SELECT MAX(nonce) as maxNonce FROM process_messages'
      )[0]
      this.logger.info(`Source range: discovery DB MAX query took ${Date.now() - start}ms`)

      return {
        minNonce: minResult.minNonce,
        maxNonce: maxResult.maxNonce,
        count: -1 // Unknown, but not zero
      }
    }
  }

  /**
   * Check for nonce gaps between source and verification DBs
   * Returns gap info and whether it's safe to proceed
   */
  checkNonceGap () {
    this.logger.info('Gap check: querying source DB nonce range...')
    let start = Date.now()
    const sourceRange = this.getSourceNonceRange()
    this.logger.info(`Gap check: source DB query took ${Date.now() - start}ms`)

    this.logger.info('Gap check: getting last synced nonce...')
    start = Date.now()
    const lastSyncedNonce = this.verificationDb.getLastSyncedNonce(this.processId)
    this.logger.info(`Gap check: last synced nonce query took ${Date.now() - start}ms`)

    // Get min/max nonce from verification DB (separate queries to use index efficiently)
    this.logger.info('Gap check: querying verification DB MIN(nonce)...')
    start = Date.now()
    const verificationMin = this.verificationDb.query(
      'SELECT MIN(nonce) as minNonce FROM verification_messages'
    )[0] || { minNonce: null }
    this.logger.info(`Gap check: verification MIN query took ${Date.now() - start}ms`)

    this.logger.info('Gap check: querying verification DB MAX(nonce)...')
    start = Date.now()
    const verificationMax = this.verificationDb.query(
      'SELECT MAX(nonce) as maxNonce FROM verification_messages'
    )[0] || { maxNonce: null }
    this.logger.info(`Gap check: verification MAX query took ${Date.now() - start}ms`)

    const verificationHasRows = verificationMax.maxNonce !== null
    const nextNonceNeeded = lastSyncedNonce + 1

    const result = {
      source: {
        minNonce: sourceRange.minNonce,
        maxNonce: sourceRange.maxNonce,
        count: sourceRange.count
      },
      verification: {
        minNonce: verificationMin.minNonce,
        maxNonce: verificationMax.maxNonce,
        nextNonceNeeded
      },
      hasGap: false,
      gapReason: null
    }

    // Check for gaps
    if (sourceRange.minNonce === null) {
      result.hasGap = true
      result.gapReason = 'Source DB has no messages with output'
    } else if (!verificationHasRows) {
      // First sync - no gap issue, source just needs to start from beginning
      if (sourceRange.minNonce > 0) {
        // This might be okay if process started at nonce > 0, but warn anyway
        result.hasGap = false
      }
    } else if (nextNonceNeeded < sourceRange.minNonce) {
      // Verification DB needs nonces that source DB doesn't have (source starts too late)
      result.hasGap = true
      result.gapReason = `Verification needs nonce ${nextNonceNeeded} but source DB starts at nonce ${sourceRange.minNonce}`
    } else if (verificationMin.minNonce !== null && verificationMin.minNonce > sourceRange.maxNonce) {
      // Verification DB is ahead of source (shouldn't happen normally)
      result.hasGap = true
      result.gapReason = `Verification DB min nonce (${verificationMin.minNonce}) is higher than source DB max nonce (${sourceRange.maxNonce})`
    }

    return result
  }

  /**
   * Get rows that would be synced from source DB (without writing)
   */
  getRowsToSync () {
    const lastNonce = this.verificationDb.getLastSyncedNonce(this.processId)

    if (this.cacheDb) {
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
      const verificationRows = []

      for (const row of rows) {
        const messages = JSON.parse(row.messages)
        for (let i = 0; i < messages.length; i++) {
          const msg = messages[i]
          const tags = msg.Tags || []
          const referenceTag = tags.find(t => t.name === 'Reference')
          const actionTag = tags.find(t => t.name === 'Action')

          if (!referenceTag) continue

          verificationRows.push({
            nonce: row.nonce,
            input_message_id: row.messageId,
            input_message_timestamp: row.timestamp,
            output_message_reference: referenceTag.value,
            output_message_target: msg.Target,
            output_message_action: actionTag ? actionTag.value : null,
            output_message_tags: JSON.stringify(tags),
            output_message_index: i,
            created_at: row.timestamp
          })
        }
      }

      return verificationRows
    } else {
      return this.discoveryDb.query(
        'SELECT * FROM process_messages WHERE nonce > ? ORDER BY nonce ASC, output_message_index ASC',
        [lastNonce]
      )
    }
  }

  /**
   * Run verification without writing to DB (dry run mode)
   */
  async runDryRunVerification () {
    const rowsToSync = this.getRowsToSync()

    let verified = 0
    let found = 0
    let corrupted = 0
    let notFound = 0

    // Process in batches
    for (let i = 0; i < rowsToSync.length; i += this.batchSize) {
      const batch = rowsToSync.slice(i, i + this.batchSize)
      const { validMatches, invalidMatches } = await this.findMessagesOnArweave(batch)

      let batchFound = 0
      let batchCorrupted = 0
      let batchNotFound = 0

      for (const row of batch) {
        const rowKey = `${row.nonce}:${row.output_message_index}`
        const validMessageId = validMatches.get(rowKey)
        const invalidMatch = invalidMatches.get(rowKey)

        if (validMessageId) {
          found++
          batchFound++
        } else if (invalidMatch) {
          corrupted++
          batchCorrupted++
        } else {
          notFound++
          batchNotFound++
        }
        verified++
      }

      this.logger.info(`Dry run batch ${Math.floor(i / this.batchSize) + 1}: verified=${batch.length}, found=${batchFound}, corrupted=${batchCorrupted}, notFound=${batchNotFound}`)
    }

    return {
      wouldSync: rowsToSync.length,
      verified,
      found,
      corrupted,
      notFound
    }
  }

  /**
   * Get pending rows that need verification
   */
  getRowsToVerify () {
    this.logger.info('Querying verification DB for rows to verify...')
    const queryStart = Date.now()
    // Calculate minTimestamp if lookback is configured
    const minTimestamp = this.retryLookbackMs ? Date.now() - this.retryLookbackMs : null
    const rows = this.verificationDb.getRowsToVerify(this.retryAfterMs, this.batchSize, minTimestamp)
    const queryMs = Date.now() - queryStart
    if (minTimestamp) {
      this.logger.info(`Verification DB query returned ${rows.length} rows in ${queryMs}ms (lookback: messages since ${new Date(minTimestamp).toISOString()})`)
    } else {
      this.logger.info(`Verification DB query returned ${rows.length} rows in ${queryMs}ms`)
    }
    return rows
  }

  /**
   * Build GraphQL query for finding messages by multiple Reference tags
   */
  buildReferenceQuery (references) {
    return {
      query: `query FindMessagesByReference($references: [String!]!, $processId: [String!]!, $owners: [String!]!) {
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
   * Check if all expected tags are present and match in the actual tags
   * Extra tags in actual are OK, but missing or mismatched tags are not
   *
   * @param {Array} expectedTags - Array of {name, value} objects we expect
   * @param {Array} actualTags - Array of {name, value} objects from GraphQL result
   * @returns {{ valid: boolean, mismatches: Array }} - Whether valid, and list of mismatched tags
   */
  validateTags (expectedTags, actualTags) {
    const mismatches = []

    // Build a map of actual tags for fast lookup
    // Note: Some tags may appear multiple times, so we store arrays
    const actualTagMap = new Map()
    for (const tag of actualTags) {
      if (!actualTagMap.has(tag.name)) {
        actualTagMap.set(tag.name, [])
      }
      actualTagMap.get(tag.name).push(tag.value)
    }

    // Check each expected tag
    for (const expected of expectedTags) {
      const actualValues = actualTagMap.get(expected.name)

      if (!actualValues) {
        // Tag is missing entirely
        mismatches.push({
          tag: expected.name,
          expected: expected.value,
          actual: null,
          reason: 'missing'
        })
      } else if (!actualValues.includes(expected.value)) {
        // Tag exists but value doesn't match any of the actual values
        mismatches.push({
          tag: expected.name,
          expected: expected.value,
          actual: actualValues.length === 1 ? actualValues[0] : actualValues,
          reason: 'mismatch'
        })
      }
    }

    return {
      valid: mismatches.length === 0,
      mismatches
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
   * Execute a GraphQL query with retries
   * Returns the edges array from the response
   */
  async executeGraphQLQuery (query, queryName) {
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
                `GraphQL ${queryName} request failed (attempt ${attempt + 1}/${this.maxRetries + 1}): ${response.status}. Retrying in ${delay}ms...`
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

        return result.data?.transactions?.edges || []
      } catch (error) {
        lastError = error

        if (this.isRetryableError(error, response) && attempt < this.maxRetries) {
          this.logger.warn(
            `GraphQL ${queryName} request error (attempt ${attempt + 1}/${this.maxRetries + 1}): ${error.message}. Retrying in ${delay}ms...`
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
    this.logger.error(`GraphQL ${queryName} request failed after ${this.maxRetries + 1} attempts: ${lastError.message}`)
    this.logger.error('Max retries exceeded. Terminating process.')
    process.exit(1)
  }

  /**
   * Query Arweave gateway to find messages by Reference tag
   * Then validate that ALL expected tags match (extra tags in result are OK)
   *
   * Returns an object with:
   *   - validMatches: Map of rowKey -> messageId (all tags match)
   *   - invalidMatches: Map of rowKey -> { messageId, mismatches } (Reference matched but other tags didn't)
   */
  async findMessagesOnArweave (rows) {
    // Extract unique Reference IDs for the query
    const references = [...new Set(rows.map(r => r.output_message_reference))]

    // Query by Reference
    this.logger.info(`Querying by Reference (${references.length} refs)...`)
    const referenceQuery = this.buildReferenceQuery(references)
    const edges = await this.executeGraphQLQuery(referenceQuery, 'Reference')

    // Group results by Reference tag value
    // Multiple messages may share the same Reference (shouldn't happen, but handle it)
    // Sort by block height ascending so we prefer the earliest one
    const byReference = new Map()

    for (const edge of edges) {
      const node = edge.node
      const tags = node.tags || []

      const refTag = tags.find(t => t.name === 'Reference')
      if (!refTag) continue

      const reference = refTag.value
      const blockHeight = node.block?.height ?? Infinity

      if (!byReference.has(reference)) {
        byReference.set(reference, [])
      }
      byReference.get(reference).push({
        messageId: node.id,
        tags,
        blockHeight
      })
    }

    // Sort each reference's candidates by block height (earliest first)
    for (const candidates of byReference.values()) {
      candidates.sort((a, b) => a.blockHeight - b.blockHeight)
    }

    // Match found messages against our expected rows by validating ALL tags
    const validMatches = new Map()
    const invalidMatches = new Map()

    for (const row of rows) {
      const rowKey = `${row.nonce}:${row.output_message_index}`
      const reference = row.output_message_reference

      // Parse expected tags from the stored JSON
      let expectedTags = []
      if (row.output_message_tags) {
        try {
          expectedTags = JSON.parse(row.output_message_tags)
        } catch (e) {
          this.logger.warn(`Failed to parse tags for row ${rowKey}: ${e.message}`)
        }
      }

      const candidates = byReference.get(reference) || []

      if (candidates.length === 0) {
        // Not found at all
        continue
      }

      // Find a candidate where ALL expected tags match
      let foundValid = false
      let bestInvalidMatch = null

      for (const candidate of candidates) {
        const validation = this.validateTags(expectedTags, candidate.tags)

        if (validation.valid) {
          // All tags match - this is a valid match
          validMatches.set(rowKey, candidate.messageId)
          foundValid = true
          break
        } else if (!bestInvalidMatch) {
          // Keep track of first invalid match for reporting
          bestInvalidMatch = {
            messageId: candidate.messageId,
            mismatches: validation.mismatches
          }
        }
      }

      if (!foundValid && bestInvalidMatch) {
        // Found message(s) with matching Reference, but other tags didn't match
        invalidMatches.set(rowKey, bestInvalidMatch)
      }
    }

    this.logger.info(`Found ${validMatches.size} valid matches, ${invalidMatches.size} invalid (tag mismatch) matches`)

    return { validMatches, invalidMatches }
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
        corrupted: 0,
        notFound: 0
      }
    }

    // Query for all input message IDs in one batch
    const { validMatches, invalidMatches } = await this.findMessagesOnArweave(rows)

    let found = 0
    let corrupted = 0
    let notFound = 0

    // Process results and update database
    for (const row of rows) {
      const rowKey = `${row.nonce}:${row.output_message_index}`
      const validMessageId = validMatches.get(rowKey)
      const invalidMatch = invalidMatches.get(rowKey)

      if (validMessageId) {
        // Valid match - all tags match
        this.verificationDb.updateDiscovered(
          row.nonce,
          row.output_message_index,
          validMessageId
        )
        found++
      } else if (invalidMatch) {
        // Invalid match - Reference matched but other tags didn't
        this.verificationDb.updateDiscoveredInvalid(
          row.nonce,
          row.output_message_index,
          invalidMatch.messageId
        )
        corrupted++
        const mismatchSummary = invalidMatch.mismatches
          .map(m => `${m.tag}: expected=${m.expected}, actual=${m.actual}`)
          .join('; ')
        this.logger.warn(
          `Tag mismatch detected: nonce=${row.nonce}, reference=${row.output_message_reference}, ` +
          `mismatches=[${mismatchSummary}]`
        )
      } else {
        // Not found at all
        this.verificationDb.updateAttemptOnly(row.nonce, row.output_message_index)
        notFound++
      }
    }

    this.logger.info(
      `Batch verified ${rows.length} messages: ${found} found, ${corrupted} corrupted, ${notFound} not found`
    )

    return {
      synced,
      verified: rows.length,
      found,
      corrupted,
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
  if (options.retryLookbackSeconds) {
    console.log(`Retry lookback: ${options.retryLookbackSeconds} seconds (only messages from the last ${options.retryLookbackSeconds}s will be retried)`)
  }
  console.log(`Batch size: ${options.batchSize || 100}`)
  console.log(`Cycle interval: ${intervalMs}ms`)

  // Check for nonce gaps at startup
  console.log('\nChecking for nonce gaps between source and verification DBs...')
  const gapCheck = verifier.checkNonceGap()

  console.log(`Source DB: minNonce=${gapCheck.source.minNonce ?? 'N/A'}, maxNonce=${gapCheck.source.maxNonce ?? 'N/A'}`)
  console.log(`Verification DB: minNonce=${gapCheck.verification.minNonce ?? 'N/A'}, maxNonce=${gapCheck.verification.maxNonce ?? 'N/A'}, nextNonceNeeded=${gapCheck.verification.nextNonceNeeded}`)

  if (gapCheck.hasGap) {
    console.error('\n⚠️  ERROR: Nonce gap detected!')
    console.error(`  ${gapCheck.gapReason}`)
    console.error('\nTerminating. Please ensure source DB has continuous nonce coverage.')
    verifier.close()
    process.exit(1)
  }

  console.log('✓ No nonce gaps detected.\n')

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
      let totalCorrupted = 0
      let totalNotFound = 0
      let batchCount = 0

      // eslint-disable-next-line no-unmodified-loop-condition
      while (running) {
        const rows = verifier.getRowsToVerify()
        if (rows.length === 0) break

        const { validMatches, invalidMatches } = await verifier.findMessagesOnArweave(rows)

        let found = 0
        let corrupted = 0
        let notFound = 0

        for (const row of rows) {
          const rowKey = `${row.nonce}:${row.output_message_index}`
          const validMessageId = validMatches.get(rowKey)
          const invalidMatch = invalidMatches.get(rowKey)

          if (validMessageId) {
            verifier.verificationDb.updateDiscovered(row.nonce, row.output_message_index, validMessageId)
            found++
          } else if (invalidMatch) {
            verifier.verificationDb.updateDiscoveredInvalid(row.nonce, row.output_message_index, invalidMatch.messageId)
            corrupted++
            const mismatchSummary = invalidMatch.mismatches
              .map(m => `${m.tag}: expected=${m.expected}, actual=${m.actual}`)
              .join('; ')
            console.warn(
              `Tag mismatch: nonce=${row.nonce}, reference=${row.output_message_reference}, ` +
              `mismatches=[${mismatchSummary}]`
            )
          } else {
            verifier.verificationDb.updateAttemptOnly(row.nonce, row.output_message_index)
            notFound++
          }
        }

        totalVerified += rows.length
        totalFound += found
        totalCorrupted += corrupted
        totalNotFound += notFound
        batchCount++

        console.log(`Batch ${batchCount}: verified=${rows.length}, found=${found}, corrupted=${corrupted}, notFound=${notFound}`)
      }

      const dbStats = verifier.getStats()
      console.log(`Cycle complete: synced=${synced}, totalVerified=${totalVerified}, found=${totalFound}, corrupted=${totalCorrupted}, notFound=${totalNotFound}`)
      console.log(`DB stats: total=${dbStats.total}, discovered=${dbStats.discovered}, corrupted=${dbStats.corrupted}, pending=${dbStats.pending}, needsRetry=${dbStats.needsRetry}, maxNonce=${dbStats.maxNonce}`)

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
