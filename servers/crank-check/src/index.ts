import Koa from 'koa'
import Router from 'koa-router'
import { koaSwagger } from 'koa2-swagger-ui'
import Database from 'better-sqlite3'
import { join } from 'node:path'

const PORT = parseInt(process.env.PORT || '3000', 10)
const VERIFICATION_DB_DIR = process.env.VERIFICATION_DB_DIR || './data/verification'

const app = new Koa()
const router = new Router()

const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Crank Check API',
    description: 'API for querying AO process verification status',
    version: '1.0.0'
  },
  servers: [
    {
      url: `http://localhost:${PORT}`,
      description: 'Local server'
    }
  ],
  paths: {
    '/messages/{processId}': {
      get: {
        summary: 'Query verification messages',
        description: 'Retrieve verification messages for a process with optional filtering',
        parameters: [
          {
            name: 'processId',
            in: 'path',
            required: true,
            description: 'The AO process ID',
            schema: { type: 'string' }
          },
          {
            name: 'input_message_id',
            in: 'query',
            description: 'Filter by input message ID',
            schema: { type: 'string' }
          },
          {
            name: 'nonce',
            in: 'query',
            description: 'Filter by nonce',
            schema: { type: 'integer' }
          },
          {
            name: 'cranked',
            in: 'query',
            description: 'Filter by crank status (whether message was discovered on Arweave)',
            schema: { type: 'string', enum: ['true', 'false'] }
          },
          {
            name: 'after',
            in: 'query',
            description: 'Filter messages with input_message_timestamp > this value (ms)',
            schema: { type: 'integer' }
          },
          {
            name: 'before',
            in: 'query',
            description: 'Filter messages with input_message_timestamp < this value (ms)',
            schema: { type: 'integer' }
          },
          {
            name: 'cursor',
            in: 'query',
            description: 'Pagination cursor (timestamp ms). Use nextCursor from previous response to get next page.',
            schema: { type: 'integer' }
          },
          {
            name: 'limit',
            in: 'query',
            description: 'Maximum number of rows to return (default 100, max 1000)',
            schema: { type: 'integer', default: 100, maximum: 1000 }
          }
        ],
        responses: {
          '200': {
            description: 'Successful response',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    processId: { type: 'string' },
                    count: { type: 'integer' },
                    nextCursor: { type: 'integer', nullable: true, description: 'Cursor for next page, null if no more results' },
                    messages: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/VerificationMessage' }
                    }
                  }
                }
              }
            }
          },
          '404': {
            description: 'Verification DB not found for process',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' }
              }
            }
          }
        }
      }
    },
    '/stats/{processId}': {
      get: {
        summary: 'Get verification statistics',
        description: 'Retrieve aggregate statistics for a process verification DB',
        parameters: [
          {
            name: 'processId',
            in: 'path',
            required: true,
            description: 'The AO process ID',
            schema: { type: 'string' }
          }
        ],
        responses: {
          '200': {
            description: 'Successful response',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    processId: { type: 'string' },
                    total: { type: 'integer', description: 'Total messages tracked' },
                    discovered: { type: 'integer', description: 'Messages found on Arweave (valid)' },
                    corrupted: { type: 'integer', description: 'Messages found but with wrong Reference tag' },
                    pending: { type: 'integer', description: 'Messages not yet checked' },
                    needsRetry: { type: 'integer', description: 'Messages checked but not found, awaiting retry' },
                    discoveryRate: { type: 'string', description: 'Percentage discovered (valid)' },
                    minNonce: { type: 'integer', nullable: true },
                    maxNonce: { type: 'integer', nullable: true }
                  }
                }
              }
            }
          },
          '404': {
            description: 'Verification DB not found for process',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' }
              }
            }
          }
        }
      }
    },
    '/health': {
      get: {
        summary: 'Health check',
        responses: {
          '200': {
            description: 'Service is healthy',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', example: 'ok' }
                  }
                }
              }
            }
          }
        }
      }
    }
  },
  components: {
    schemas: {
      VerificationMessage: {
        type: 'object',
        properties: {
          nonce: { type: 'integer', description: 'Input message nonce' },
          input_message_id: { type: 'string', description: 'Input message Arweave ID' },
          input_message_timestamp: { type: 'integer', nullable: true, description: 'Input message timestamp (ms)' },
          output_message_reference: { type: 'string', description: 'Output message reference tag value' },
          output_message_target: { type: 'string', description: 'Output message target process' },
          output_message_action: { type: 'string', nullable: true, description: 'Output message action tag' },
          output_message_index: { type: 'integer', description: 'Index of output message within evaluation' },
          created_at: { type: 'integer', description: 'When row was created (ms)' },
          discovered_message_id: { type: 'string', nullable: true, description: 'Arweave ID if message was found (valid)' },
          discovered_invalid_message_id: { type: 'string', nullable: true, description: 'Arweave ID if message was found with wrong Reference tag' },
          last_discovery_attempt: { type: 'integer', nullable: true, description: 'Last verification attempt timestamp (ms)' }
        }
      },
      Error: {
        type: 'object',
        properties: {
          error: { type: 'string' }
        }
      }
    }
  }
}

