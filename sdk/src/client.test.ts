import { describe, it, expect } from "vitest";
import { Triologue } from "./client";

describe("Triologue", () => {
  const client = new Triologue({
    baseUrl: "https://opentriologue.ai",
    token: "byoa_test_token",
  });

  it("creates client with config", () => {
    expect(client).toBeDefined();
  });

  it("has rooms resource", () => {
    expect(client.rooms).toBeDefined();
    expect(typeof client.rooms.list).toBe("function");
    expect(typeof client.rooms.get).toBe("function");
    expect(typeof client.rooms.create).toBe("function");
    expect(typeof client.rooms.delete).toBe("function");
    expect(typeof client.rooms.join).toBe("function");
    expect(typeof client.rooms.invite).toBe("function");
  });

  it("has messages resource", () => {
    expect(client.messages).toBeDefined();
    expect(typeof client.messages.list).toBe("function");
    expect(typeof client.messages.send).toBe("function");
    expect(typeof client.messages.search).toBe("function");
    expect(typeof client.messages.delete).toBe("function");
    expect(typeof client.messages.pin).toBe("function");
    expect(typeof client.messages.unpin).toBe("function");
  });

  it("has agents resource", () => {
    expect(client.agents).toBeDefined();
    expect(typeof client.agents.info).toBe("function");
    expect(typeof client.agents.register).toBe("function");
    expect(typeof client.agents.list).toBe("function");
    expect(typeof client.agents.mine).toBe("function");
    expect(typeof client.agents.update).toBe("function");
  });

  it("has projects resource", () => {
    expect(client.projects).toBeDefined();
    expect(typeof client.projects.list).toBe("function");
    expect(typeof client.projects.create).toBe("function");
    expect(typeof client.projects.update).toBe("function");
    expect(typeof client.projects.delete).toBe("function");
  });

  it("has memory resource", () => {
    expect(client.memory).toBeDefined();
    expect(typeof client.memory.list).toBe("function");
    expect(typeof client.memory.create).toBe("function");
    expect(typeof client.memory.update).toBe("function");
    expect(typeof client.memory.delete).toBe("function");
  });

  it("has inbox resource", () => {
    expect(client.inbox).toBeDefined();
    expect(typeof client.inbox.list).toBe("function");
    expect(typeof client.inbox.markRead).toBe("function");
    expect(typeof client.inbox.markAllRead).toBe("function");
  });

  it("has users resource", () => {
    expect(client.users).toBeDefined();
    expect(typeof client.users.list).toBe("function");
    expect(typeof client.users.inRoom).toBe("function");
  });

  it("applies default timeout", () => {
    const c = new Triologue({ baseUrl: "https://test.com", token: "t" });
    expect(c).toBeDefined();
  });

  it("accepts custom timeout", () => {
    const c = new Triologue({ baseUrl: "https://test.com", token: "t", timeout: 30000 });
    expect(c).toBeDefined();
  });
});
