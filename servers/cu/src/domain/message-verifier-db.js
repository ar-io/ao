import { existsSync, mkdirSync, stat } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import bytes from 'bytes'

/**
 * Capture the real Date.now before AoLoader can overwrite it
 */
const realDateNow = Date.now.bind(Date)

const VERIFICATION_TABLE = 'verification_messages'
const CURSOR_TABLE = 'sync_cursors'

/**
 * Create the verification messages table schema
 */
const createVerificationTable = (db) => db.prepare(
  `CREATE TABLE IF NOT EXISTS ${VERIFICATION_TABLE}(
    nonce INTEGER NOT NULL,
    input_message_id TEXT NOT NULL,
    input_message_timestamp INTEGER,
    output_message_reference TEXT NOT NULL,
    output_message_target TEXT NOT NULL,
    output_message_action TEXT,
    output_message_tags TEXT,
    output_message_index INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    discovered_message_id TEXT,
    discovered_invalid_message_id TEXT,
    last_discovery_attempt INTEGER,
    uncrankable_reason TEXT,
    PRIMARY KEY (nonce, output_message_index)
  ) WITHOUT ROWID;`
).run()

/**
 * Migration: Add output_message_tags column if it doesn't exist
 */
const migrateAddTagsColumn = (db) => {
  const columns = db.prepare(`PRAGMA table_info(${VERIFICATION_TABLE})`).all()
  const hasTagsColumn = columns.some(col => col.name === 'output_message_tags')
  if (!hasTagsColumn) {
    db.prepare(`ALTER TABLE ${VERIFICATION_TABLE} ADD COLUMN output_message_tags TEXT`).run()
  }
}

/**
 * Migration: Add uncrankable_reason column if it doesn't exist
 */
const migrateAddUncrankableReasonColumn = (db) => {
  const columns = db.prepare(`PRAGMA table_info(${VERIFICATION_TABLE})`).all()
  const hasColumn = columns.some(col => col.name === 'uncrankable_reason')
  if (!hasColumn) {
    db.prepare(`ALTER TABLE ${VERIFICATION_TABLE} ADD COLUMN uncrankable_reason TEXT`).run()
  }
}

/**
 * Create cursor tracking table for syncing from discovery DB
 */
const createCursorTable = (db) => db.prepare(
  `CREATE TABLE IF NOT EXISTS ${CURSOR_TABLE}(
    process_id TEXT PRIMARY KEY,
    last_synced_nonce INTEGER NOT NULL DEFAULT 0,
    last_sync_time INTEGER NOT NULL
  );`
).run()

/**
 * Create indexes for efficient querying
 */
const createIndexes = (db) => {
  // Index for fast MIN/MAX nonce lookups
  db.prepare(
    `CREATE INDEX IF NOT EXISTS idx_${VERIFICATION_TABLE}_nonce
      ON ${VERIFICATION_TABLE} (nonce);`
  ).run()

  db.prepare(
    `CREATE INDEX IF NOT EXISTS idx_${VERIFICATION_TABLE}_discovered
      ON ${VERIFICATION_TABLE} (discovered_message_id);`
  ).run()

  db.prepare(
    `CREATE INDEX IF NOT EXISTS idx_${VERIFICATION_TABLE}_last_attempt
      ON ${VERIFICATION_TABLE} (last_discovery_attempt);`
  ).run()

  db.prepare(
    `CREATE INDEX IF NOT EXISTS idx_${VERIFICATION_TABLE}_reference
      ON ${VERIFICATION_TABLE} (output_message_reference);`
  ).run()

  // Composite index for getRowsToVerify query
  db.prepare(
    `CREATE INDEX IF NOT EXISTS idx_${VERIFICATION_TABLE}_pending
      ON ${VERIFICATION_TABLE} (discovered_message_id, last_discovery_attempt, nonce, output_message_index);`
  ).run()

  // Partial index for timestamp range queries on undiscovered messages
  db.prepare(
    `CREATE INDEX IF NOT EXISTS idx_${VERIFICATION_TABLE}_pending_timestamp
      ON ${VERIFICATION_TABLE} (input_message_timestamp)
      WHERE discovered_message_id IS NULL;`
  ).run()
}

/**
 * Cache for database connections keyed by processId
 */
const dbCache = new Map()

/**
 * Creates or retrieves a process-specific verification database client
 */
