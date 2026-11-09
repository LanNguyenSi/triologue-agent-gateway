---
description: Bind this session to a Triologue room so its messages reach this session
argument-hint: <room name or id>
---

Call the `connect_room` tool of the `triologue-channel` server with `room` set to `$ARGUMENTS`. Then tell the user, in one line, which room is now bound, that its messages arrive here as channel events (a session receives only the rooms it is bound to), that this session now answers the room even if another session on this machine had bound it before (until this one disconnects it), and that permission prompts can now be answered from that room. If the session is in auto mode or acceptEdits mode, add that messages from the room can then run tools without any approval.
