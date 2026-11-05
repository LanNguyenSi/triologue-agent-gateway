/**
 * Shared parsing of the optional `threadId` on every send path (REST
 * `/byoa/sse/messages`, WebSocket `message` frame, legacy `/send`, MCP
 * `send_message`). Absent or null means a top-level room message; a string
 * must be non-empty after trimming. Mirrors what Triologue's
 * `POST /api/agents/message` accepts, so a bad value is refused here with a
 * 400 instead of becoming a 502 from upstream.
 */

export const THREAD_ID_ERROR = 'threadId must be a non-empty string when present';

export type ThreadIdParse =
  | { ok: true; threadId: string | null }
  | { ok: false; error: string };

export function parseThreadId(value: unknown): ThreadIdParse {
  if (value === undefined || value === null) return { ok: true, threadId: null };
  if (typeof value === 'string' && value.trim().length > 0) {
    return { ok: true, threadId: value.trim() };
  }
  return { ok: false, error: THREAD_ID_ERROR };
}