export function createVerificationDb ({
  processId,
  baseDir = './data/verification',
  walLimit = bytes.parse('100mb')
}) {
  if (!processId) {
    throw new Error('processId is required')
  }

  if (dbCache.has(processId)) {
    return dbCache.get(processId)
  }

  if (!existsSync(baseDir)) {
    mkdirSync(baseDir, { recursive: true })
  }

  const dbPath = join(baseDir, `${processId}.sqlite`)
  const db = Database(dbPath)

  db.pragma('encoding = "UTF-8"')
  db.pragma('journal_mode = WAL')

  const walPath = `${dbPath}-wal`
  const checkpointInterval = setInterval(() => {
    stat(walPath, (err, stats) => {
      if (err && err.code !== 'ENOENT') throw err
      if (stats && stats.size > walLimit) {
        db.pragma('wal_checkpoint(RESTART)')
      }
    })
  }, 5000)
  checkpointInterval.unref()

  // Initialize schema
  createVerificationTable(db)
  migrateAddTagsColumn(db)
  migrateAddUncrankableReasonColumn(db)
  createCursorTable(db)
  createIndexes(db)

  /**
   * Prepared statements
   */
  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO ${VERIFICATION_TABLE}
    (nonce, input_message_id, input_message_timestamp, output_message_reference, output_message_target,
     output_message_action, output_message_tags, output_message_index, created_at, uncrankable_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )

  const getCursorStmt = db.prepare(
    `SELECT last_synced_nonce FROM ${CURSOR_TABLE} WHERE process_id = ?`
  )

  const updateCursorStmt = db.prepare(
    `INSERT OR REPLACE INTO ${CURSOR_TABLE} (process_id, last_synced_nonce, last_sync_time)
    VALUES (?, ?, ?)`
  )

  // Include rows with discovered_invalid_message_id for retry - a valid match may be published later
  const getRowsToVerifyStmt = db.prepare(
    `SELECT * FROM ${VERIFICATION_TABLE}
    WHERE discovered_message_id IS NULL
      AND uncrankable_reason IS NULL
      AND (last_discovery_attempt IS NULL OR last_discovery_attempt < ?)
    ORDER BY
      CASE WHEN last_discovery_attempt IS NULL THEN 0 ELSE 1 END,
      nonce ASC,
      output_message_index ASC
    LIMIT ?`
  )

  // Lookback only applies to retries, not fresh messages
  // Include rows with discovered_invalid_message_id for retry
  const getRowsToVerifyWithLookbackStmt = db.prepare(
    `SELECT * FROM ${VERIFICATION_TABLE}
    WHERE discovered_message_id IS NULL
      AND uncrankable_reason IS NULL
      AND (
        last_discovery_attempt IS NULL
        OR (last_discovery_attempt < ? AND input_message_timestamp >= ?)
      )
    ORDER BY
      CASE WHEN last_discovery_attempt IS NULL THEN 0 ELSE 1 END,
      nonce ASC,
      output_message_index ASC
    LIMIT ?`
  )

  const updateDiscoveredStmt = db.prepare(
    `UPDATE ${VERIFICATION_TABLE}
    SET discovered_message_id = ?, last_discovery_attempt = ?
    WHERE nonce = ? AND output_message_index = ?`
  )

  const updateDiscoveredInvalidStmt = db.prepare(
    `UPDATE ${VERIFICATION_TABLE}
    SET discovered_invalid_message_id = ?, last_discovery_attempt = ?
    WHERE nonce = ? AND output_message_index = ?`
  )

  const updateAttemptOnlyStmt = db.prepare(
    `UPDATE ${VERIFICATION_TABLE}
    SET last_discovery_attempt = ?
    WHERE nonce = ? AND output_message_index = ?`
  )

  const updateUncrankableReasonStmt = db.prepare(
    `UPDATE ${VERIFICATION_TABLE}
    SET uncrankable_reason = ?
    WHERE nonce = ? AND output_message_index = ?`
  )

  const client = {
    /**
     * Get the last synced nonce for a process
     */
    getLastSyncedNonce: (processId) => {
      const row = getCursorStmt.get(processId)
      return row ? row.last_synced_nonce : 0
    },

    /**
     * Insert messages from discovery DB (batch)
     */
    insertMessages: (messages) => {
      const transaction = db.transaction((msgs) => {
        for (const msg of msgs) {
          insertStmt.run(
            msg.nonce,
            msg.input_message_id,
            msg.input_message_timestamp || null,
            msg.output_message_reference,
            msg.output_message_target,
            msg.output_message_action || null,
            msg.output_message_tags || null,
            msg.output_message_index,
            msg.created_at,
            msg.uncrankable_reason || null
          )
        }
      })
      return transaction(messages)
    },

    /**
     * Update cursor after syncing
     */
    updateCursor: (processId, nonce) => {
      return updateCursorStmt.run(processId, nonce, realDateNow())
    },

    /**
     * Get rows that need verification
     * @param {number} retryAfterMs - Don't retry rows attempted within this many ms
     * @param {number} limit - Max rows to return
     * @param {number} minTimestamp - Optional minimum input_message_timestamp (for lookback filtering)
     */
    getRowsToVerify: (retryAfterMs, limit = 100, minTimestamp = null) => {
      const cutoffTime = realDateNow() - retryAfterMs
      if (minTimestamp !== null) {
        return getRowsToVerifyWithLookbackStmt.all(cutoffTime, minTimestamp, limit)
      }
      return getRowsToVerifyStmt.all(cutoffTime, limit)
    },

    /**
     * Update a row with discovered message ID (valid match)
     */
    updateDiscovered: (nonce, outputMessageIndex, messageId) => {
      return updateDiscoveredStmt.run(messageId, realDateNow(), nonce, outputMessageIndex)
    },

    /**
     * Update a row with discovered invalid message ID (Reference matched but other tags didn't)
     */
    updateDiscoveredInvalid: (nonce, outputMessageIndex, messageId) => {
      return updateDiscoveredInvalidStmt.run(messageId, realDateNow(), nonce, outputMessageIndex)
    },

    /**
     * Update only the attempt timestamp (message not found)
     */
    updateAttemptOnly: (nonce, outputMessageIndex) => {
      return updateAttemptOnlyStmt.run(realDateNow(), nonce, outputMessageIndex)
    },

    /**
     * Update uncrankable reason for a row
     */
    updateUncrankableReason: (nonce, outputMessageIndex, reason) => {
      return updateUncrankableReasonStmt.run(reason, nonce, outputMessageIndex)
    },

    /**
     * Get verification statistics
     */
    getStats: () => {
      const total = db.prepare(`SELECT COUNT(*) as count FROM ${VERIFICATION_TABLE}`).get()
      const discovered = db.prepare(
        `SELECT COUNT(*) as count FROM ${VERIFICATION_TABLE} WHERE discovered_message_id IS NOT NULL`
      ).get()
      // Corrupted = rows where we found an invalid match but NO valid match yet
      const corrupted = db.prepare(
        `SELECT COUNT(*) as count FROM ${VERIFICATION_TABLE} WHERE discovered_invalid_message_id IS NOT NULL AND discovered_message_id IS NULL`
      ).get()
      const uncrankableWallet = db.prepare(
        `SELECT COUNT(*) as count FROM ${VERIFICATION_TABLE} WHERE uncrankable_reason = 'wallet'`
      ).get()
      const uncrankableTags = db.prepare(
        `SELECT COUNT(*) as count FROM ${VERIFICATION_TABLE} WHERE uncrankable_reason = 'tags'`
      ).get()
      const pending = db.prepare(
        `SELECT COUNT(*) as count FROM ${VERIFICATION_TABLE} WHERE discovered_message_id IS NULL AND uncrankable_reason IS NULL AND last_discovery_attempt IS NULL`
      ).get()
      // needsRetry includes rows with discovered_invalid_message_id since they're now retried
      const needsRetry = db.prepare(
        `SELECT COUNT(*) as count FROM ${VERIFICATION_TABLE} WHERE discovered_message_id IS NULL AND uncrankable_reason IS NULL AND last_discovery_attempt IS NOT NULL`
      ).get()
      const maxNonce = db.prepare(`SELECT MAX(nonce) as max_nonce FROM ${VERIFICATION_TABLE}`).get()
      const earliestRetry = db.prepare(
        `SELECT MIN(last_discovery_attempt) as earliest FROM ${VERIFICATION_TABLE} WHERE discovered_message_id IS NULL AND uncrankable_reason IS NULL AND last_discovery_attempt IS NOT NULL`
      ).get()
      return {
        total: total.count,
        discovered: discovered.count,
        corrupted: corrupted.count,
        uncrankableWallet: uncrankableWallet.count,
        uncrankableTags: uncrankableTags.count,
        pending: pending.count,
        needsRetry: needsRetry.count,
        maxNonce: maxNonce.max_nonce || 0,
        earliestRetryAttempt: earliestRetry.earliest || null
      }
    },

    /**
     * Query for debugging
     */
    query: (sql, params = []) => {
      return db.prepare(sql).all(...params)
    },

    close: () => {
      clearInterval(checkpointInterval)
      db.close()
      dbCache.delete(processId)
    },

    db
  }

  dbCache.set(processId, client)
  return client
}

export function closeAllVerificationDbs () {
  for (const [, client] of dbCache.entries()) {
    client.close()
  }
  dbCache.clear()
}
