/**
 * Shared human-agent detection logic — no server-side imports so this can
 * be safely used in both server-side code (gateway-message-persist.ts) and
 * client-side code (websocket.ts).
 */

export const HUMAN_AGENT_NAMES = new Set(['human', 'system', 'operator'])

/** Returns true when the agent name is a human or system sender (not an AI agent). */
export function isHumanAgent(name: string): boolean {
  return HUMAN_AGENT_NAMES.has(String(name).toLowerCase())
}
