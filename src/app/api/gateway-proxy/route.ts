import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { config } from '@/lib/config'
import {
  getGatewayProxyManager,
  ALLOWED_GATEWAY_METHODS,
  OPERATOR_GATEWAY_METHODS,
} from '@/lib/gateway-proxy'
import { logger } from '@/lib/logger'

/**
 * POST /api/gateway-proxy
 *
 * Calls a single gateway method on behalf of the browser when
 * GATEWAY_PROXY_MODE=1.  The server-side WebSocket connection to the
 * gateway is used; the browser never touches the gateway directly.
 *
 * Body:  { method: string; params?: unknown }
 * Returns: { result: unknown } | { error: string }
 *
 * Security:
 *  - Only enabled when GATEWAY_PROXY_MODE=1.
 *  - Caller must be authenticated (viewer+ for read-only methods,
 *    operator+ for mutating methods).
 *  - Method name is validated against ALLOWED_GATEWAY_METHODS allowlist.
 */
export async function POST(request: NextRequest) {
  if (!config.gatewayProxyMode) {
    return NextResponse.json({ error: 'Proxy mode not enabled' }, { status: 404 })
  }

  // All callers need at minimum viewer role
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }

  let body: { method?: unknown; params?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { method, params } = body

  if (!method || typeof method !== 'string') {
    return NextResponse.json({ error: 'method is required' }, { status: 400 })
  }

  if (!ALLOWED_GATEWAY_METHODS.has(method)) {
    return NextResponse.json(
      { error: `Method not allowed: ${method}` },
      { status: 403 },
    )
  }

  // Mutating methods additionally require operator role
  if (OPERATOR_GATEWAY_METHODS.has(method)) {
    const operatorAuth = requireRole(request, 'operator')
    if ('error' in operatorAuth) {
      return NextResponse.json(
        { error: operatorAuth.error },
        { status: operatorAuth.status },
      )
    }
  }

  try {
    const manager = getGatewayProxyManager()
    if (!manager.isConnected()) {
      // Trigger a (re)connect attempt but return a 503 so the caller can retry
      manager.connect()
      return NextResponse.json({ error: 'Gateway not connected' }, { status: 503 })
    }

    const result = await manager.callMethod(method, params)
    return NextResponse.json({ result })
  } catch (err: unknown) {
    logger.error({ err, method }, '[gateway-proxy] POST call failed')
    const message = err instanceof Error ? err.message : 'Gateway call failed'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
