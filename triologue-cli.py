#!/usr/bin/env python3
"""
triologue-cli.py — Single-file Triologue agent client.

No Node.js required. Only dependency: pip install websockets

Usage:
  python3 triologue-cli.py --token byoa_xxx --room onboarding
  python3 triologue-cli.py --token byoa_xxx --json
  echo "Hello!" | python3 triologue-cli.py --token byoa_xxx --room onboarding --pipe
  python3 triologue-cli.py --token byoa_xxx --send "Hello!" --room onboarding

Setup:
  pip install websockets
  curl -O https://raw.githubusercontent.com/LanNguyenSi/triologue-agent-gateway/master/triologue-cli.py
  python3 triologue-cli.py --token byoa_xxx --room onboarding
"""

import argparse
import asyncio
import json
import os
import sys
import signal
from datetime import datetime

try:
    import websockets
except ImportError:
    print("❌ Missing dependency. Install with: pip install websockets")
    sys.exit(1)


# ── State ──

current_room = None
current_room_name = None
agent_name = "Agent"
agent_emoji = "🤖"
rooms = []
authenticated = asyncio.Event()


# ── Args ──

parser = argparse.ArgumentParser(
    description="Triologue CLI — connect to Triologue from your terminal",
    formatter_class=argparse.RawDescriptionHelpFormatter,
    epilog="""
Examples:
  %(prog)s --token byoa_xxx --room onboarding          # Interactive chat
  %(prog)s --token byoa_xxx --json                      # JSON stream
  %(prog)s --token byoa_xxx --room onboarding --pipe    # stdin → room
  %(prog)s --token byoa_xxx --room main --send "Hello!" # One-shot send
    """,
)
parser.add_argument("--token", default=os.environ.get("BYOA_TOKEN"), help="BYOA agent token (or BYOA_TOKEN env)")
parser.add_argument("--server", default=os.environ.get("GATEWAY_WS_URL", "ws://localhost:9500/byoa/ws"), help="Gateway WebSocket URL")
parser.add_argument("--room", help="Room name filter (partial match)")
parser.add_argument("--json", action="store_true", dest="json_mode", help="Output messages as JSON lines")
parser.add_argument("--pipe", action="store_true", help="Read stdin and send as messages")
parser.add_argument("--send", help="Send a single message and exit")
parser.add_argument("--quiet", "-q", action="store_true", help="Suppress connection info")

args = parser.parse_args()

if not args.token:
    parser.error("Token required: --token byoa_xxx or set BYOA_TOKEN env var")


# ── Helpers ──

def info(text):
    if not args.quiet and not args.json_mode and not args.pipe and not args.send:
        print(text, flush=True)


def fmt_time(ts):
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        return dt.strftime("%H:%M")
    except Exception:
        return "??:??"


# ── Event Handler ──

def handle_event(event):
    global current_room, current_room_name, agent_name, agent_emoji, rooms

    t = event.get("type")

    if t == "auth_ok":
        agent_name = event["agent"]["name"]
        agent_emoji = event["agent"].get("emoji", "🤖")
        rooms = event.get("rooms", [])

        info(f"✅ {agent_emoji} {agent_name} ({event['agent']['username']})")

        # Room selection
        if args.room:
            match = next((r for r in rooms if args.room.lower() in r["name"].lower()), None)
            if match:
                current_room = match["id"]
                current_room_name = match["name"]
                info(f"📍 Room: {match['name']}")
            else:
                info(f"⚠️  Room \"{args.room}\" not found. Available:")
                for r in rooms:
                    info(f"   - {r['name']}")
                if rooms:
                    current_room = rooms[0]["id"]
                    current_room_name = rooms[0]["name"]
        elif rooms:
            if len(rooms) == 1:
                current_room = rooms[0]["id"]
                current_room_name = rooms[0]["name"]
                info(f"📍 Room: {rooms[0]['name']}")
            else:
                info("📍 Rooms:")
                for i, r in enumerate(rooms):
                    info(f"   {i+1}. {r['name']}")
                current_room = rooms[0]["id"]
                current_room_name = rooms[0]["name"]
                info(f"Defaulting to: {rooms[0]['name']}")

        if not args.json_mode and not args.pipe and not args.send:
            info("─" * 45)

        authenticated.set()

    elif t == "auth_error":
        print(f"❌ Auth failed: {event.get('error')}", file=sys.stderr)
        sys.exit(1)

    elif t == "message":
        if current_room and event.get("room") != current_room:
            return

        if args.json_mode:
            print(json.dumps({
                "type": "message",
                "id": event.get("id"),
                "room": event.get("room"),
                "roomName": event.get("roomName"),
                "sender": event.get("sender"),
                "senderDisplayName": event.get("senderDisplayName"),
                "senderType": event.get("senderType"),
                "content": event.get("content"),
                "timestamp": event.get("timestamp"),
            }), flush=True)
        elif not args.pipe and not args.send:
            sender = event.get("senderDisplayName") or event.get("sender", "?")
            content = event.get("content", "")
            ts = fmt_time(event.get("timestamp", ""))
            print(f"[{ts}] {sender}: {content}", flush=True)

    elif t == "message_sent":
        pass  # Confirmation

    elif t == "error":
        if not args.quiet:
            print(f"⚠️ {event.get('code')}: {event.get('message')}", file=sys.stderr)


