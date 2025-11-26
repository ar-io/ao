import { existsSync, mkdirSync, stat } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import bytes from 'bytes'

/**
 * Capture the real Date.now before AoLoader can overwrite it
 * (AoLoader modifies Date.now for deterministic WASM evaluation)
 */
const realDateNow = Date.now.bind(Date)

const PROCESS_MESSAGES_TABLE = 'process_messages'

/**
 * Create the process messages table schema
 * This table tracks all output messages for a specific process
 */
const createProcessMessagesTable = (db) => db.prepare(
  `CREATE TABLE IF NOT EXISTS ${PROCESS_MESSAGES_TABLE}(
    nonce INTEGER NOT NULL,
    input_message_id TEXT NOT NULL,
    input_message_timestamp INTEGER,
    output_message_reference TEXT NOT NULL,
    output_message_target TEXT NOT NULL,
    output_message_action TEXT,
    output_message_index INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (nonce, output_message_index)
  ) WITHOUT ROWID;`
).run()

/**
 * Create indexes for efficient querying
 */
const createIndexes = (db) => {
  db.prepare(
    `CREATE INDEX IF NOT EXISTS idx_${PROCESS_MESSAGES_TABLE}_nonce
      ON ${PROCESS_MESSAGES_TABLE} (nonce);`
  ).run()

  db.prepare(
    `CREATE INDEX IF NOT EXISTS idx_${PROCESS_MESSAGES_TABLE}_input_message_id
      ON ${PROCESS_MESSAGES_TABLE} (input_message_id);`
  ).run()

  db.prepare(
    `CREATE INDEX IF NOT EXISTS idx_${PROCESS_MESSAGES_TABLE}_output_message_target
      ON ${PROCESS_MESSAGES_TABLE} (output_message_target);`
  ).run()
}

/**
 * Cache for database connections keyed by processId
 */
const dbCache = new Map()

/**
 * Creates or retrieves a process-specific database client
 *
 * @param {string} processId - The process ID to create/get database for
 * @param {string} baseDir - Base directory for process databases (default: ./data/process-messages)
 * @param {number} walLimit - WAL file size limit before checkpoint (default: 100mb)
 * @returns {Object} Database client with insert methods
 */
export function createProcessMessagesDb ({
  processId,
  baseDir = './data/process-messages',
  walLimit = bytes.parse('100mb')
}) {
  if (!processId) {
    throw new Error('processId is required')
  }

  // Return cached connection if it exists
  if (dbCache.has(processId)) {
    return dbCache.get(processId)
  }

  // Ensure base directory exists
  if (!existsSync(baseDir)) {
    mkdirSync(baseDir, { recursive: true })
  }

  const dbPath = join(baseDir, `${processId}.sqlite`)
  const db = Database(dbPath)

  // Configure SQLite for optimal performance
  db.pragma('encoding = "UTF-8"')
  db.pragma('journal_mode = WAL')

  /**
   * Periodically checkpoint the WAL to prevent it from growing too large
   * https://github.com/WiseLibs/better-sqlite3/blob/master/docs/performance.md#checkpoint-starvation
   */
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
  createProcessMessagesTable(db)
  createIndexes(db)

  /**
   * Prepared statement for inserting process messages
   */
  const insertStmt = db.prepare(
    `INSERT OR REPLACE INTO ${PROCESS_MESSAGES_TABLE}
    (nonce, input_message_id, input_message_timestamp, output_message_reference, output_message_target,
     output_message_action, output_message_index, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )

  const client = {
    /**
     * Insert a single process message record
     */
    insertMessage: ({
      nonce,
      inputMessageId,
      inputMessageTimestamp,
      outputMessageReference,
      outputMessageTarget,
      outputMessageAction,
      outputMessageIndex
    }) => {
      return insertStmt.run(
        nonce,
        inputMessageId,
        inputMessageTimestamp || null,
        outputMessageReference,
        outputMessageTarget,
        outputMessageAction || null,
        outputMessageIndex,
        realDateNow()
      )
    },

    /**
     * Insert multiple messages in a transaction for better performance
     */
    insertMessages: (messages) => {
      const transaction = db.transaction((msgs) => {
        for (const msg of msgs) {
          const now = realDateNow()
          insertStmt.run(
            msg.nonce,
            msg.inputMessageId,
            msg.inputMessageTimestamp || null,
            msg.outputMessageReference,
            msg.outputMessageTarget,
            msg.outputMessageAction || null,
            msg.outputMessageIndex,
            now
          )
        }
      })
      return transaction(messages)
    },

    /**
     * Query messages for debugging/testing
     */
    query: (sql, params = []) => {
      return db.prepare(sql).all(...params)
    },

    /**
     * Close the database connection
     */
    close: () => {
      clearInterval(checkpointInterval)
      db.close()
      dbCache.delete(processId)
    },

    /**
     * Get the underlying database instance for advanced operations
     */
    db
  }

  // Cache the connection
  dbCache.set(processId, client)

  return client
}

/**
 * Close all cached database connections
 */
export function closeAllProcessMessagesDbs () {
  for (const [, client] of dbCache.entries()) {
    client.close()
  }
  dbCache.clear()
}
