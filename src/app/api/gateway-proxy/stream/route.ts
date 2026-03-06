import { NextRequest } from 'next/server'
import { requireRole } from '@/lib/auth'
import { config } from '@/lib/config'
import { getGatewayProxyManager } from '@/lib/gateway-proxy'
import { logger } from '@/lib/logger'

/**
 * GET /api/gateway-proxy/stream
 *
 * Server-Sent Events endpoint that relays gateway broadcast events
 * (tick, log, agent.status, chat.message, notification, etc.) to the
 * browser when GATEWAY_PROXY_MODE=1.
 *
 * The server-side WebSocket connection to the gateway is established
 * (or reused) automatically.  Each connected browser client receives a
 * copy of every event the gateway broadcasts.
 *
 * Security:
 *  - Only enabled when GATEWAY_PROXY_MODE=1.
 *  - Caller must be authenticated (viewer+).
 *  - Streams are isolated per request; no cross-tenant data leaks.
 */
export async function GET(request: NextRequest) {
  if (!config.gatewayProxyMode) {
    return new Response('Proxy mode not enabled', { status: 404 })
  }

  const auth = requireRole(request, 'viewer')
  if ('error' in auth) {
    return new Response(auth.error, { status: auth.status })
  }

  const manager = getGatewayProxyManager()
  if (!manager.isConnected()) {
    manager.connect()
  }

  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    start(controller) {
      function send(data: string): void {
        try {
          controller.enqueue(encoder.encode(`data: ${data}\n\n`))
        } catch {
          // Stream may already be closed
        }
      }

      // Initial connection acknowledgment
      send(JSON.stringify({ type: 'connected', timestamp: Date.now() }))

      const onEvent = (frame: unknown): void => {
        try {
          send(JSON.stringify(frame))
        } catch {
          // ignore serialisation errors
        }
      }

      manager.on('gateway_event', onEvent)

      // Clean up listener when the browser disconnects
      request.signal.addEventListener('abort', () => {
        manager.off('gateway_event', onEvent)
        try {
          controller.close()
        } catch {
          // already closed
        }
        logger.debug('[gateway-proxy/stream] Client disconnected')
      })
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
