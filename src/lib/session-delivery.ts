import { runOpenClaw } from './command'

/**
 * Try to deliver a session message via openclaw gateway.
 * Returns null on success or when session delivery is not supported on this
 * installation, or a non-empty error string if both methods genuinely fail.
 *
 * Two gateway methods are tried in parallel:
 *  1. chat.send  – current OpenClaw 2026.x API  { sessionKey, message }
 *  2. sessions.send – legacy fallback            { session, message }
 *
 * The first to succeed resolves null.  If either gives a definitive "not
 * supported" error ("unknown method" or "unknown command"), we resolve null
 * immediately — session delivery is simply not available on this installation,
 * which is a normal, expected state that should not generate a warning.
 *
 * Typical timings:
 *  - Success via either method:        < 500 ms
 *  - Gateway "unknown method" (no-op): < 500 ms (short-circuit, resolves null)
 *  - Both genuinely unavailable:       bounded by timeoutMs (both time out)
 */
export function sendSessionMessage(
  sessionKey: string,
  message: string,
  timeoutMs = 5000
): Promise<string | null> {
  const chatSendPayload = JSON.stringify({ sessionKey, message })
  const legacyPayload   = JSON.stringify({ session: sessionKey, message })

  return new Promise<string | null>((resolve) => {
    let done = false
    const finish = (result: string | null) => {
      if (!done) {
        done = true
        resolve(result)
      }
    }

    let primaryError: string | null = null
    let primaryDone = false
    let legacyError: string | null = null
    let legacyDone = false

    const checkBothFailed = () => {
      if (primaryDone && legacyDone) {
        finish(
          [primaryError, legacyError].filter(Boolean).join('; ') ||
          'session delivery failed'
        )
      }
    }

    const isDefinitivelyUnsupported = (detail: string) =>
      detail.includes('unknown method') || detail.includes('unknown command')

    // Primary: openclaw gateway call chat.send (current API)
    runOpenClaw(
      ['gateway', 'call', 'chat.send', '--params', chatSendPayload],
      { timeoutMs }
    )
      .then(() => finish(null))
      .catch((e: any) => {
        const detail = String(e?.stderr || e?.message || 'gateway failed')
        primaryError = detail
        primaryDone = true
        if (isDefinitivelyUnsupported(detail)) {
          finish(null)
          return
        }
        checkBothFailed()
      })

    // Fallback: openclaw gateway call sessions.send (legacy API)
    runOpenClaw(
      ['gateway', 'call', 'sessions.send', '--params', legacyPayload],
      { timeoutMs }
    )
      .then(() => finish(null))
      .catch((e: any) => {
        const detail = String(e?.stderr || e?.message || 'gateway failed')
        legacyError = detail
        legacyDone = true
        if (isDefinitivelyUnsupported(detail)) {
          finish(null)
          return
        }
        checkBothFailed()
      })
  })
}
