import { afterEach, describe, it, expect, vi } from "vitest";
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

// ── HttpClient.request transport internals ─────────────────────────────────
//
// The tests above only exercise the constructor; every resources/*.test.ts
// mocks HttpClient itself away, so the fetch/AbortController/timeout/error-
// mapping logic inside `request()` had no direct coverage. These tests stub
// global fetch and drive it directly.

describe("HttpClient.request (transport)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("sends Authorization/Accept headers and JSON-stringifies the body on POST", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "1" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpClient({ baseUrl: "https://api.test.com", token: "secret-token", timeout: 5000 });

    const result = await client.post("/rooms", { name: "General" });

    expect(result).toEqual({ id: "1" });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.test.com/rooms");
    expect(opts.method).toBe("POST");
    expect(opts.headers.Authorization).toBe("Bearer secret-token");
    expect(opts.headers.Accept).toBe("application/json");
    expect(opts.headers["Content-Type"]).toBe("application/json");
    expect(opts.body).toBe(JSON.stringify({ name: "General" }));
  });

  it("routes put()/patch() through request() with the correct HTTP method", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpClient({ baseUrl: "https://api.test.com", token: "t", timeout: 5000 });

    await client.put("/things/1", { name: "updated" });
    await client.patch("/things/1", { name: "patched" });

    expect(fetchMock.mock.calls[0][1].method).toBe("PUT");
    expect(fetchMock.mock.calls[1][1].method).toBe("PATCH");
  });

  it("omits Content-Type and body on a bodyless GET, and strips a trailing slash from baseUrl", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [],
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpClient({ baseUrl: "https://api.test.com/", token: "t", timeout: 5000 });

    await client.get("/rooms");

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.test.com/rooms");
    expect(opts.headers["Content-Type"]).toBeUndefined();
    expect(opts.body).toBeUndefined();
  });

  it("returns undefined for a 204 No Content response without calling response.json()", async () => {
    const jsonSpy = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204, json: jsonSpy });
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpClient({ baseUrl: "https://api.test.com", token: "t", timeout: 5000 });

    const result = await client.delete("/things/1");

    expect(result).toBeUndefined();
    expect(jsonSpy).not.toHaveBeenCalled();
  });

  it("throws TriologueHttpError with the parsed body on a non-2xx response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: "not found", message: "Room not found" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpClient({ baseUrl: "https://api.test.com", token: "t", timeout: 5000 });

    await expect(client.get("/missing")).rejects.toMatchObject({
      statusCode: 404,
      body: { error: "not found", message: "Room not found" },
    });
  });

  it("falls back to a generic { error: 'HTTP <status>' } body when a non-2xx response isn't valid JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error("not json");
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpClient({ baseUrl: "https://api.test.com", token: "t", timeout: 5000 });

    await expect(client.get("/broken")).rejects.toMatchObject({
      statusCode: 500,
      body: { error: "HTTP 500" },
    });
  });

  it("passes an AbortSignal to fetch that is not aborted on a normal response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpClient({ baseUrl: "https://api.test.com", token: "t", timeout: 5000 });

    await client.get("/thing");

    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    expect(opts.signal.aborted).toBe(false);
  });

  it("aborts the request once `timeout` ms elapse with no response", async () => {
    vi.useFakeTimers();
    let capturedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_url: string, opts: { signal: AbortSignal }) => {
      capturedSignal = opts.signal;
      return new Promise((_resolve, reject) => {
        opts.signal.addEventListener("abort", () => {
          const err = new Error("This operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpClient({ baseUrl: "https://api.test.com", token: "t", timeout: 50 });

    const promise = client.get("/slow");
    const assertion = expect(promise).rejects.toThrow("This operation was aborted");
    // MUTATION GUARD: drop the `setTimeout(() => controller.abort(), this.timeout)`
    // call → the signal never aborts and this timer advance has nothing to
    // fire, so the request hangs instead of rejecting; fails.
    await vi.advanceTimersByTimeAsync(50);
    await assertion;

    expect(capturedSignal?.aborted).toBe(true);
  });

  it("clears the timeout timer once the response resolves, so it can never abort after the fact", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpClient({ baseUrl: "https://api.test.com", token: "t", timeout: 50 });

    const result = await client.get("/fast");
    expect(result).toEqual({ ok: true });

    const [, opts] = fetchMock.mock.calls[0];
    // MUTATION GUARD: drop `clearTimeout(timer)` from the finally block →
    // the abort timer set at request start is still armed here and this
    // advance flips `aborted` to true even though the request already
    // resolved; fails.
    await vi.advanceTimersByTimeAsync(1000);
    expect(opts.signal.aborted).toBe(false);
  });
});
