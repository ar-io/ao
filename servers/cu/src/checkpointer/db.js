import Database from 'better-sqlite3'

export function createDb (dbPath) {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS checkpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      process_id TEXT NOT NULL,
      time_requested TEXT NOT NULL,
      last_known_nonce INTEGER NOT NULL,
      bundler_url TEXT NOT NULL,
      data_item_id TEXT,
      block_height INTEGER
    )
  `)

  return {
    insertCheckpointRequest (processId, nonce, bundlerUrl) {
      const stmt = db.prepare(`
        INSERT INTO checkpoints (process_id, time_requested, last_known_nonce, bundler_url)
        VALUES (?, datetime('now'), ?, ?)
      `)
      return stmt.run(processId, nonce, bundlerUrl)
    },

    getLatestCheckpoint (processId) {
      return db.prepare(`
        SELECT * FROM checkpoints
        WHERE process_id = ?
        ORDER BY last_known_nonce DESC
        LIMIT 1
      `).get(processId)
    },

    getPendingCheckpoints () {
      return db.prepare(`
        SELECT * FROM checkpoints
        WHERE data_item_id IS NULL
        ORDER BY time_requested DESC
      `).all()
    },

    updateCheckpointIndexInfo (id, dataItemId, blockHeight) {
      db.prepare(`
        UPDATE checkpoints
        SET data_item_id = ?, block_height = ?
        WHERE id = ?
      `).run(dataItemId, blockHeight, id)
    },

    close () {
      db.close()
    }
  }
}