interface VerificationRow {
  nonce: number
  input_message_id: string
  input_message_timestamp: number | null
  output_message_reference: string
  output_message_target: string
  output_message_action: string | null
  output_message_index: number
  created_at: number
  discovered_message_id: string | null
  discovered_invalid_message_id: string | null
  last_discovery_attempt: number | null
}

function getDb(processId: string): Database.Database {
  const dbPath = join(VERIFICATION_DB_DIR, `${processId}.sqlite`)
  return new Database(dbPath, { readonly: true })
}

/**
 * GET /messages/:processId
 *
 * Query parameters:
 *   - input_message_id: filter by input message ID
 *   - nonce: filter by nonce
 *   - cranked: "true" or "false" - filter by whether discovered_message_id is set
 *   - after: timestamp (ms) - filter input_message_timestamp > after
 *   - before: timestamp (ms) - filter input_message_timestamp < before
 *   - cursor: timestamp (ms) - pagination cursor, equivalent to after (use for paging through results)
 *   - limit: max rows to return (default 100, max 1000)
 */
router.get('/messages/:processId', async (ctx) => {
  const { processId } = ctx.params
  const { input_message_id, nonce, cranked, after, before, cursor, limit } = ctx.query

  let db: Database.Database | null = null

  try {
    db = getDb(processId)

    const conditions: string[] = []
    const params: (string | number)[] = []

    if (input_message_id) {
      conditions.push('input_message_id = ?')
      params.push(String(input_message_id))
    }

    if (nonce !== undefined && nonce !== '') {
      const nonceVal = parseInt(Array.isArray(nonce) ? nonce[0] : nonce, 10)
      if (!isNaN(nonceVal)) {
        conditions.push('nonce = ?')
        params.push(nonceVal)
      }
    }

    if (cranked === 'true') {
      conditions.push('discovered_message_id IS NOT NULL')
    } else if (cranked === 'false') {
      conditions.push('discovered_message_id IS NULL')
    }

    // cursor is an alias for after, used for pagination
    const afterParam = cursor || after
    if (afterParam && afterParam !== '') {
      const afterVal = parseInt(Array.isArray(afterParam) ? afterParam[0] : afterParam, 10)
      if (!isNaN(afterVal)) {
        conditions.push('input_message_timestamp > ?')
        params.push(afterVal)
      }
    }

    if (before && before !== '') {
      const beforeVal = parseInt(Array.isArray(before) ? before[0] : before, 10)
      if (!isNaN(beforeVal)) {
        conditions.push('input_message_timestamp < ?')
        params.push(beforeVal)
      }
    }

    const limitStr = Array.isArray(limit) ? limit[0] : (limit || '100')
    const rowLimit = Math.min(Math.max(parseInt(limitStr, 10) || 100, 1), 1000)

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    // Order by timestamp if cursor/after is being used for pagination, otherwise by nonce
    const usesTimestampPagination = !!(cursor || after)
    const orderClause = usesTimestampPagination
      ? 'ORDER BY input_message_timestamp ASC, nonce ASC, output_message_index ASC'
      : 'ORDER BY nonce ASC, output_message_index ASC'

    const sql = `
      SELECT * FROM verification_messages
      ${whereClause}
      ${orderClause}
      LIMIT ?
    `
    params.push(rowLimit)

    const rows = db.prepare(sql).all(...params) as VerificationRow[]

    // Calculate next cursor from the last row's timestamp
    let nextCursor: number | null = null
    if (rows.length > 0 && rows.length === rowLimit) {
      const lastRow = rows[rows.length - 1]
      if (lastRow.input_message_timestamp !== null) {
        nextCursor = lastRow.input_message_timestamp
      }
    }

    ctx.body = {
      processId,
      count: rows.length,
      nextCursor,
      messages: rows
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'SQLITE_CANTOPEN') {
      ctx.status = 404
      ctx.body = { error: `No verification DB found for process ${processId}` }
    } else {
      throw err
    }
  } finally {
    db?.close()
  }
})

