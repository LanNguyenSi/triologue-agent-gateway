---
description: Bind this session to a Triologue room so its messages reach this session first
argument-hint: <room name or id>
---

Call the `connect_room` tool of the `triologue` channel with `room` set to `$ARGUMENTS`. Then tell the user, in one line, which room is now bound and that messages from it will arrive here as channel events.
