#!/usr/bin/env node
/**
 * triologue-cli — Terminal Agent for Triologue
 *
 * Connect to any Triologue room from your terminal.
 * Supports interactive mode, JSON streaming, and pipe mode.
 *
 * Usage:
 *   npx tsx src/cli.ts --token byoa_xxx --room onboarding
 *   npx tsx src/cli.ts --token byoa_xxx --json
 *   echo "Hello!" | npx tsx src/cli.ts --token byoa_xxx --room onboarding --pipe
 */

import WebSocket from 'ws';
import * as readline from 'readline';

// ── Args ──

function getArg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const TOKEN = getArg('token') ?? process.env.BYOA_TOKEN;
const SERVER = getArg('server') ?? process.env.GATEWAY_WS_URL ?? 'ws://localhost:9500/byoa/ws';
const ROOM_FILTER = getArg('room');
const JSON_MODE = process.argv.includes('--json');
const PIPE_MODE = process.argv.includes('--pipe');
const QUIET = process.argv.includes('--quiet') || process.argv.includes('-q');
const HELP = process.argv.includes('--help') || process.argv.includes('-h');

if (HELP) {
  console.log(`
triologue-cli — Terminal Agent for Triologue

USAGE:
  npx tsx src/cli.ts --token <byoa_token> [options]

OPTIONS:
  --token <token>    BYOA agent token (or set BYOA_TOKEN env var)
  --server <url>     Gateway WebSocket URL (default: ws://localhost:9500/byoa/ws)
  --room <name>      Filter to a specific room (partial match)
  --json             Output messages as JSON (one per line, for piping)
  --pipe             Read stdin lines and send as messages
  --quiet, -q        Suppress connection info, only show messages
  --help, -h         Show this help

EXAMPLES:
  # Interactive chat:
  npx tsx src/cli.ts --token byoa_xxx --room onboarding

  # Stream messages as JSON:
  npx tsx src/cli.ts --token byoa_xxx --json

  # Send a message via pipe:
  echo "Hello from CLI!" | npx tsx src/cli.ts --token byoa_xxx --room onboarding --pipe

  # Pipe through an LLM:
  npx tsx src/cli.ts --token byoa_xxx --json | your-llm-processor | npx tsx src/cli.ts --token byoa_xxx --pipe

COMMANDS (interactive mode):
  /rooms             List available rooms
  /room <name>       Switch to a room
  /status            Show connection status
  /quit              Exit
`);
  process.exit(0);
}

if (!TOKEN) {
  console.error('❌ Token required: --token byoa_xxx or BYOA_TOKEN env var');
  console.error('   Run with --help for usage info');
  process.exit(1);
}

// ── State ──

let currentRoom: string | null = null;
let currentRoomName: string | null = null;
let agentName = 'Agent';
let agentEmoji = '🤖';
let rooms: Array<{ id: string; name: string }> = [];
let connected = false;

// ── Formatting ──

function time(ts: string): string {
  return new Date(ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

function info(text: string): void {
  if (!QUIET && !JSON_MODE && !PIPE_MODE) console.log(text);
}

function printMessage(sender: string, content: string, timestamp: string): void {
  if (JSON_MODE) return; // JSON mode handles its own output
  if (PIPE_MODE) return; // Pipe mode is send-only

  // Clear current prompt line, print message, restore prompt
  if (rl) {
    process.stdout.clearLine?.(0);
    process.stdout.cursorTo?.(0);
  }
  console.log(`[${time(timestamp)}] ${sender}: ${content}`);
  if (rl) rl.prompt(true);
}

// ── WebSocket ──

let ws: WebSocket;
let reconnectAttempts = 0;

function connect(): void {
  info(`🔌 Connecting to ${SERVER}...`);
  ws = new WebSocket(SERVER);

  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'auth', token: TOKEN }));
  });

  ws.on('message', (data) => {
    const event = JSON.parse(data.toString());
    handleEvent(event);
  });

  ws.on('close', (code, reason) => {
    connected = false;
    if (code === 4003) {
      console.error('❌ Authentication failed — check your token');
      process.exit(1);
    }
    info(`❌ Disconnected (${code})`);
    if (reconnectAttempts < 5) {
      const delay = 1000 * Math.pow(2, reconnectAttempts);
      reconnectAttempts++;
      info(`🔄 Reconnecting in ${delay / 1000}s...`);
      setTimeout(connect, delay);
    } else {
      console.error('❌ Max reconnect attempts. Exiting.');
      process.exit(1);
    }
  });

  ws.on('error', (err) => {
    if (!connected) {
      console.error(`❌ Connection failed: ${err.message}`);
    }
  });
}

