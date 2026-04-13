/**
 * BYOA MCP endpoint — Streamable HTTP transport for MCP-capable clients
 * (Claude Code, Cursor, Cline, …) to drive outbound operations against
 * Triologue without writing REST boilerplate.
 *
 * ## Scope
 *
 * Outbound only: list rooms, read room history, send a message. The
 * inbound side (delivering a user's @mention back to the local agent)
 * cannot work via plain MCP because stock clients don't pick up
 * server-initiated notifications — that's what the separate
 * `triologue-bridge` daemon task covers.
 *
 * ## Transport
 *
 * Stateless StreamableHTTPServerTransport — one McpServer per request.
 * Each request carries its own Bearer token in the Authorization
 * header, which the handler validates before spinning up a server
 * whose tool handlers close over the authenticated agent + token.
 *
 * Stateless mode means there is no session ID, no reconnection state,
 * no in-memory history. Every tool call is an isolated round-trip.
 * For a pure outbound integration this is the simplest model and the
 * cheapest to reason about.
 *
 * ## Auth
 *
 * Same Bearer token mechanism as the other BYOA endpoints. An invalid
 * token returns 401 before any MCP machinery is touched.
 *
 * ## Tools
 *
 * - `list_rooms` — rooms the authenticated agent is a member of
 * - `get_room_messages` — paginated history from a room
 * - `send_message` — post a message to a room (goes through
 *   `bridge.sendAsAgent`, which applies the control-string filter
 *   for `NO_REPLY` / `HEARTBEAT_OK`; note that the current loop-guard
 *   lives on the *inbound* dispatch path in `index.ts`, so outbound
 *   sends from MCP, REST /send, and the WS handler are all unguarded
 *   by design today)
 */

import type { Request, Response, Router } from 'express';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { authenticateToken } from './auth';
import type { TriologueBridge } from './triologue-bridge';
import type { AgentInfo } from './types';

let bridgeRef: TriologueBridge | null = null;

export function setBridge(bridge: TriologueBridge): void {
  bridgeRef = bridge;
}

function getBridge(): TriologueBridge {
  if (!bridgeRef) {
    throw new Error('byoa-mcp: bridge not set — call setBridge() during startup');
  }
  return bridgeRef;
}

function extractBearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1] : null;
}

/**
 * Build a fresh McpServer for a single authenticated request. Tools
 * close over the agent + token, so each tool call naturally inherits
 * the caller's auth without relying on any ambient global.
 */
function buildServerForAgent(agent: AgentInfo, token: string): McpServer {
  const server = new McpServer({
    name: 'triologue-byoa-mcp',
    version: '0.1.0',
  });

  const bridge = getBridge();

  server.registerTool(
    'list_rooms',
    {
      description:
        'List the Triologue rooms the authenticated agent is a member of. Returns id + name for each room.',
      inputSchema: {},
    },
    async () => {
      try {
        const rooms = await bridge.getAgentRooms(token, agent.username);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(rooms, null, 2),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: 'text', text: `list_rooms failed: ${message}` }],
        };
      }
    },
  );

  server.registerTool(
    'get_room_messages',
    {
      description:
        'Fetch recent messages from a Triologue room. Defaults to the 50 most recent. Use `after_message_id` to page forward from a known message.',
      inputSchema: {
        room_id: z.string().min(1),
        limit: z.number().int().positive().max(200).optional(),
        after_message_id: z.string().min(1).optional(),
      },
    },
    async ({ room_id, limit, after_message_id }) => {
      try {
        const messages = await bridge.fetchMessagesSince(
          token,
          room_id,
          after_message_id ?? null,
          limit ?? 50,
        );
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(messages, null, 2),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [
            { type: 'text', text: `get_room_messages failed: ${message}` },
          ],
        };
      }
    },
  );

  server.registerTool(
    'send_message',
    {
      description:
        'Send a message to a Triologue room as the authenticated agent. Goes through the same pipeline as the REST /send endpoint. Note: control strings `NO_REPLY` and `HEARTBEAT_OK` are silently filtered server-side and never posted — the tool still returns success in that case, mirroring the existing /send behaviour.',
      inputSchema: {
        room_id: z.string().min(1),
        content: z.string().min(1),
      },
    },
    async ({ room_id, content }) => {
      try {
        await bridge.sendAsAgent(token, room_id, content);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ ok: true, room_id }, null, 2),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: 'text', text: `send_message failed: ${message}` }],
        };
      }
    },
  );

  return server;
}

/**
 * Handle a single MCP request. Spins up a per-request McpServer and
 * StreamableHTTPServerTransport in stateless mode so each request is
 * independent. The transport handles JSON-RPC parsing, tool dispatch,
 * and streaming responses.
 */
async function handleMcpRequest(req: Request, res: Response): Promise<void> {
  const token = extractBearer(req);
  if (!token) {
    res.status(401).json({
      jsonrpc: '2.0',
      error: {
        code: -32001,
        message: 'Missing Authorization: Bearer <byoa_token> header',
      },
      id: null,
    });
    return;
  }

  const agent = authenticateToken(token);
  if (!agent) {
    res.status(401).json({
      jsonrpc: '2.0',
      error: {
        code: -32001,
        message: 'Invalid or inactive BYOA token',
      },
      id: null,
    });
    return;
  }

  const server = buildServerForAgent(agent, token);
  const transport = new StreamableHTTPServerTransport({
    // Stateless: no session ID, no reconnection window. Every request
    // is an independent round-trip.
    sessionIdGenerator: undefined,
  });

  // Clean up once the request is done so we don't leak transports on
  // long-lived processes. McpServer.close() also closes the transport,
  // and the SDK typically closes both from inside handleRequest, so
  // guard against the double-close surfacing as a warning. We still
  // want the debug log if something unexpected escapes — silent swallow
  // masks regressions.
  let closed = false;
  const safeClose = (): void => {
    if (closed) return;
    closed = true;
    server.close().catch((err) => {
      console.debug(`[byoa-mcp] server.close() warning: ${err?.message ?? err}`);
    });
  };
  res.on('close', safeClose);

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[byoa-mcp] request failed: ${message}`);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: `Internal error: ${message}` },
        id: null,
      });
    }
  }
}

export const mcpRouter: Router = express.Router();

// Only POST is accepted. In stateless mode there is no session to
// resume via GET and nothing to tear down via DELETE, so both return
// 405 before any auth or MCP machinery runs — cheap reject, no
// transport allocation, no amplifier for probe traffic.
mcpRouter.post('/', handleMcpRequest);
mcpRouter.all('/', (_req, res) => {
  res.setHeader('Allow', 'POST');
  res.status(405).json({
    jsonrpc: '2.0',
    error: {
      code: -32601,
      message: 'Method Not Allowed — /byoa/mcp accepts POST only (stateless Streamable HTTP)',
    },
    id: null,
  });
});
