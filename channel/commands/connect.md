---
description: Bind this session to a Triologue room so its messages reach this session
argument-hint: <room name or id>
---

Call the `connect_room` tool of the `triologue-channel` server with `room` set to `$ARGUMENTS`. Then tell the user, in one line, which room is now bound, that messages from it arrive here as channel events (instead of at every session of the agent), and that permission prompts can now be answered from that room.
