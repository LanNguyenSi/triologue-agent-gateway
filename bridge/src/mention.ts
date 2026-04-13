/**
 * Pure helpers for deciding whether an incoming Triologue message
 * should trigger a Claude run. No IO, no state — everything here is
 * exercised by unit tests.
 */

export interface IncomingMessage {
  id: string;
  room: string;
  /** Optional room name, used only for logs. */
  roomName?: string;
  /** Sender's Triologue username (e.g. `alice`, `claude-bot`). */
  sender: string;
  /** HUMAN or AI (from the gateway SSE payload). */
  senderType: 'HUMAN' | 'AI';
  content: string;
  timestamp: string;
}

export interface AgentIdentity {
  /** Username of the local agent — used to suppress self-replies. */
  username: string;
  /** Short mention key, e.g. `@code` — matched against the message. */
  mentionKey: string;
  /** If 'all', every room message triggers a run; if 'mentions',
   *  only explicit @mentions do. */
  receiveMode: 'mentions' | 'all';
}

/**
 * Lower-cased substring check for the mention key or full username.
 * Mirrors the gateway's inbound dispatch logic so the bridge's filter
 * decisions stay consistent with what the gateway considers a mention.
 */
export function isMentioned(message: IncomingMessage, agent: AgentIdentity): boolean {
  const lc = message.content.toLowerCase();
  return (
    lc.includes(`@${agent.mentionKey.toLowerCase()}`) ||
    lc.includes(`@${agent.username.toLowerCase()}`)
  );
}

/**
 * Hard loop-guard: never respond to our own messages. The gateway
 * already filters out sends back to the sender, but an agent that
 * shares a username with another participant could theoretically slip
 * through — this is the belt to the gateway's braces.
 */
export function isSelfMessage(message: IncomingMessage, agent: AgentIdentity): boolean {
  return message.sender.toLowerCase() === agent.username.toLowerCase();
}

/**
 * Combined decision: should the bridge enqueue a Claude run for this
 * message? Returns a concrete reason string on skip so callers can log
 * it at debug level without duplicating the conditionals.
 */
export function shouldTrigger(
  message: IncomingMessage,
  agent: AgentIdentity,
  roomAllowlist: Set<string> | null,
): { trigger: true } | { trigger: false; reason: string } {
  if (isSelfMessage(message, agent)) {
    return { trigger: false, reason: 'self-message' };
  }
  if (roomAllowlist && !roomAllowlist.has(message.room)) {
    return { trigger: false, reason: `room ${message.room} not in allowlist` };
  }
  if (agent.receiveMode === 'mentions' && !isMentioned(message, agent)) {
    return { trigger: false, reason: 'no mention and receiveMode=mentions' };
  }
  return { trigger: true };
}
