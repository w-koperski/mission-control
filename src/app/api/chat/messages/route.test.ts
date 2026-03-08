import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { GatewaySession } from '@/lib/sessions'

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const {
  mockRequireRole,
  mockLogger,
  mockRunOpenClaw,
  mockGetAllGatewaySessions,
  mockEventBus,
  mockDb,
  mockDbHelpers,
  mockStmt,
} = vi.hoisted(() => {
  const mockRequireRole = vi.fn()
  const mockLogger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
  const mockRunOpenClaw = vi.fn()
  const mockGetAllGatewaySessions = vi.fn(() => [] as any[])
  const mockEventBus = { broadcast: vi.fn() }

  // Lightweight db stub
  let _idCounter = 100
  const mockStmt = {
    run: vi.fn(() => ({ lastInsertRowid: ++_idCounter })),
    get: vi.fn((id: any) => ({
      id,
      conversation_id: 'agent_coordinator',
      from_agent: 'admin',
      to_agent: 'coordinator',
      content: 'hello',
      message_type: 'text',
      metadata: null,
      created_at: Math.floor(Date.now() / 1000),
      workspace_id: 1,
    })),
    all: vi.fn(() => []),
  }
  const mockDb = { prepare: vi.fn(() => mockStmt) }

  const mockDbHelpers = {
    logActivity: vi.fn(),
    createNotification: vi.fn(),
  }

  return {
    mockRequireRole,
    mockLogger,
    mockRunOpenClaw,
    mockGetAllGatewaySessions,
    mockEventBus,
    mockDb,
    mockDbHelpers,
    mockStmt,
  }
})

vi.mock('@/lib/auth', () => ({ requireRole: mockRequireRole }))
vi.mock('@/lib/logger', () => ({ logger: mockLogger }))
vi.mock('@/lib/command', () => ({ runOpenClaw: mockRunOpenClaw }))
vi.mock('@/lib/sessions', () => ({ getAllGatewaySessions: mockGetAllGatewaySessions }))
vi.mock('@/lib/event-bus', () => ({ eventBus: mockEventBus }))
vi.mock('@/lib/db', () => ({
  getDatabase: vi.fn(() => mockDb),
  db_helpers: mockDbHelpers,
  Message: {},
}))

import { POST } from './route'

// ── Helpers ────────────────────────────────────────────────────────────────