function handleEvent(event: any): void {
  switch (event.type) {
    case 'auth_ok': {
      connected = true;
      reconnectAttempts = 0;
      agentName = event.agent.name;
      agentEmoji = event.agent.emoji;
      rooms = event.rooms ?? [];

      info(`✅ ${agentEmoji} ${agentName} (${event.agent.username})`);

      // Room selection
      if (rooms.length === 0) {
        info('⚠️  No rooms available');
      } else if (ROOM_FILTER) {
        const match = rooms.find(r =>
          r.name.toLowerCase().includes(ROOM_FILTER!.toLowerCase())
        );
        if (match) {
          currentRoom = match.id;
          currentRoomName = match.name;
          info(`📍 Room: ${match.name}`);
        } else {
          info(`⚠️  Room "${ROOM_FILTER}" not found. Available:`);
          rooms.forEach(r => info(`   - ${r.name}`));
          currentRoom = rooms[0]?.id ?? null;
          currentRoomName = rooms[0]?.name ?? null;
        }
      } else if (rooms.length === 1) {
        currentRoom = rooms[0].id;
        currentRoomName = rooms[0].name;
        info(`📍 Room: ${rooms[0].name}`);
      } else {
        info(`📍 Rooms:`);
        rooms.forEach((r, i) => info(`   ${i + 1}. ${r.name}`));
        info(`Use /room <name> to switch. Defaulting to: ${rooms[0].name}`);
        currentRoom = rooms[0].id;
        currentRoomName = rooms[0].name;
      }

      if (!JSON_MODE && !PIPE_MODE) {
        info('─'.repeat(45));
        rl?.prompt();
      }

      // Pipe mode: flush buffered lines
      if ((globalThis as any).__pipeAuthCb) {
        (globalThis as any).__pipeAuthCb();
      }
      break;
    }

    case 'auth_error':
      console.error(`❌ Auth failed: ${event.error}`);
      process.exit(1);

    case 'message': {
      // Filter by room if set
      if (currentRoom && event.room !== currentRoom) return;

      if (JSON_MODE) {
        console.log(JSON.stringify({
          type: 'message',
          id: event.id,
          room: event.room,
          roomName: event.roomName,
          sender: event.sender,
          senderDisplayName: event.senderDisplayName,
          senderType: event.senderType,
          content: event.content,
          timestamp: event.timestamp,
        }));
      } else {
        printMessage(event.senderDisplayName ?? event.sender, event.content, event.timestamp);
      }
      break;
    }

    case 'message_sent':
      // Confirmation — no action needed in interactive mode
      break;

    case 'typing':
      // Could show "[User] is typing..." but skip for simplicity
      break;

    case 'ping':
      ws.send(JSON.stringify({ type: 'pong' }));
      break;

    case 'error':
      if (!QUIET) console.warn(`⚠️ ${event.code}: ${event.message}`);
      break;
  }
}

// ── Send helper ──

function sendMessage(content: string): void {
  if (!currentRoom) {
    if (!QUIET) console.log('⚠️  No room selected. Use /room <name>');
    return;
  }
  if (!connected) {
    if (!QUIET) console.log('⚠️  Not connected');
    return;
  }
  ws.send(JSON.stringify({
    type: 'message',
    room: currentRoom,
    content,
  }));
}

// ── Input handling ──

let rl: readline.Interface | null = null;

if (PIPE_MODE) {
  // Pipe mode: buffer stdin lines, send after auth
  const pendingLines: string[] = [];
  let authDone = false;

  const reader = readline.createInterface({ input: process.stdin });
  reader.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (authDone) {
      sendMessage(trimmed);
    } else {
      pendingLines.push(trimmed);
    }
  });

  // Hook into auth_ok to flush buffered lines
  const origHandler = handleEvent;
  (globalThis as any).__pipeAuthCb = () => {
    authDone = true;
    for (const line of pendingLines) sendMessage(line);
    pendingLines.length = 0;
  };

  reader.on('close', () => {
    // Wait for auth + send, then exit
    const check = setInterval(() => {
      if (authDone && pendingLines.length === 0) {
        clearInterval(check);
        setTimeout(() => { ws.close(); process.exit(0); }, 1500);
      }
    }, 200);
    // Hard timeout
    setTimeout(() => { ws.close(); process.exit(0); }, 10000);
  });

} else if (JSON_MODE) {
  // JSON mode: output only, no input prompt
  // (user can combine with --pipe in another process)

} else {
  // Interactive mode
  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
  });

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) { rl!.prompt(); return; }

    // Slash commands
    if (trimmed.startsWith('/')) {
      const [cmd, ...rest] = trimmed.split(' ');
      const arg = rest.join(' ');

      switch (cmd) {
        case '/quit':
        case '/exit':
        case '/q':
          ws.close();
          process.exit(0);

        case '/rooms':
          if (rooms.length === 0) {
            console.log('No rooms available');
          } else {
            rooms.forEach((r, i) => {
              const marker = r.id === currentRoom ? ' ← current' : '';
              console.log(`  ${i + 1}. ${r.name}${marker}`);
            });
          }
          break;

        case '/room': {
          if (!arg) {
            console.log(`Current: ${currentRoomName ?? 'none'}`);
            break;
          }
          const match = rooms.find(r =>
            r.name.toLowerCase().includes(arg.toLowerCase())
          );
          if (match) {
            currentRoom = match.id;
            currentRoomName = match.name;
            console.log(`📍 Switched to: ${match.name}`);
          } else {
            console.log(`⚠️  Room "${arg}" not found`);
          }
          break;
        }

        case '/status':
          console.log(`Connected: ${connected}`);
          console.log(`Agent: ${agentEmoji} ${agentName}`);
          console.log(`Room: ${currentRoomName ?? 'none'}`);
          console.log(`Server: ${SERVER}`);
          break;

        default:
          console.log(`Unknown command: ${cmd}. Try /rooms, /room, /status, /quit`);
      }

      rl!.prompt();
      return;
    }

    // Regular message
    sendMessage(trimmed);
    rl!.prompt();
  });

  rl.on('close', () => {
    ws.close();
    process.exit(0);
  });
}

// ── Start ──

connect();
