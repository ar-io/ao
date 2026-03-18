export async function queryGql (endpoint, query, variables) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables })
  })
  if (!res.ok) throw new Error(`GQL request failed: ${res.status} ${await res.text()}`)
  const json = await res.json()
  if (json.errors) throw new Error(`GQL errors: ${JSON.stringify(json.errors)}`)
  return json.data
}

function pluckTag (name, tags) {
  const tag = tags.find(t => t.name === name)
  return tag ? tag.value : null
}

/**
 * Get the latest checkpoint for a process, returning its nonce,
 * data item id, block height, and other metadata.
 */
export async function getLatestCheckpoint (endpoint, processId) {
  const query = `
    query GetLatestCheckpoint($processId: String!) {
      transactions(
        tags: [
          { name: "Type", values: ["Checkpoint"] }
          { name: "Data-Protocol", values: ["ao"] }
          { name: "Process", values: [$processId] }
        ]
        first: 1
        sort: HEIGHT_DESC
      ) {
        edges {
          node {
            id
            owner { address }
            tags { name value }
            block { height }
          }
        }
      }
    }
  `

  const data = await queryGql(endpoint, query, { processId })
  const edge = data?.transactions?.edges?.[0]
  if (!edge) return null

  const { node } = edge
  return {
    dataItemId: node.id,
    blockHeight: node.block?.height ?? null,
    nonce: parseInt(pluckTag('Nonce', node.tags), 10) || null,
    timestamp: pluckTag('Timestamp', node.tags),
    owner: node.owner?.address
  }
}

/**
 * Find a checkpoint for a process at a specific nonce,
 * used to confirm a checkpoint we triggered was indexed.
 */
export async function findCheckpointAtNonce (endpoint, processId, nonce) {
  const query = `
    query FindCheckpointAtNonce($processId: String!, $nonce: String!) {
      transactions(
        tags: [
          { name: "Type", values: ["Checkpoint"] }
          { name: "Data-Protocol", values: ["ao"] }
          { name: "Process", values: [$processId] }
          { name: "Nonce", values: [$nonce] }
        ]
        first: 1
      ) {
        edges {
          node {
            id
            owner { address }
            tags { name value }
            block { height }
          }
        }
      }
    }
  `

  const data = await queryGql(endpoint, query, { processId, nonce: `${nonce}` })
  const edge = data?.transactions?.edges?.[0]
  if (!edge) return null

  const { node } = edge
  return {
    dataItemId: node.id,
    blockHeight: node.block?.height ?? null,
    nonce: parseInt(pluckTag('Nonce', node.tags), 10) || null,
    timestamp: pluckTag('Timestamp', node.tags)
  }
}

/**
 * Find a checkpoint with nonce greater than the given value.
 * Used after sending SIGUSR2 to verify the CU uploaded a new checkpoint.
 */
export async function findCheckpointAfterNonce (endpoint, processId, afterNonce) {
  const checkpoint = await getLatestCheckpoint(endpoint, processId)
  if (!checkpoint) return null
  if (checkpoint.nonce > afterNonce) return checkpoint
  return null
}
