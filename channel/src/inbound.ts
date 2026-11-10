/**
 * The inbound gate: what happens to a room message before anything reaches
 * the Claude Code session. Pure functions, no IO.
 *
 * Order: the agent's own messages are dropped; messages by other agents are
 * dropped unless allowed; the sender must be on the allowlist (a plain entry
 * is a Triologue user id and matches the sender id only, a `user:<name>` entry
 * matches the username only; never by room); only rooms this session is bound to
 * pass (an unbound session receives nothing); a message passes when its room
 * is bound or when it sits in a bound thread of that room (a session bound only
 * to a thread gets that thread's messages, not the room's top-level ones nor its
 * other threads); a `yes <id>` / `no <id>` from an allowed human becomes a
 * permission verdict and never reaches the model (from an agent it is dropped),
 * in a bound thread as in a bound room; a bound room that a more recently bound
 * session answers is dropped, but a bound thread is not subject to that order
 * (the gateway sends a thread's messages to the sessions bound to the thread);
 * everything else is delivered.
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

/**
 * Who may push into the session, lower-cased. User ids and usernames are kept
 * apart: Triologue ids are cuids and a username may look like one, so a
 * username equal to an allowed id must not pass.
 */
export interface AllowedSenders {
  /** Matched against the message's sender id only. */
  ids: Set<string>;
  /** Matched against the sender's username only. */
  usernames: Set<string>;
}

/** The prefix of an ALLOWED_SENDERS entry that names a username instead of a user id. */
export const USERNAME_ENTRY_PREFIX = 'user:';

/** ALLOWED_SENDERS entries: `user:<username>` is a username, any other entry a user id. */
export function parseAllowedSenders(entries: string[]): AllowedSenders {
  const allowed: AllowedSenders = { ids: new Set(), usernames: new Set() };
  for (const raw of entries) {
    const entry = raw.trim().toLowerCase();
    if (entry.startsWith(USERNAME_ENTRY_PREFIX)) {
      const username = entry.slice(USERNAME_ENTRY_PREFIX.length).trim();
      if (username.length > 0) allowed.usernames.add(username);
    } else if (entry.length > 0) {
      allowed.ids.add(entry);
    }
  }
  return allowed;
}

/** A thread this session is bound to: the room it belongs to and its title (for the notification meta). */
export interface ThreadBinding {
  roomId: string;
  title: string;
}

export interface GateConfig {
  /** Own username, to drop echoes of what this session sent. */
  selfUsername: string;
  allowedSenders: AllowedSenders;
  allowAgents: boolean;
  /** Rooms the session is bound to; nothing else reaches it, an empty set means nothing at all. */
  boundRooms: Set<string>;
  /** Threads the session is bound to (thread id -> binding); absent: none. */
  boundThreads?: Map<string, ThreadBinding>;
  /**
   * Whether this session answers a bound room, false when a more recently
   * bound session does (see bindings.ts). Absent: every bound room.
   */
  answersRoom?: (roomId: string) => boolean;
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
  const { ids, usernames } = config.allowedSenders;
  const senderId = typeof message.senderId === 'string' ? message.senderId.toLowerCase() : '';
  if (senderId.length > 0 && ids.has(senderId)) return true;
  const username = message.sender.toLowerCase();
  return username.length > 0 && usernames.has(username);
}

/**
 * The binding of the thread the message sits in, when the session is bound to
 * that thread and the thread belongs to the message's room (a message that
 * names a bound thread id with another room is not trusted to be in it).
 */
export function boundThreadOf(message: RoomMessage, config: GateConfig): ThreadBinding | null {
  if (!message.threadId) return null;
  const binding = config.boundThreads?.get(message.threadId);
  return binding && binding.roomId === message.room ? binding : null;
}

/**
 * Why a thread of this room may not be bound: the room has to be one the
 * session is bound to or one the agent is a member of. Null when it may.
 */
export function threadRoomRefusal(roomId: string, memberRooms: Iterable<string>, boundRooms: Set<string>): string | null {
  if (boundRooms.has(roomId)) return null;
  for (const member of memberRooms) if (member === roomId) return null;
  return `room ${roomId} is neither bound to this session nor one this agent is a member of`;
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
  const thread = boundThreadOf(message, config);
  if (!thread && !config.boundRooms.has(message.room)) {
    // A room where only threads are bound says so: its other messages are not meant for this session.
    const threadsHere = [...(config.boundThreads?.values() ?? [])].some((t) => t.roomId === message.room);
    return { action: 'drop', reason: threadsHere ? 'thread-not-bound' : 'room-not-bound' };
  }
  const verdict = PERMISSION_REPLY_RE.exec(message.content);
  if (verdict) {
    // Only a person decides what the terminal may run, whatever ALLOW_AGENTS says.
    if (message.senderType !== 'HUMAN') return { action: 'drop', reason: 'verdict-from-agent' };
    return {
      action: 'verdict',
      requestId: verdict[2].toLowerCase(),
      behavior: verdict[1].toLowerCase().startsWith('y') ? 'allow' : 'deny',
    };
  }
  // Checked after the verdict: a session that no longer answers the room
  // still takes the verdicts for the prompts it relayed there itself.
  if (!thread && config.answersRoom && !config.answersRoom(message.room)) {
    return { action: 'drop', reason: 'answered-by-newer-session' };
  }
  return { action: 'deliver', content: message.content, meta: buildMeta(message, thread?.title) };
}

/** Meta values land in the attributes of the <channel> tag; keep quotes, angle brackets and line breaks out. */
export function metaValue(value: string | null | undefined): string {
  return (value ?? '').replace(/[\r\n"<>]/g, ' ').trim();
}

/** The `<channel>` tag attributes; every value is a string, keys are identifiers. */
export function buildMeta(message: RoomMessage, threadTitle?: string | null): Record<string, string> {
  const meta: Record<string, string> = {
    room: metaValue(message.room),
    room_name: metaValue(message.roomName),
    thread_id: metaValue(message.threadId),
    message_id: metaValue(message.id),
    event_id: message.eventId === undefined ? '' : metaValue(String(message.eventId)),
    sender: metaValue(message.sender),
    sender_id: metaValue(message.senderId),
    sender_type: message.senderType,
  };
  // Only for a message in a thread this session is bound to; top-level meta keeps its keys.
  const title = metaValue(threadTitle);
  if (title.length > 0) meta.thread_title = title;
  for (const key of Object.keys(meta)) {
    if (!META_KEY_RE.test(key)) delete meta[key];
  }
  return meta;
}
