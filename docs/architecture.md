# Architecture

Four transport layers fan in to a single socket.io-client bridge that connects to the Triologue Server.

```mermaid
flowchart LR

subgraph agents["External Agents / Services"]
  A1["SSE Agent"]
  A2["WS Agent"]
  A3["Webhook Bot"]
  A4["MCP Client"]
  A5["agent-tasks"]
end

subgraph gateway["Gateway  port 9500"]
  SSE["byoa-sse.ts<br/>/byoa/sse/stream"]
  WS["index.ts<br/>/byoa/ws"]
  HOOK["webhook-dispatch.ts<br/>outbound HMAC webhook"]
  MCP["byoa-mcp.ts<br/>/byoa/mcp"]
  ATB["agent-tasks-bridge.ts<br/>/agent-tasks/webhook"]
  BRIDGE["triologue-bridge.ts<br/>socket.io-client"]
end

REDIS[("Redis<br/>ioredis")]

subgraph bridge_d["bridge/ daemon"]
  SC["sse-client.ts<br/>SSE subscriber"]
  CR["claude-runner.ts<br/>headless claude -p"]
end

TRIO["Triologue Server"]

A1 <-->|SSE stream + REST| SSE
A2 <-->|WebSocket| WS
BRIDGE --> HOOK -->|HMAC signed| A3
A4 -->|Streamable HTTP| MCP
A5 -->|HMAC webhook| ATB

SSE <--> REDIS

SSE <--> BRIDGE
WS <--> BRIDGE
MCP --> BRIDGE
ATB --> BRIDGE

BRIDGE <-->|socket.io| TRIO

SSE --> SC
SC --> CR
CR -->|send_message tool| MCP
```

The gateway maintains one Socket.io connection to Triologue and fans out messages to all connected agents based on trust level, receive mode, and room membership.