/**
 * GET /stats/:processId
 *
 * Get verification statistics for a process
 */
router.get('/stats/:processId', async (ctx) => {
  const { processId } = ctx.params

  let db: Database.Database | null = null

  try {
    db = getDb(processId)

    const total = db.prepare('SELECT COUNT(*) as count FROM verification_messages').get() as { count: number }
    const discovered = db.prepare(
      'SELECT COUNT(*) as count FROM verification_messages WHERE discovered_message_id IS NOT NULL'
    ).get() as { count: number }
    const corrupted = db.prepare(
      'SELECT COUNT(*) as count FROM verification_messages WHERE discovered_invalid_message_id IS NOT NULL'
    ).get() as { count: number }
    const pending = db.prepare(
      'SELECT COUNT(*) as count FROM verification_messages WHERE discovered_message_id IS NULL AND discovered_invalid_message_id IS NULL AND last_discovery_attempt IS NULL'
    ).get() as { count: number }
    const needsRetry = db.prepare(
      'SELECT COUNT(*) as count FROM verification_messages WHERE discovered_message_id IS NULL AND discovered_invalid_message_id IS NULL AND last_discovery_attempt IS NOT NULL'
    ).get() as { count: number }
    const maxNonce = db.prepare(
      'SELECT MAX(nonce) as max_nonce FROM verification_messages'
    ).get() as { max_nonce: number | null }
    const minNonce = db.prepare(
      'SELECT MIN(nonce) as min_nonce FROM verification_messages'
    ).get() as { min_nonce: number | null }

    ctx.body = {
      processId,
      total: total.count,
      discovered: discovered.count,
      corrupted: corrupted.count,
      pending: pending.count,
      needsRetry: needsRetry.count,
      discoveryRate: total.count > 0 ? ((discovered.count / total.count) * 100).toFixed(2) + '%' : '0%',
      minNonce: minNonce.min_nonce,
      maxNonce: maxNonce.max_nonce
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'SQLITE_CANTOPEN') {
      ctx.status = 404
      ctx.body = { error: `No verification DB found for process ${processId}` }
    } else {
      throw err
    }
  } finally {
    db?.close()
  }
})

/**
 * GET /health
 */
router.get('/health', (ctx) => {
  ctx.body = { status: 'ok' }
})

/**
 * GET /api-docs/spec - Raw OpenAPI JSON
 */
router.get('/api-docs/spec', (ctx) => {
  ctx.body = openApiSpec
})

app.use(async (ctx, next) => {
  try {
    await next()
  } catch (err) {
    console.error('Request error:', err)
    ctx.status = 500
    ctx.body = { error: 'Internal server error' }
  }
})

// Swagger UI at /api-docs
app.use(
  koaSwagger({
    routePrefix: '/api-docs',
    swaggerOptions: {
      spec: openApiSpec
    }
  })
)

app.use(router.routes())
app.use(router.allowedMethods())

app.listen(PORT, () => {
  console.log(`crank-check service listening on port ${PORT}`)
  console.log(`Verification DB directory: ${VERIFICATION_DB_DIR}`)
})