function makeRequest(body: object) {
  return new NextRequest('http://localhost/api/chat/messages', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

const authedUser = { id: 1, workspace_id: 1, role: 'operator', username: 'admin', display_name: 'Admin' }

const fakeSession: GatewaySession = {
  agent: 'coordinator',
  key: 'agent:coordinator:main',
  sessionId: 'sess-1',
  updatedAt: Date.now(),
  active: true,
  chatType: 'conversation',
  channel: '',
  model: '',
  totalTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  contextTokens: 0,
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('POST /api/chat/messages — basic', () => {
  beforeEach(() => {
    mockRequireRole.mockReturnValue({ user: authedUser })
  })
  afterEach(() => vi.clearAllMocks())

  it('returns 401 when unauthenticated', async () => {
    mockRequireRole.mockReturnValue({ error: 'Unauthorized', status: 401 })
    const res = await POST(makeRequest({ content: 'hi' }))
    expect(res.status).toBe(401)
  })

  it('returns 400 when content is missing', async () => {
    const res = await POST(makeRequest({ to: 'coordinator' }))
    expect(res.status).toBe(400)
  })

  it('stores the message and broadcasts SSE event', async () => {
    const res = await POST(makeRequest({ content: 'hello', to: 'coordinator', conversation_id: 'agent_coordinator' }))
    expect(res.status).toBe(201)
    expect(mockEventBus.broadcast).toHaveBeenCalledWith('chat.message', expect.objectContaining({ conversation_id: 'agent_coordinator' }))
  })
})

describe('POST /api/chat/messages — agent.wait for regular conversations', () => {
  beforeEach(() => {
    mockRequireRole.mockReturnValue({ user: authedUser })
  })
  afterEach(() => vi.clearAllMocks())

  it('returns 201 immediately for non-coord conversations when sessionKey is available (agent+deliver:true path)', async () => {
    // When a live session is found, agent+deliver:true is used — no background agent.wait.
    mockRunOpenClaw.mockResolvedValueOnce({ stdout: JSON.stringify({ status: 'accepted', runId: 'run-xyz' }), stderr: '', code: 0 })
    mockGetAllGatewaySessions.mockReturnValue([fakeSession])

    const start = Date.now()
    const res = await POST(makeRequest({
      content: 'hello',
      to: 'coordinator',
      conversation_id: 'agent_coordinator',
      forward: true,
    }))
    const elapsed = Date.now() - start

    expect(res.status).toBe(201)
    expect(elapsed).toBeLessThan(400)
    // Only one call: agent (no agent.wait for sessionKey+deliver:true path)
    expect(mockRunOpenClaw).toHaveBeenCalledTimes(1)
    const callArgs = (mockRunOpenClaw.mock.calls[0] as any[])[0] as string[]
    expect(callArgs).toContain('agent')
  })

  it('stores the agent reply in the DB via agent.wait when no live session (agentId path)', async () => {
    // No live session → agent method + agent.wait background task
    mockGetAllGatewaySessions.mockReturnValue([])

    mockRunOpenClaw
      .mockResolvedValueOnce({ stdout: JSON.stringify({ status: 'accepted', runId: 'run-abc-123' }), stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ status: 'completed', text: 'Hello from agent!' }), stderr: '', code: 0 })

    await POST(makeRequest({
      content: 'hello',
      to: 'coordinator',
      conversation_id: 'agent_coordinator',
      forward: true,
    }))

    // Let the background IIFE microtask settle
    await new Promise(resolve => setTimeout(resolve, 50))

    // agent.wait should have been called (second call)
    expect(mockRunOpenClaw).toHaveBeenCalledTimes(2)
    const secondCallArgs = (mockRunOpenClaw.mock.calls[1] as any[])[0] as string[]
    expect(secondCallArgs).toContain('agent.wait')
  })

  it('uses agent with {sessionKey, message, deliver:true} — no conversationId, runId NOT stored (no agent.wait)', async () => {
    mockRunOpenClaw.mockResolvedValueOnce({ stdout: JSON.stringify({ status: 'accepted', runId: 'run-live' }), stderr: '', code: 0 })
    mockGetAllGatewaySessions.mockReturnValue([fakeSession])

    await POST(makeRequest({
      content: 'hello',
      to: 'coordinator',
      conversation_id: 'agent_coordinator',
      forward: true,
    }))

    const firstCallArgs = (mockRunOpenClaw.mock.calls[0] as any[])[0] as string[]
    // Must use 'agent' method, not 'sessions.send'
    expect(firstCallArgs).toContain('agent')
    expect(firstCallArgs).not.toContain('sessions.send')
    const paramsIdx = firstCallArgs.indexOf('--params')
    const params = JSON.parse(firstCallArgs[paramsIdx + 1])
    // Live session path: {sessionKey, message, idempotencyKey, deliver: true}
    expect(params.sessionKey).toBe('agent:coordinator:main')
    expect(params.deliver).toBe(true)
    expect(params.message).toContain('hello')
    expect(params.conversationId).toBeUndefined()
    expect(params.idempotencyKey).toBeDefined()

    // No agent.wait should be started (only one openclaw call)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(mockRunOpenClaw).toHaveBeenCalledTimes(1)
  })

  it('does NOT call the non-coordinator agent.wait block for coord: conversations (sessionKey path)', async () => {
    // sessionKey path: coord conversations use agent+deliver:true, no agent.wait
    mockRunOpenClaw.mockResolvedValue({ stdout: JSON.stringify({ status: 'accepted', runId: 'run-coord' }), stderr: '', code: 0 })
    mockGetAllGatewaySessions.mockReturnValue([fakeSession])

    const res = await POST(makeRequest({
      content: 'run tasks',
      to: 'coordinator',
      conversation_id: 'coord:operator-session',
      forward: true,
    }))

    expect(res.status).toBe(201)
    // For coord: conversations with agent+deliver:true, only one gateway call (no agent.wait)
    expect(mockRunOpenClaw).toHaveBeenCalledTimes(1)
  })

  it('is non-fatal when agent invocation fails for live session — returns 201 and stores the user message', async () => {
    mockRunOpenClaw.mockRejectedValueOnce(new Error('gateway unavailable'))
    mockGetAllGatewaySessions.mockReturnValue([fakeSession])

    const res = await POST(makeRequest({
      content: 'hello',
      to: 'coordinator',
      conversation_id: 'agent_coordinator',
      forward: true,
    }))

    // Should still succeed — gateway send failure is non-fatal
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.message).toBeDefined()
  })

  it('creates a "still processing" status reply when agent.wait returns timeout status (agentId path)', async () => {
    // No live session → agent method path
    mockGetAllGatewaySessions.mockReturnValue([])

    mockRunOpenClaw
      .mockResolvedValueOnce({ stdout: JSON.stringify({ status: 'accepted', runId: 'run-slow' }), stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ status: 'timeout' }), stderr: '', code: 0 })

    const res = await POST(makeRequest({
      content: 'slow task',
      to: 'coordinator',
      conversation_id: 'agent_coordinator',
      forward: true,
    }))

    expect(res.status).toBe(201)

    // Wait for the background task to finish
    await new Promise(resolve => setTimeout(resolve, 50))

    const statusInsertCall = mockStmt.run.mock.calls.find((args: any[]) =>
      typeof args[3] === 'string' && args[3].includes('still being processed')
    )
    expect(statusInsertCall).toBeDefined()
  })
})

