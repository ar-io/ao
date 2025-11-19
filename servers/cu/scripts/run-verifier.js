#!/usr/bin/env node

/**
 * Message Verifier Runner
 *
 * Verifies that output messages from AO process evaluations
 * have been published to Arweave.
 *
 * Usage:
 *   node scripts/run-verifier.js <processId> [options]
 *
 * Options:
 *   --discovery-dir <path>     Discovery DB directory (default: ./data/process-messages)
 *   --verification-dir <path>  Verification DB directory (default: ./data/verification)
 *   --graphql-url <url>        GraphQL endpoint (default: https://arweave-search.goldsky.com/graphql)
 *   --retry-after <minutes>    Minutes before retrying unfound messages (default: 10)
 *   --batch-size <n>           Messages to verify per cycle (default: 100)
 *   --interval <ms>            Milliseconds between cycles (default: 60000)
 *   --once                     Run one cycle and exit
 *
 * Examples:
 *   node scripts/run-verifier.js qNvAoz0TgcH7DMg8BCVn8jF32QH5L6T29VjHxhHqqGE
 *   node scripts/run-verifier.js qNvAoz0TgcH7DMg8BCVn8jF32QH5L6T29VjHxhHqqGE --once
 *   node scripts/run-verifier.js qNvAoz0TgcH7DMg8BCVn8jF32QH5L6T29VjHxhHqqGE --retry-after 5 --batch-size 50
 */

import { runVerifier, MessageVerifier } from '../src/domain/message-verifier.js'

function parseArgs () {
  const args = process.argv.slice(2)

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(`
Message Verifier - Verify AO output messages on Arweave

Usage:
  node scripts/run-verifier.js <processId> [options]

Options:
  --discovery-dir <path>     Discovery DB directory (default: ./data/process-messages)
  --verification-dir <path>  Verification DB directory (default: ./data/verification)
  --graphql-url <url>        GraphQL endpoint
  --retry-after <minutes>    Minutes before retrying (default: 10)
  --batch-size <n>           Messages per cycle (default: 100)
  --interval <ms>            Ms between cycles (default: 60000)
  --once                     Run one cycle and exit
  --stats                    Show stats and exit

Examples:
  node scripts/run-verifier.js qNvAoz0TgcH7DMg8BCVn8jF32QH5L6T29VjHxhHqqGE
  node scripts/run-verifier.js qNvAoz0TgcH7DMg8BCVn8jF32QH5L6T29VjHxhHqqGE --once
  node scripts/run-verifier.js qNvAoz0TgcH7DMg8BCVn8jF32QH5L6T29VjHxhHqqGE --stats
`)
    process.exit(0)
  }

  const processId = args[0]
  const options = {
    processId,
    discoveryDbDir: './data/process-messages',
    verificationDbDir: './data/verification',
    graphqlUrl: 'https://arweave-search.goldsky.com/graphql',
    retryAfterMinutes: 10,
    batchSize: 100,
    intervalMs: 60000,
    once: false,
    stats: false
  }

  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case '--discovery-dir':
        options.discoveryDbDir = args[++i]
        break
      case '--verification-dir':
        options.verificationDbDir = args[++i]
        break
      case '--graphql-url':
        options.graphqlUrl = args[++i]
        break
      case '--retry-after':
        options.retryAfterMinutes = parseInt(args[++i], 10)
        break
      case '--batch-size':
        options.batchSize = parseInt(args[++i], 10)
        break
      case '--interval':
        options.intervalMs = parseInt(args[++i], 10)
        break
      case '--once':
        options.once = true
        break
      case '--stats':
        options.stats = true
        break
      default:
        console.error(`Unknown option: ${args[i]}`)
        process.exit(1)
    }
  }

  return options
}

async function main () {
  const options = parseArgs()

  if (options.stats) {
    // Just show stats and exit
    const verifier = new MessageVerifier({
      processId: options.processId,
      discoveryDbDir: options.discoveryDbDir,
      verificationDbDir: options.verificationDbDir
    })
    verifier.init()

    const stats = verifier.getStats()
    console.log('Verification Statistics:')
    console.log(`  Total messages: ${stats.total}`)
    console.log(`  Discovered: ${stats.discovered}`)
    console.log(`  Pending: ${stats.pending}`)
    console.log(`  Discovery rate: ${stats.total > 0 ? ((stats.discovered / stats.total) * 100).toFixed(1) : 0}%`)

    verifier.close()
    return
  }

  if (options.once) {
    // Run one cycle and exit
    const verifier = new MessageVerifier({
      processId: options.processId,
      discoveryDbDir: options.discoveryDbDir,
      verificationDbDir: options.verificationDbDir,
      graphqlUrl: options.graphqlUrl,
      retryAfterMinutes: options.retryAfterMinutes,
      batchSize: options.batchSize
    })
    verifier.init()

    console.log(`Running single verification cycle for process ${options.processId}`)
    const result = await verifier.runVerificationCycle()

    console.log('\nCycle Results:')
    console.log(`  Synced from discovery: ${result.synced}`)
    console.log(`  Verified: ${result.verified}`)
    console.log(`  Found: ${result.found}`)
    console.log(`  Not found: ${result.notFound}`)
    console.log(`  Errors: ${result.errors}`)

    const stats = verifier.getStats()
    console.log('\nOverall Stats:')
    console.log(`  Total: ${stats.total}`)
    console.log(`  Discovered: ${stats.discovered}`)
    console.log(`  Pending: ${stats.pending}`)

    verifier.close()
    return
  }

  // Run continuously
  await runVerifier({
    processId: options.processId,
    discoveryDbDir: options.discoveryDbDir,
    verificationDbDir: options.verificationDbDir,
    graphqlUrl: options.graphqlUrl,
    retryAfterMinutes: options.retryAfterMinutes,
    batchSize: options.batchSize,
    intervalMs: options.intervalMs
  })
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
