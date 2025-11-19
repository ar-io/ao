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
    output_message_reference TEXT NOT NULL,
    output_message_target TEXT NOT NULL,
    output_message_action TEXT,
    output_message_index INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    discovered_message_id TEXT,
    last_discovery_attempt INTEGER,
    PRIMARY KEY (nonce, output_message_index)
  ) WITHOUT ROWID;`
).run()

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
  createCursorTable(db)
  createIndexes(db)

  /**
   * Prepared statements
   */
  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO ${VERIFICATION_TABLE}
    (nonce, input_message_id, output_message_reference, output_message_target,
     output_message_action, output_message_index, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`
  )

  const getCursorStmt = db.prepare(
    `SELECT last_synced_nonce FROM ${CURSOR_TABLE} WHERE process_id = ?`
  )

  const updateCursorStmt = db.prepare(
    `INSERT OR REPLACE INTO ${CURSOR_TABLE} (process_id, last_synced_nonce, last_sync_time)
    VALUES (?, ?, ?)`
  )

  const getRowsToVerifyStmt = db.prepare(
    `SELECT * FROM ${VERIFICATION_TABLE}
    WHERE discovered_message_id IS NULL
      AND (last_discovery_attempt IS NULL OR last_discovery_attempt < ?)
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

  const updateAttemptOnlyStmt = db.prepare(
    `UPDATE ${VERIFICATION_TABLE}
    SET last_discovery_attempt = ?
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
            msg.output_message_reference,
            msg.output_message_target,
            msg.output_message_action || null,
            msg.output_message_index,
            msg.created_at
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
     */
    getRowsToVerify: (retryAfterMs, limit = 100) => {
      const cutoffTime = realDateNow() - retryAfterMs
      return getRowsToVerifyStmt.all(cutoffTime, limit)
    },

    /**
     * Update a row with discovered message ID
     */
    updateDiscovered: (nonce, outputMessageIndex, messageId) => {
      return updateDiscoveredStmt.run(messageId, realDateNow(), nonce, outputMessageIndex)
    },

    /**
     * Update only the attempt timestamp (message not found)
     */
    updateAttemptOnly: (nonce, outputMessageIndex) => {
      return updateAttemptOnlyStmt.run(realDateNow(), nonce, outputMessageIndex)
    },

    /**
     * Get verification statistics
     */
    getStats: () => {
      const total = db.prepare(`SELECT COUNT(*) as count FROM ${VERIFICATION_TABLE}`).get()
      const discovered = db.prepare(
        `SELECT COUNT(*) as count FROM ${VERIFICATION_TABLE} WHERE discovered_message_id IS NOT NULL`
      ).get()
      const pending = db.prepare(
        `SELECT COUNT(*) as count FROM ${VERIFICATION_TABLE} WHERE discovered_message_id IS NULL`
      ).get()
      return {
        total: total.count,
        discovered: discovered.count,
        pending: pending.count
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
