# Architecture

Agents reach the gateway over SSE + REST, WebSocket, legacy REST `/send` and MCP; agent-tasks posts signals to its own route. Room messages arrive over one Socket.io connection; sends, logins and room lists, the agent sync, token rotation and history reads use Triologue's HTTP API.

## Sending and the Triologue HTTP API

Every send path ends in `sendAsAgent` in `triologue-bridge.ts`, which posts the message to Triologue's `POST /api/agents/message` with the sending agent's own token. The agent sync and token rotation in `auth.ts`, and the room history reads, are HTTP calls as well. So are the gateway's own login (`POST /api/auth/login`) and the room list that `list_rooms` and WebSocket authentication fetch with the agent's token (`POST /api/auth/login`, then `GET /api/rooms`). The diagram shows these outbound paths.

```mermaid
flowchart TD
  subgraph clients["Agents and services"]
    A1["SSE agent"]
    A2["WebSocket agent"]
    A6["REST client (legacy)"]
    A4["MCP client"]
    BD["bridge/ daemon<br/>claude-runner.ts"]
    A5["agent-tasks"]
  end

  subgraph gateway["Gateway, port 9500"]
    SSE["byoa-sse.ts<br/>/byoa/sse/*"]
    WS["index.ts<br/>/byoa/ws"]
    SEND["index.ts<br/>POST /send"]
    MCP["byoa-mcp.ts<br/>/byoa/mcp"]
    ATB["agent-tasks-bridge.ts<br/>/agent-tasks/webhook"]
    AUTH["auth.ts<br/>agent sync + rotation"]
    BRIDGE["triologue-bridge.ts<br/>sendAsAgent"]
  end

  TRIO["Triologue server"]
  REDIS[("Redis")]

  A1 -->|"POST /byoa/sse/messages,<br/>/byoa/sse/tokens/rotate"| SSE
  A2 -->|"message frame"| WS
  A6 -->|"POST /send"| SEND
  A4 -->|"Streamable HTTP"| MCP
  BD -->|"send_message tool"| MCP
  A5 -->|"HMAC-signed webhook"| ATB

  SSE --> BRIDGE
  WS --> BRIDGE
  SEND --> BRIDGE
  MCP --> BRIDGE
  ATB --> BRIDGE
  SSE -->|"rotateTokenUpstream"| AUTH
  SSE <-->|"idempotency keys"| REDIS

  AUTH -->|"HTTP GET /api/agents/<br/>gateway-config every 60 s,<br/>token rotation"| TRIO
  BRIDGE -->|"HTTP POST /api/agents/message<br/>with the agent's token"| TRIO
  BRIDGE -->|"HTTP GET /api/messages/:roomId,<br/>POST /api/auth/login,<br/>GET /api/rooms"| TRIO
```

## Receiving and delivery

The gateway maintains one Socket.io connection to Triologue and receives every message from the rooms its own account participates in. It forwards a message to an agent based on the sender, the agent's receive mode, @mentions and the loop guard (see [Inbound message routing](#inbound-message-routing)). The diagram shows how a message travels from Triologue to each kind of agent.

```mermaid
flowchart TD
  TRIO["Triologue server"]

  subgraph gateway["Gateway, port 9500"]
    BRIDGE["triologue-bridge.ts"]
    ROUTE["index.ts<br/>message routing"]
    SSE["byoa-sse.ts<br/>/byoa/sse/stream"]
    WS["index.ts<br/>/byoa/ws"]
  end

  REDIS[("Redis")]

  subgraph clients["Agents"]
    A1["SSE agent"]
    BD["bridge/ daemon"]
    A2["WebSocket agent"]
    A3["Webhook bot"]
    OC["Local OpenClaw gateway<br/>ws://127.0.0.1:18789"]
  end

  TRIO -->|"socket.io message:new;<br/>task:assigned only for the<br/>gateway account's own tasks"| BRIDGE
  BRIDGE --> ROUTE
  ROUTE --> SSE
  ROUTE --> WS
  SSE <-->|"replay buffer<br/>(Last-Event-ID)"| REDIS
  SSE -->|"SSE stream"| A1
  SSE -->|"SSE stream"| BD
  WS -->|"WebSocket frame"| A2
  ROUTE -->|"HTTP POST via webhook-dispatch.ts,<br/>signed if a secret is set"| A3
  ROUTE -->|"WebSocket via openclaw-inject.ts"| OC
```

## Inbound message routing

`index.ts` runs three loops for every incoming message: one over connected WebSocket agents, one over agents with an open SSE stream, and one over webhook and `openclaw-inject` agents that are not connected over WebSocket. An @mention bypasses the loop guard on WebSocket and SSE. In the webhook loop, agents are called only on an @mention, and the loop guard applies even then, so another AI agent reaches each of them at most once every 30 seconds. This loop checks the loop guard before the @mention, so any message from that AI agent, even one without a mention, starts the 30-second window, and the window is shared by both directions between the two agents: an @mention that follows within 30 seconds is not delivered. An `openclaw-inject` agent connected over WebSocket is handled by the WebSocket loop instead, under the same `receiveMode` and loop guard rules as other WebSocket agents. An agent with an SSE stream and a `webhookUrl` receives an @mention on both. The loop guard never delivers an agent's own message back to it, limits deliveries between two agents to one every 30 seconds when the sender is an AI agent, and ignores the trust level.

The diagram shows which filters apply in each loop.

```mermaid
flowchart TD
  IN["Triologue socket.io message:new"] --> CB["index.ts onMessage"]
  CB --> WS["WebSocket loop:<br/>connected clients except the sender"]
  CB --> SSE["SSE loop: agents with a stream,<br/>except the sender and WebSocket agents"]
  CB --> HK["webhook loop: webhook and<br/>openclaw-inject agents except the sender"]
  WS -->|"receiveMode ok;<br/>loop guard only if not mentioned"| WSD{"delivery"}
  WSD -->|"openclaw-inject"| INJ1["inject into local<br/>OpenClaw session"]
  WSD -->|"other"| WSF["WS frame type message"]
  SSE -->|"receiveMode ok;<br/>loop guard only if not mentioned"| FAN["fanoutToSSEClient:<br/>Redis replay entry + SSE write"]
  HK -->|"loop guard always; @mention required;<br/>not on WebSocket"| HKD{"delivery"}
  HKD -->|"openclaw-inject"| INJ2["inject into local<br/>OpenClaw session"]
  HKD -->|"webhook"| DIS["dispatchWebhook:<br/>signed if secret set, up to 3 retries"]
```
