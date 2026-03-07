import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const { mockRequireRole, mockLogger, mockDb, mockSendSessionMessage, mockMutationLimiter } =
  vi.hoisted(() => {
    const mockRequireRole = vi.fn()
    const mockLogger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    }
    const agentWithKey = {
      id: 1,
      name: 'agent-a',
      session_key: 'sk-abc123',
    }
    const agentWithoutKey = {
      id: 2,
      name: 'agent-no-key',
      session_key: null,
    }
    const mockPrepare = vi.fn(() => ({
      get: vi.fn((name: string) =>
        name === 'agent-a' ? agentWithKey : name === 'agent-no-key' ? agentWithoutKey : null
      ),
      run: vi.fn(),
      all: vi.fn(() => []),
    }))
    const mockDb = {
      prepare: mockPrepare,
    }
    const mockDbModule = {
      getDatabase: vi.fn(() => mockDb),
      db_helpers: {
        createNotification: vi.fn(),
        logActivity: vi.fn(),
      },
    }
    const mockSendSessionMessage = vi.fn<() => Promise<string | null>>()
    const mockMutationLimiter = vi.fn(() => null)
    return {
      mockRequireRole,
      mockLogger,
      mockDb,
      mockDbModule,
      agentWithKey,
      agentWithoutKey,
      mockSendSessionMessage,
      mockMutationLimiter,
    }
  })

vi.mock('@/lib/auth', () => ({ requireRole: mockRequireRole }))
vi.mock('@/lib/logger', () => ({ logger: mockLogger }))
vi.mock('@/lib/db', () => ({
  getDatabase: vi.fn(() => mockDb),
  db_helpers: {
    createNotification: vi.fn(),
    logActivity: vi.fn(),
  },
}))
vi.mock('@/lib/session-delivery', () => ({
  sendSessionMessage: mockSendSessionMessage,
}))
vi.mock('@/lib/rate-limit', () => ({
  mutationLimiter: mockMutationLimiter,
}))

import { POST } from './route'
import { db_helpers } from '@/lib/db'

// ── Helpers ────────────────────────────────────────────────────────────────

function makeRequest(body: object) {
  return new NextRequest('http://localhost/api/agents/message', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

const authedUser = { id: 1, workspace_id: 1, role: 'operator', username: 'admin', display_name: 'Admin' }

// ── Tests ──────────────────────────────────────────────────────────────────

describe('POST /api/agents/message — auth', () => {
  afterEach(() => vi.clearAllMocks())

  it('returns 401 when unauthenticated', async () => {
    mockRequireRole.mockReturnValue({ error: 'Unauthorized', status: 401 })
    const res = await POST(makeRequest({ to: 'agent-a', message: 'hi' }))
    expect(res.status).toBe(401)
  })
})

describe('POST /api/agents/message — with session key', () => {
  beforeEach(() => {
    mockRequireRole.mockReturnValue({ user: authedUser })
    mockSendSessionMessage.mockResolvedValue(null)
  })
  afterEach(() => vi.clearAllMocks())

  it('delivers via session when session_key is set', async () => {
    const res = await POST(makeRequest({ to: 'agent-a', message: 'hello' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(mockSendSessionMessage).toHaveBeenCalledOnce()
    expect(mockSendSessionMessage).toHaveBeenCalledWith('sk-abc123', expect.stringContaining('hello'))
  })

  it('returns 200 with delivery_warning when session delivery fails', async () => {
    mockSendSessionMessage.mockResolvedValue('clawdbot connection refused')
    const res = await POST(makeRequest({ to: 'agent-a', message: 'hello' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.delivery_warning).toBeDefined()
  })
})

describe('POST /api/agents/message — without session key', () => {
  beforeEach(() => {
    mockRequireRole.mockReturnValue({ user: authedUser })
  })
  afterEach(() => vi.clearAllMocks())

  it('succeeds (notification-only) when session_key is absent — does not return 400', async () => {
    const res = await POST(makeRequest({ to: 'agent-no-key', message: 'hey' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
  })

  it('does NOT call sendSessionMessage when session_key is absent', async () => {
    await POST(makeRequest({ to: 'agent-no-key', message: 'hey' }))
    expect(mockSendSessionMessage).not.toHaveBeenCalled()
  })

  it('still creates a notification when session_key is absent', async () => {
    await POST(makeRequest({ to: 'agent-no-key', message: 'hey' }))
    expect(db_helpers.createNotification).toHaveBeenCalled()
  })
})

describe('POST /api/agents/message — agent not found', () => {
  beforeEach(() => {
    mockRequireRole.mockReturnValue({ user: authedUser })
  })
  afterEach(() => vi.clearAllMocks())

  it('returns 404 for unknown agent', async () => {
    const res = await POST(makeRequest({ to: 'nonexistent-agent', message: 'hi' }))
    expect(res.status).toBe(404)
  })
})
