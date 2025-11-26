import https from 'https'

async function fetchCheckpoint (processId, minBlockHeight, maxBlockHeight, owners) {
  const blockCondition = minBlockHeight && maxBlockHeight
    ? `block: {min: ${minBlockHeight}, max: ${maxBlockHeight}}`
    : ''

  const gqlQuery = JSON.stringify({
    query: `
      query GetAoProcessCheckpoints(
        $owners: [String!]!
        $processId: String!
        $limit: Int!
      ) {
        transactions(
          tags: [
            { name: "Process", values: [$processId] }
            { name: "Type", values: ["Checkpoint"] }
            { name: "Data-Protocol", values: ["ao"] }
          ],
          owners: $owners,
          first: $limit,
          sort: HEIGHT_DESC
          ${blockCondition ? `, ${blockCondition}` : ''}
        ) {
          edges {
            node {
              id
              owner {
                address
              }
              tags {
                name
                value
              }
            }
          }
        }
      }
    `,
    variables: {
      owners,
      processId,
      limit: 1
    }
  })

  console.error(`GQL Query: ${gqlQuery}`)

  const options = {
    hostname: 'arweave-search.goldsky.com',
    path: '/graphql',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(gqlQuery)
    }
  }

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = ''

      res.on('data', (chunk) => {
        data += chunk
      })

      res.on('end', () => {
        try {
          const response = JSON.parse(data)
          const edges = response?.data?.transactions?.edges || []

          if (edges.length === 0) {
            resolve({ found: false })
            return
          }

          const node = edges[0].node
          const tags = {}
          for (const tag of node.tags) {
            tags[tag.name] = tag.value
          }

          resolve({
            found: true,
            id: node.id,
            owner: node.owner.address,
            tags
          })
        } catch (error) {
          reject(error)
        }
      })
    })

    req.on('error', (error) => {
      reject(error)
    })

    req.write(gqlQuery)
    req.end()
  })
}

(async () => {
  const args = process.argv.slice(2)
  const [processId, minBlockHeight, maxBlockHeight, ownersArg] = args

  if (!processId || !ownersArg) {
    console.error('Usage: node get_checkpoint.js <processId> <minBlockHeight> <maxBlockHeight> <owners>')
    console.error('  owners: comma-separated list of wallet addresses')
    process.exit(1)
  }

  // Parse comma-separated owners
  const owners = ownersArg.split(',').map(o => o.trim()).filter(o => o)

  if (owners.length === 0) {
    console.error('Error: At least one owner address is required')
    process.exit(1)
  }

  try {
    const result = await fetchCheckpoint(processId, minBlockHeight, maxBlockHeight, owners)
    console.log(JSON.stringify(result, null, 2))
  } catch (error) {
    console.error('Error:', error)
    process.exit(1)
  }
})()
