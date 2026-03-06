Agent task: Implement optional "local-gateway-only" mode (run as Claude Sonnet 4.6)

Run this as a coding agent (model: claude-sonnet-4.6). Create a PR branch named feature/local-gateway-proxy.

Goal:
Implement a server-side proxy mode so Mission Control can operate when the OpenClaw gateway is not publicly exposed. In this mode the server performs all gateway interactions and forwards results to the browser (no direct browser WSS required). Keep it opt-in and secure.

Deliverables:
- Implement server proxy endpoints under src/app/api/gateway-proxy/
- Implement optional WebSocket relay (backend WS to gateway + relay to browser) or SSE fallback
- Wire frontend to use proxy when config flag enabled
- Add unit tests and e2e tests (use existing playwright config for local mode)
- Update README and .env.example
- Open PR: feature/local-gateway-proxy with tests and docs

Files & places to inspect first:
- src/lib/websocket.ts
- src/app/api/status/route.ts
- src/app/api/agents/sync/route.ts
- src/lib/agent-sync.ts
- scripts/e2e-openclaw/* and tests/openclaw-harness.spec.ts
- playwright.openclaw.local.config.ts
- ops/templates/openclaw-gateway@.service
- README.md and .env.example

Security & constraints:
- Provide allowlist of gateway methods exposed via proxy (status, models.list, sessions.send? — discuss and concretely list allowed set)
- Ensure tenant isolation and authentication checks for actions which affect sessions/agents
- Default behavior unchanged when flag is off

Acceptance criteria:
1) Frontend can operate with gateway not publicly exposed using server proxy
2) Tests added and passing locally
3) Clear docs for operators how to enable and security considerations

Implementation hints:
- Use lib/command.ts runCommand helper to invoke openclaw CLI
- Follow merging behavior from recently merged PR #10 for resilient parsing of non-JSON stdout
- Consider SSE for event streaming to avoid complex WebSocket proxying initially

Notes for reviewer:
- If you cannot implement full WebSocket relay, implement proxy endpoints + SSE fallback and document missing bits
- Keep changes small, opt-in, and well-tested

End of task prompt.
