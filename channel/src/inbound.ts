/**
 * The inbound gate: what happens to a room message before anything reaches
 * the Claude Code session. Pure functions, no IO.
 *
 * Order: the agent's own messages are dropped; messages by other agents are
 * dropped unless allowed; the sender must be on the allowlist (by Triologue
 * user id or username, never by room); with room bindings, only bound rooms
 * pass; a `yes <id>` / `no <id>` from an allowed sender becomes a permission
 * verdict and never reaches the model; everything else is delivered.
 */

export interface RoomMessage {
  id: string;
  room: string;
  roomName?: string;
  threadId?: string | null;
  sender: string;
  senderId?: string | null;
  senderType: 'HUMAN' | 'AI';
  content: string;
  timestamp: string;
  /** SSE event id, when the gateway sent one. */
  eventId?: number | string;
}

export interface GateConfig {
  /** Own username, to drop echoes of what this session sent. */
  selfUsername: string;
  /** Lower-cased user ids and usernames allowed to push into the session. */
  allowedSenders: Set<string>;
  allowAgents: boolean;
  /** Rooms the session is bound to; empty means every room the agent is in. */
  boundRooms: Set<string>;
}

export type GateDecision =
  | { action: 'drop'; reason: string }
  | { action: 'verdict'; requestId: string; behavior: 'allow' | 'deny' }
  | { action: 'deliver'; content: string; meta: Record<string, string> };

/** Claude Code's permission ids: five lowercase letters without `l`; the reply may be autocorrected. */
export const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i;

/** Channel meta keys may only hold letters, digits and underscores. */
export const META_KEY_RE = /^[A-Za-z0-9_]+$/;

export function isAllowedSender(message: RoomMessage, config: GateConfig): boolean {
  const candidates = [message.senderId, message.sender]
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .map((v) => v.toLowerCase());
  return candidates.some((c) => config.allowedSenders.has(c));
}

export function decideInbound(message: RoomMessage, config: GateConfig): GateDecision {
  if (message.sender.toLowerCase() === config.selfUsername.toLowerCase()) {
    return { action: 'drop', reason: 'self' };
  }
  if (message.senderType === 'AI' && !config.allowAgents) {
    return { action: 'drop', reason: 'ai-sender' };
  }
  if (!isAllowedSender(message, config)) {
    return { action: 'drop', reason: 'sender-not-allowed' };
  }
  if (config.boundRooms.size > 0 && !config.boundRooms.has(message.room)) {
    return { action: 'drop', reason: 'room-not-bound' };
  }
  const verdict = PERMISSION_REPLY_RE.exec(message.content);
  if (verdict) {
    return {
      action: 'verdict',
      requestId: verdict[2].toLowerCase(),
      behavior: verdict[1].toLowerCase().startsWith('y') ? 'allow' : 'deny',
    };
  }
  return { action: 'deliver', content: message.content, meta: buildMeta(message) };
}

/** The `<channel>` tag attributes; every value is a string, keys are identifiers. */
export function buildMeta(message: RoomMessage): Record<string, string> {
  const meta: Record<string, string> = {
    room: message.room,
    room_name: message.roomName ?? '',
    thread_id: message.threadId ?? '',
    message_id: message.id,
    event_id: message.eventId === undefined ? '' : String(message.eventId),
    sender: message.sender,
    sender_id: message.senderId ?? '',
    sender_type: message.senderType,
  };
  for (const key of Object.keys(meta)) {
    if (!META_KEY_RE.test(key)) delete meta[key];
  }
  return meta;
}
