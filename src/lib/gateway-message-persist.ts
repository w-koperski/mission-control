import { getDatabase } from './db'
import { eventBus } from './event-bus'
import { logger } from './logger'
import { isHumanAgent } from './agent-names'

export { isHumanAgent }

/**
 * Normalize the conversation_id from a gateway chat.message event payload
 * to the Mission Control UI format ("agent_<name>").
 *
 * OpenClaw uses session-key format ("agent:name:type").
 */
function normalizeConversationId(payload: any): string {
  const cid = payload?.conversation_id
  if (cid) {
    const m = String(cid).match(/^agent:([^:]+):/)
    if (m) return `agent_${m[1]}`
    return String(cid)
  }
  if (payload?.from_agent && !isHumanAgent(payload.from_agent)) {
    return `agent_${payload.from_agent}`
  }
  return `conv_${Date.now()}`
}

/**
 * Persist an incoming gateway chat.message event from an AI agent to the
 * messages table, then broadcast it via the SSE event bus so all connected
 * clients (including the comms panel) see it immediately.
 *
 * - Silently skips messages from human/system senders.
 * - Deduplicates by gateway message id (stored in metadata.gatewayId) so
 *   re-deliveries or dual proxy+WebSocket paths don't create duplicates.
 * - Never throws — failures are logged at WARN level only.
 *
 * Safe to call from server-side Node.js code (gateway-proxy.ts, API routes).
 */
export function persistGatewayMessage(payload: any, workspaceId = 1): void {
  if (!payload || !payload.content || !payload.from_agent) return
  if (isHumanAgent(payload.from_agent)) return

  try {
    const db = getDatabase()

    const conversationId = normalizeConversationId(payload)
    const fromAgent      = String(payload.from_agent)
    const toAgent        = payload.to_agent ? String(payload.to_agent) : null
    const content        = String(payload.content)
    const messageType    = String(payload.message_type || 'text')

    // Deduplicate by the gateway-supplied message id when present.
    // Use json_extract to safely query the JSON metadata column — avoids
    // treating % and _ in the id as SQL LIKE wildcards.
    const gatewayId = payload.id ? String(payload.id) : null

    if (!gatewayId) {
      // Helpful debug for operators: missing gateway message IDs mean
      // deduplication cannot be applied and multiple delivery paths may
      // produce duplicate messages.
      logger.debug({ from: fromAgent, conversationId }, '[gateway-message-persist] Incoming message missing gateway id; deduplication unavailable')
    }

    if (gatewayId) {
      const existing = db
        .prepare(
          "SELECT id FROM messages WHERE workspace_id = ? AND json_extract(metadata, '$.gatewayId') = ?"
        )
        .get(workspaceId, gatewayId)
      if (existing) return
    }

    // Merge gatewayId into the stored metadata so future dedup checks work.
    const mergedMeta = gatewayId
      ? JSON.stringify({ ...(payload.metadata || {}), gatewayId })
      : payload.metadata
        ? JSON.stringify(payload.metadata)
        : null

    const insertResult = db
      .prepare(
        `INSERT INTO messages
          (conversation_id, from_agent, to_agent, content, message_type, metadata, workspace_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(conversationId, fromAgent, toAgent, content, messageType, mergedMeta, workspaceId)

    const row = db
      .prepare('SELECT * FROM messages WHERE id = ? AND workspace_id = ?')
      .get(insertResult.lastInsertRowid, workspaceId) as any

    if (row) {
      eventBus.broadcast('chat.message', {
        ...row,
        metadata: row.metadata ? JSON.parse(row.metadata) : null,
      })
    }
  } catch (err) {
    logger.warn({ err }, '[gateway-message-persist] Failed to persist gateway chat.message to DB')
  }
}
