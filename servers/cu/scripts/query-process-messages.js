#!/usr/bin/env node
/**
 * Utility script to query process message databases
 *
 * Usage:
 *   node scripts/query-process-messages.js <processId> [options]
 *
 * Options:
 *   --nonce <nonce>            Filter by specific nonce
 *   --target <targetId>        Filter by target process
 *   --action <action>          Filter by Action tag value
 *   --input <inputMessageId>   Filter by input message ID
 *   --stats                    Show statistics instead of raw data
 *   --export-csv <filename>    Export results to CSV file
 *   --db-dir <path>            Custom database directory (default: ./data/process-messages)
 *
 * Examples:
 *   # Show all messages for a process
 *   node scripts/query-process-messages.js process-123
 *
 *   # Show messages for a specific nonce
 *   node scripts/query-process-messages.js process-123 --nonce 42
 *
 *   # Show statistics
 *   node scripts/query-process-messages.js process-123 --stats
 *
 *   # Export to CSV
 *   node scripts/query-process-messages.js process-123 --export-csv messages.csv
 */

import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'

const args = process.argv.slice(2)

// Parse command line arguments
function parseArgs (args) {
  const options = {
    processId: args[0],
    nonce: null,
    target: null,
    action: null,
    inputMessageId: null,
    stats: false,
    exportCsv: null,
    dbDir: './data/process-messages'
  }

  for (let i = 1; i < args.length; i++) {
    const arg = args[i]
    switch (arg) {
      case '--nonce':
        options.nonce = parseInt(args[++i], 10)
        break
      case '--target':
        options.target = args[++i]
        break
      case '--action':
        options.action = args[++i]
        break
      case '--input':
        options.inputMessageId = args[++i]
        break
      case '--stats':
        options.stats = true
        break
      case '--export-csv':
        options.exportCsv = args[++i]
        break
      case '--db-dir':
        options.dbDir = args[++i]
        break
      default:
        if (!options.processId) {
          options.processId = arg
        }
    }
  }

  return options
}

// Build SQL query based on filters
function buildQuery (options) {
  let sql = 'SELECT * FROM process_messages'
  const params = []
  const conditions = []

  if (options.nonce !== null) {
    conditions.push('nonce = ?')
    params.push(options.nonce)
  }

  if (options.target) {
    conditions.push('output_message_target = ?')
    params.push(options.target)
  }

  if (options.action) {
    conditions.push('output_message_action = ?')
    params.push(options.action)
  }

  if (options.inputMessageId) {
    conditions.push('input_message_id = ?')
    params.push(options.inputMessageId)
  }

  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ')
  }

  sql += ' ORDER BY nonce, output_message_index'

  return { sql, params }
}

// Get statistics query
function getStatsQuery () {
  return `
    SELECT
      COUNT(*) as total_messages,
      COUNT(DISTINCT nonce) as unique_nonces,
      COUNT(DISTINCT input_message_id) as unique_inputs,
      COUNT(DISTINCT output_message_target) as unique_targets,
      MIN(nonce) as first_nonce,
      MAX(nonce) as last_nonce,
      MIN(created_at) as first_created,
      MAX(created_at) as last_created
    FROM process_messages
  `
}

function getActionStatsQuery () {
  return `
    SELECT
      COALESCE(output_message_action, '<no action>') as action,
      COUNT(*) as count
    FROM process_messages
    GROUP BY output_message_action
    ORDER BY count DESC
  `
}

function getTargetStatsQuery () {
  return `
    SELECT
      output_message_target as target,
      COUNT(*) as count
    FROM process_messages
    GROUP BY output_message_target
    ORDER BY count DESC
    LIMIT 20
  `
}

// Format timestamp
function formatTimestamp (ts) {
  return new Date(ts).toISOString()
}

// Format results as table
function formatTable (results) {
  if (results.length === 0) {
    return 'No results found.'
  }

  // Get column widths
  const columns = Object.keys(results[0])
  const widths = {}
  columns.forEach(col => {
    widths[col] = Math.max(
      col.length,
      ...results.map(row => String(row[col] || '').length)
    )
  })

  // Header
  const header = columns.map(col => col.padEnd(widths[col])).join(' | ')
  const separator = columns.map(col => '-'.repeat(widths[col])).join('-+-')

  // Rows
  const rows = results.map(row =>
    columns.map(col => String(row[col] || '').padEnd(widths[col])).join(' | ')
  )

  return [header, separator, ...rows].join('\n')
}

// Export to CSV
function exportToCsv (results, filename) {
  if (results.length === 0) {
    console.log('No results to export.')
    return
  }

  const columns = Object.keys(results[0])
  const header = columns.join(',')
  const rows = results.map(row =>
    columns.map(col => {
      const value = row[col] || ''
      // Escape values containing commas or quotes
      if (String(value).includes(',') || String(value).includes('"')) {
        return `"${String(value).replace(/"/g, '""')}"`
      }
      return value
    }).join(',')
  )

  const csv = [header, ...rows].join('\n')
  writeFileSync(filename, csv)
  console.log(`Exported ${results.length} rows to ${filename}`)
}

// Main function
function main () {
  const options = parseArgs(args)

  if (!options.processId) {
    console.error('Error: processId is required')
    console.error('Usage: node scripts/query-process-messages.js <processId> [options]')
    process.exit(1)
  }

  const dbPath = join(options.dbDir, `${options.processId}.sqlite`)

  if (!existsSync(dbPath)) {
    console.error(`Error: Database not found at ${dbPath}`)
    console.error('Make sure the processId is correct and message tracking has been enabled.')
    process.exit(1)
  }

  console.log(`Querying database: ${dbPath}`)
  console.log()

  const db = Database(dbPath, { readonly: true })

  try {
    if (options.stats) {
      // Show statistics
      console.log('=== Overall Statistics ===')
      const stats = db.prepare(getStatsQuery()).get()
      console.log(`Total Messages: ${stats.total_messages}`)
      console.log(`Unique Nonces: ${stats.unique_nonces}`)
      console.log(`Unique Input Messages: ${stats.unique_inputs}`)
      console.log(`Unique Targets: ${stats.unique_targets}`)
      console.log(`Nonce Range: ${stats.first_nonce} - ${stats.last_nonce}`)
      console.log(`First Created: ${formatTimestamp(stats.first_created)}`)
      console.log(`Last Created: ${formatTimestamp(stats.last_created)}`)
      console.log()

      console.log('=== Messages by Action ===')
      const actionStats = db.prepare(getActionStatsQuery()).all()
      console.log(formatTable(actionStats))
      console.log()

      console.log('=== Top 20 Targets by Message Count ===')
      const targetStats = db.prepare(getTargetStatsQuery()).all()
      console.log(formatTable(targetStats))
    } else {
      // Query messages
      const { sql, params } = buildQuery(options)
      const results = db.prepare(sql).all(...params)

      if (options.exportCsv) {
        exportToCsv(results, options.exportCsv)
      } else {
        console.log(`Found ${results.length} messages`)
        console.log()
        console.log(formatTable(results))
      }
    }
  } finally {
    db.close()
  }
}

main()
