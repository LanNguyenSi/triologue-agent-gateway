import { describe, it, expect, vi } from "vitest";
import { HttpClient, TriologueHttpError } from "./http";

describe("HttpClient", () => {
  const config = { baseUrl: "https://api.test.com", token: "test-token", timeout: 5000 };

  it("constructs with config", () => {
    const client = new HttpClient(config);
    expect(client).toBeDefined();
  });

  it("strips trailing slash from baseUrl", () => {
    const client = new HttpClient({ ...config, baseUrl: "https://api.test.com/" });
    expect(client).toBeDefined();
  });
});

describe("TriologueHttpError", () => {
  it("creates with statusCode and body", () => {
    const error = new TriologueHttpError(404, { error: "Not found" });
    expect(error.statusCode).toBe(404);
    expect(error.body.error).toBe("Not found");
    expect(error.message).toBe("Not found");
    expect(error.name).toBe("TriologueHttpError");
  });

  it("uses message field as fallback", () => {
    const error = new TriologueHttpError(500, { error: "", message: "Server error" });
    expect(error.message).toBe("Server error");
  });

  it("falls back to HTTP status", () => {
    const error = new TriologueHttpError(503, { error: "" });
    expect(error.message).toBe("HTTP 503");
  });

  it("is an instance of Error", () => {
    const error = new TriologueHttpError(400, { error: "Bad request" });
    expect(error).toBeInstanceOf(Error);
  });
});
