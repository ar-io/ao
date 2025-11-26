import { createProcessMessagesDb } from './process-messages-db.js'

/**
 * MessageTracker is responsible for extracting output messages from AO process
 * evaluations and storing them in process-specific SQLite databases.
 *
 * This enables tracking of message delivery and re-cranking of failed messages.
 */
export class MessageTracker {
  constructor ({ baseDir, logger } = {}) {
    this.baseDir = baseDir
    this.logger = logger || console
    this.dbClients = new Map()
  }

  /**
   * Get or create a database client for a specific process
   */
  getDbClient (processId) {
    console.log('Getting DB client for processId:', processId)
    if (!this.dbClients.has(processId)) {
      const client = createProcessMessagesDb({
        processId,
        baseDir: this.baseDir
      })
      this.dbClients.set(processId, client)
    }
    return this.dbClients.get(processId)
  }

  /**
   * Process and store output messages from an evaluation
   *
   * @param {Object} output - The evaluation output containing Messages array
   * @param {string} processId - The process ID that generated these messages
   * @param {number} nonce - The nonce/ordinate of the input message
   * @param {string} inputMessageId - The ID of the input message that was evaluated
   */
  async trackMessages (output, processId, nonce, inputMessageId) {
    if (!output || !output.Messages || !Array.isArray(output.Messages)) {
      return
    }

    const messages = output.Messages
    if (messages.length === 0) {
      return
    }

    try {
      const db = this.getDbClient(processId)
      // Create records only for messages with a Target (i.e. not patch messages) and that have a Reference tag
      const messageRecords = messages
        .map((msg, index) => {
          if (!msg.Target) return null
          if (!this.extractReferenceTag(msg.Tags)) return null
          return {
            nonce: +nonce,
            inputMessageId,
            outputMessageReference: this.extractReferenceTag(msg.Tags),
            outputMessageTarget: msg.Target,
            outputMessageAction: this.extractActionTag(msg.Tags),
            outputMessageIndex: index
          }
        })
        .filter(record => record !== null)

      // Insert all messages in a single transaction for better performance
      db.insertMessages(messageRecords)

      this.logger.debug(
        'Tracked %d output messages for process %s (nonce: %d, input: %s)',
        messageRecords.length,
        processId,
        nonce,
        inputMessageId
      )
    } catch (error) {
      console.error('Message tracking error:', error)
      this.logger.error(
        'Failed to track messages for process %s (nonce: %d): %s',
        processId,
        nonce,
        error.message
      )
      this.logger.error('Stack trace:', error.stack)
      // Don't throw - we don't want message tracking failures to break evaluation
    }
  }

  /**
   * Extract the Action tag value from a message's tags array
   */
  extractActionTag (tags) {
    if (!tags || !Array.isArray(tags)) {
      return null
    }

    const actionTag = tags.find(tag => tag.name === 'Action')
    return actionTag ? actionTag.value : null
  }

  extractReferenceTag (tags) {
    if (!tags || !Array.isArray(tags)) {
      return null
    }

    const referenceTag = tags.find(tag => tag.name === 'Reference')
    return referenceTag ? referenceTag.value : null
  }

  /**
   * Close all database connections
   */
  closeAll () {
    for (const [processId, client] of this.dbClients.entries()) {
      try {
        client.close()
      } catch (error) {
        this.logger.error('Error closing db for process %s: %s', processId, error.message)
      }
    }
    this.dbClients.clear()
  }
}

/**
 * Create and export a singleton instance if MESSAGE_TRACKING_ENABLED is set
 */
export const messageTracker = process.env.MESSAGE_TRACKING_ENABLED === 'true'
  ? new MessageTracker({
    baseDir: process.env.MESSAGE_TRACKING_DB_DIR || './data/process-messages'
  })
  : undefined
