import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { readLimiter } from '@/lib/rate-limit'
import { persistGatewayMessage, isHumanAgent } from '@/lib/gateway-message-persist'

/**
 * POST /api/chat/messages/ingest
 *
 * Lightweight endpoint for the browser-side WebSocket hook to persist
 * gateway chat.message events from AI agents into the local DB.
 *
 * Only needed in non-proxy mode (NEXT_PUBLIC_GATEWAY_PROXY_MODE != 1), where
 * the browser maintains the gateway WebSocket directly and the server has no
 * opportunity to intercept the messages server-side.
 *
 * Body: the raw gateway chat.message event payload
 *   { id?, from_agent, to_agent?, conversation_id?, content, message_type?, metadata? }
 *
 * - Silently skips messages from human/system/operator senders.
 * - Deduplicates by gateway message id so multiple ingest calls are idempotent.
 * - Returns { ok: true } on success, { skipped: true } when no action was needed.
 */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = readLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }

    if (!body.content?.trim()) {
      return NextResponse.json({ error: '"content" is required' }, { status: 400 })
    }

    if (!body.from_agent || isHumanAgent(body.from_agent)) {
      return NextResponse.json({ skipped: true })
    }

    const workspaceId = auth.user.workspace_id ?? 1
    persistGatewayMessage(body, workspaceId)

    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'Failed to ingest message' }, { status: 500 })
  }
}
