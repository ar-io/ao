import { existsSync, mkdirSync, stat } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import bytes from 'bytes'

const ADDRESS_INFO_TABLE = 'address_info'

/**
 * Create address info cache table for wallet vs process lookup
 */
const createAddressInfoTable = (db) => db.prepare(
  `CREATE TABLE IF NOT EXISTS ${ADDRESS_INFO_TABLE}(
    address TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN ('w', 'p'))
  ) WITHOUT ROWID;`
).run()

/**
 * Singleton instance for the address info database
 */
let addressInfoDbInstance = null

/**
 * Creates or retrieves the global address info database client
 * This is a shared cache across all processes
 */
export function createAddressInfoDb ({
  baseDir = './data/verification',
  walLimit = bytes.parse('100mb')
} = {}) {
  if (addressInfoDbInstance) {
    return addressInfoDbInstance
  }

  if (!existsSync(baseDir)) {
    mkdirSync(baseDir, { recursive: true })
  }

  const dbPath = join(baseDir, 'address-info.sqlite')
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
  createAddressInfoTable(db)

  /**
   * Prepared statements
   */
  const getAddressInfoStmt = db.prepare(
    `SELECT type FROM ${ADDRESS_INFO_TABLE} WHERE address = ?`
  )

  const insertAddressInfoStmt = db.prepare(
    `INSERT OR IGNORE INTO ${ADDRESS_INFO_TABLE} (address, type) VALUES (?, ?)`
  )

  const client = {
    /**
     * Get address type from cache
     * @returns {string|null} 'w' for wallet, 'p' for process, null if not cached
     */
    getAddressType: (address) => {
      const row = getAddressInfoStmt.get(address)
      return row ? row.type : null
    },

    /**
     * Cache an address type
     * @param {string} address - The address to cache
     * @param {string} type - 'w' for wallet, 'p' for process
     */
    setAddressType: (address, type) => {
      return insertAddressInfoStmt.run(address, type)
    },

    /**
     * Batch cache multiple address types
     */
    setAddressTypes: (addressTypes) => {
      const transaction = db.transaction((items) => {
        for (const { address, type } of items) {
          insertAddressInfoStmt.run(address, type)
        }
      })
      return transaction(addressTypes)
    },

    close: () => {
      clearInterval(checkpointInterval)
      db.close()
      addressInfoDbInstance = null
    },

    db
  }

  addressInfoDbInstance = client
  return client
}

export function closeAddressInfoDb () {
  if (addressInfoDbInstance) {
    addressInfoDbInstance.close()
  }
}