describe('POST /api/chat/messages — agent routing', () => {
  beforeEach(() => {
    mockRequireRole.mockReturnValue({ user: authedUser })
  })
  afterEach(() => vi.clearAllMocks())

  it('uses agentId (not DB session_key) when no live session exists in the gateway store', async () => {
    // Simulate agent record with a user-defined session_key and a config containing openclawId
    mockStmt.get.mockReturnValueOnce({
      id: 1,
      name: 'my-agent',
      session_key: 'stale-custom-label', // user-defined label — must NOT be sent to OpenClaw
      config: JSON.stringify({ openclawId: 'my-agent' }),
      workspace_id: 1,
    } as any)
    // No live sessions in gateway session store
    mockGetAllGatewaySessions.mockReturnValue([])

    mockRunOpenClaw
      .mockResolvedValueOnce({ stdout: JSON.stringify({ status: 'accepted', runId: 'run-1' }), stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ status: 'completed', text: 'ok' }), stderr: '', code: 0 })

    await POST(makeRequest({
      content: 'hello',
      to: 'my-agent',
      conversation_id: 'agent_my-agent',
      forward: true,
    }))

    const firstCallArgs = (mockRunOpenClaw.mock.calls[0] as any[])[0] as string[]
    expect(firstCallArgs).toContain('agent')
    const paramsIdx = firstCallArgs.indexOf('--params')
    const params = JSON.parse(firstCallArgs[paramsIdx + 1])

    // agentId must be used — NOT the stale DB session_key
    expect(params.agentId).toBe('my-agent')
    expect(params.sessionKey).toBeUndefined()
    expect(params.deliver).toBe(false)
    expect(params.idempotencyKey).toBeDefined()
  })

  it('uses agent with {sessionKey, deliver:true} when a live session exists — NOT the stale DB session_key', async () => {
    // Agent has a stale DB session_key that does NOT match any live session
    mockStmt.get.mockReturnValueOnce({
      id: 2,
      name: 'coordinator',
      session_key: 'stale-custom-label',
      config: JSON.stringify({ openclawId: 'coordinator' }),
      workspace_id: 1,
    } as any)
    // A live session exists in the gateway session store with the proper format
    mockGetAllGatewaySessions.mockReturnValue([fakeSession]) // key: 'agent:coordinator:main'

    mockRunOpenClaw.mockResolvedValueOnce({ stdout: JSON.stringify({ status: 'accepted', runId: 'run-2' }), stderr: '', code: 0 })

    await POST(makeRequest({
      content: 'hello',
      to: 'coordinator',
      conversation_id: 'agent_coordinator',
      forward: true,
    }))

    const firstCallArgs = (mockRunOpenClaw.mock.calls[0] as any[])[0] as string[]
    // Must use 'agent' method — never 'sessions.send'
    expect(firstCallArgs).toContain('agent')
    expect(firstCallArgs).not.toContain('sessions.send')
    const paramsIdx = firstCallArgs.indexOf('--params')
    const params = JSON.parse(firstCallArgs[paramsIdx + 1])

    // The properly-formatted live session key is used, NOT the stale DB label
    expect(params.sessionKey).toBe('agent:coordinator:main')
    expect(params.sessionKey).not.toBe('stale-custom-label')
    expect(params.deliver).toBe(true)
    expect(params.agentId).toBeUndefined()
  })
})