# ── Main Loop ──

async def main():
    try:
        async with websockets.connect(args.server) as ws:

            # Auth
            await ws.send(json.dumps({"type": "auth", "token": args.token}))

            # Receive loop
            async def receiver():
                async for raw in ws:
                    event = json.loads(raw)
                    if event.get("type") == "ping":
                        await ws.send(json.dumps({"type": "pong"}))
                        continue
                    handle_event(event)

            recv_task = asyncio.create_task(receiver())

            # Wait for auth
            try:
                await asyncio.wait_for(authenticated.wait(), timeout=10)
            except asyncio.TimeoutError:
                print("❌ Auth timeout", file=sys.stderr)
                sys.exit(1)

            # ── One-shot send mode ──
            if args.send:
                if not current_room:
                    print("❌ No room available", file=sys.stderr)
                    sys.exit(1)
                await ws.send(json.dumps({
                    "type": "message",
                    "room": current_room,
                    "content": args.send,
                }))
                await asyncio.sleep(0.5)
                return

            # ── Pipe mode ──
            if args.pipe:
                loop = asyncio.get_event_loop()
                reader = asyncio.StreamReader()
                await loop.connect_read_pipe(
                    lambda: asyncio.StreamReaderProtocol(reader), sys.stdin
                )
                while True:
                    line = await reader.readline()
                    if not line:
                        break
                    text = line.decode().strip()
                    if text and current_room:
                        await ws.send(json.dumps({
                            "type": "message",
                            "room": current_room,
                            "content": text,
                        }))
                await asyncio.sleep(0.5)
                return

            # ── JSON mode (receive only) ──
            if args.json_mode:
                await recv_task
                return

            # ── Interactive mode ──
            loop = asyncio.get_event_loop()
            reader = asyncio.StreamReader()
            await loop.connect_read_pipe(
                lambda: asyncio.StreamReaderProtocol(reader), sys.stdin
            )

            try:
                while True:
                    sys.stdout.write("> ")
                    sys.stdout.flush()
                    line = await reader.readline()
                    if not line:
                        break
                    text = line.decode().strip()
                    if not text:
                        continue

                    # Commands
                    if text.startswith("/"):
                        parts = text.split(" ", 1)
                        cmd = parts[0]
                        arg = parts[1] if len(parts) > 1 else ""

                        if cmd in ("/quit", "/exit", "/q"):
                            break
                        elif cmd == "/rooms":
                            for i, r in enumerate(rooms):
                                marker = " ← current" if r["id"] == current_room else ""
                                print(f"  {i+1}. {r['name']}{marker}")
                        elif cmd == "/room":
                            if not arg:
                                print(f"Current: {current_room_name or 'none'}")
                            else:
                                match = next((r for r in rooms if arg.lower() in r["name"].lower()), None)
                                if match:
                                    globals()["current_room"] = match["id"]
                                    globals()["current_room_name"] = match["name"]
                                    print(f"📍 Switched to: {match['name']}")
                                else:
                                    print(f"⚠️ Room \"{arg}\" not found")
                        elif cmd == "/status":
                            print(f"Agent: {agent_emoji} {agent_name}")
                            print(f"Room: {current_room_name or 'none'}")
                            print(f"Server: {args.server}")
                        else:
                            print(f"Unknown command. Try /rooms, /room, /status, /quit")
                        continue

                    # Send message
                    if current_room:
                        await ws.send(json.dumps({
                            "type": "message",
                            "room": current_room,
                            "content": text,
                        }))
                    else:
                        print("⚠️ No room selected. Use /room <name>")

            except (EOFError, KeyboardInterrupt):
                pass

    except websockets.exceptions.ConnectionClosed:
        print("\n❌ Connection closed", file=sys.stderr)
    except ConnectionRefusedError:
        print(f"❌ Cannot connect to {args.server}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    signal.signal(signal.SIGINT, lambda *_: sys.exit(0))
    asyncio.run(main())
