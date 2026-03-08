import { describe, it, expect, vi, beforeEach } from 'vitest'

// Must be hoisted so the vi.mock factory can reference these variables.
const { mockRunOpenClaw } = vi.hoisted(() => {
  const mockRunOpenClaw = vi.fn<() => Promise<{ stdout: string; stderr: string; code: number }>>()
  return { mockRunOpenClaw }
})

vi.mock('@/lib/command', () => ({
  runOpenClaw: mockRunOpenClaw,
}))

import { sendSessionMessage } from '@/lib/session-delivery'

describe('sendSessionMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns null when primary (chat.send) succeeds', async () => {
    // Primary succeeds immediately
    mockRunOpenClaw.mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })
    // Legacy fallback never needed; let it hang
    mockRunOpenClaw.mockReturnValue(new Promise(() => {/* never resolves */}))

    const result = await sendSessionMessage('mykey', 'hello')
    expect(result).toBeNull()
    expect(mockRunOpenClaw).toHaveBeenCalledTimes(2) // both fired in parallel
  })

  it('returns null when legacy (sessions.send) succeeds even though primary fails', async () => {
    // First call (chat.send) fails
    mockRunOpenClaw.mockRejectedValueOnce(new Error('chat.send not found'))
    // Second call (sessions.send) succeeds
    mockRunOpenClaw.mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })

    const result = await sendSessionMessage('mykey', 'hello')
    expect(result).toBeNull()
  })

  it('returns null (silent no-op) on "unknown method" error — session delivery not supported', async () => {
    // Both calls reject immediately with "unknown method"
    mockRunOpenClaw.mockRejectedValue(
      Object.assign(new Error('gateway failed'), {
        stderr: 'Gateway call failed: Error: unknown method: chat.send',
      })
    )

    const start = Date.now()
    const result = await sendSessionMessage('mykey', 'hello', 5000)
    const elapsed = Date.now() - start

    // Should resolve almost immediately, not wait for timeout
    expect(elapsed).toBeLessThan(500)
    // "unknown method" is treated as silent no-op, not an error
    expect(result).toBeNull()
  })

  it('returns null (silent no-op) on "unknown command" error', async () => {
    mockRunOpenClaw.mockRejectedValue(
      Object.assign(new Error('gateway failed'), {
        stderr: 'unknown command: chat.send',
      })
    )

    const start = Date.now()
    const result = await sendSessionMessage('mykey', 'hello', 5000)
    const elapsed = Date.now() - start

    expect(elapsed).toBeLessThan(500)
    expect(result).toBeNull()
  })

  it('returns combined error string when both methods fail with non-definitive errors', async () => {
    mockRunOpenClaw.mockRejectedValueOnce(
      Object.assign(new Error('chat.send error'), { stderr: 'chat.send connection refused' })
    )
    mockRunOpenClaw.mockRejectedValueOnce(
      Object.assign(new Error('sessions.send error'), { stderr: 'sessions.send connection timeout' })
    )

    const result = await sendSessionMessage('mykey', 'hello')
    expect(result).not.toBeNull()
    expect(result).toContain('chat.send connection refused')
    expect(result).toContain('sessions.send connection timeout')
  })

  it('passes correct params to primary (chat.send) and legacy (sessions.send)', async () => {
    mockRunOpenClaw.mockResolvedValue({ stdout: '', stderr: '', code: 0 })

    await sendSessionMessage('agent-session-123', 'Test message content')

    expect(mockRunOpenClaw).toHaveBeenCalledWith(
      ['gateway', 'call', 'chat.send', '--params',
        JSON.stringify({ sessionKey: 'agent-session-123', message: 'Test message content' })],
      expect.objectContaining({ timeoutMs: 5000 })
    )
    expect(mockRunOpenClaw).toHaveBeenCalledWith(
      ['gateway', 'call', 'sessions.send', '--params',
        JSON.stringify({ session: 'agent-session-123', message: 'Test message content' })],
      expect.objectContaining({ timeoutMs: 5000 })
    )
  })

  it('respects a custom timeoutMs value', async () => {
    mockRunOpenClaw.mockResolvedValue({ stdout: '', stderr: '', code: 0 })

    await sendSessionMessage('key', 'msg', 2000)

    expect(mockRunOpenClaw).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ timeoutMs: 2000 })
    )
  })
})

