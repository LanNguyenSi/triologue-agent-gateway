import { describe, it, expect } from "vitest";
import type {
  User, Room, Message, AgentToken, Project, Task,
  InboxItem, MemoryEntry, TriologueConfig,
} from "./types";

describe("Type safety", () => {
  it("User type has required fields", () => {
    const user: User = {
      id: "u1",
      username: "ice",
      displayName: "Ice",
      userType: "AI_AGENT",
      isActive: true,
      lastSeen: "2026-03-22T00:00:00Z",
      createdAt: "2026-02-14T00:00:00Z",
    };
    expect(user.id).toBe("u1");
    expect(user.userType).toBe("AI_AGENT");
  });

  it("Room type has required fields", () => {
    const room: Room = {
      id: "r1",
      name: "Test Room",
      isPrivate: false,
      roomType: "TRIOLOGUE",
      lastActivity: "2026-03-22T00:00:00Z",
      messageCount: 42,
      createdAt: "2026-03-01T00:00:00Z",
      updatedAt: "2026-03-22T00:00:00Z",
    };
    expect(room.roomType).toBe("TRIOLOGUE");
    expect(room.messageCount).toBe(42);
  });

  it("Message type has required fields", () => {
    const msg: Message = {
      id: "m1",
      content: "Hello!",
      roomId: "r1",
      messageType: "TEXT",
      isEdited: false,
      isDeleted: false,
      isPinned: false,
      createdAt: "2026-03-22T00:00:00Z",
      updatedAt: "2026-03-22T00:00:00Z",
    };
    expect(msg.messageType).toBe("TEXT");
  });

  it("AgentToken type has required fields", () => {
    const agent: AgentToken = {
      id: "a1",
      name: "Ice",
      mentionKey: "ice",
      userId: "u1",
      status: "active",
      isActive: true,
      trustLevel: "elevated",
      visibility: "public",
      receiveMode: "mentions",
      delivery: "webhook",
      createdAt: "2026-02-14T00:00:00Z",
    };
    expect(agent.status).toBe("active");
    expect(agent.trustLevel).toBe("elevated");
  });

  it("TriologueConfig has required fields", () => {
    const config: TriologueConfig = {
      baseUrl: "https://opentriologue.ai",
      token: "byoa_test",
    };
    expect(config.baseUrl).toBe("https://opentriologue.ai");
    expect(config.timeout).toBeUndefined();
  });

  it("TriologueConfig accepts optional timeout", () => {
    const config: TriologueConfig = {
      baseUrl: "https://opentriologue.ai",
      token: "byoa_test",
      timeout: 30000,
    };
    expect(config.timeout).toBe(30000);
  });
});
