import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayClient } from "./api.js";
import type { Conversation, RenameConversationBody } from "@aelvyril/shared";

function makeClient(): { client: GatewayClient; getToken: () => Promise<string | null> } {
  const getToken = vi.fn().mockResolvedValue("test-token");
  return { client: new GatewayClient("http://example.test", getToken), getToken };
}

function mockFetchSequence(responses: Array<{ ok: boolean; status?: number; body?: unknown }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let i = 0;
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = responses[i++] ?? { ok: true, status: 204, body: undefined };
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status: r.status ?? (r.ok ? 200 : 500),
    });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return { calls, fetchMock };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GatewayClient", () => {
  it("renameConversation issues PATCH with the title body and bearer", async () => {
    const { client } = makeClient();
    const { calls } = mockFetchSequence([
      { ok: true, body: { id: "conv_1", title: "New title", workspace: null, state: "idle", createdAt: "2026-09-22T12:00:00.000Z" } },
    ]);
    const body: RenameConversationBody = { title: "New title" };
    const result = await client.renameConversation("conv_1", body);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://example.test/v1/conversations/conv_1");
    expect(calls[0]!.init?.method).toBe("PATCH");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual(body);
    expect((calls[0]!.init?.headers as Record<string, string>).authorization).toBe("Bearer test-token");
    expect((result as Conversation).title).toBe("New title");
  });

  it("renameConversation throws on non-2xx with the status code", async () => {
    const { client } = makeClient();
    mockFetchSequence([{ ok: false, status: 404, body: { error: "not_found" } }]);
    await expect(client.renameConversation("conv_x", { title: "x" })).rejects.toThrow(/rename failed: 404/);
  });

  it("deleteConversation issues DELETE and returns void on success", async () => {
    const { client } = makeClient();
    const { calls } = mockFetchSequence([{ ok: true, status: 204 }]);
    await client.deleteConversation("conv_1");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://example.test/v1/conversations/conv_1");
    expect(calls[0]!.init?.method).toBe("DELETE");
    expect((calls[0]!.init?.headers as Record<string, string>).authorization).toBe("Bearer test-token");
  });

  it("deleteConversation throws on non-2xx with the status code", async () => {
    const { client } = makeClient();
    mockFetchSequence([{ ok: false, status: 404, body: { error: "not_found" } }]);
    await expect(client.deleteConversation("conv_x")).rejects.toThrow(/delete failed: 404/);
  });

  it("getUpdateStatus fetches + parses the update payload", async () => {
    const { client } = makeClient();
    mockFetchSequence([
      {
        ok: true,
        body: {
          currentSha: "8213db5c1094755be13e3a2ba9b1b870caad1182",
          currentShort: "8213db5",
          remoteSha: "abcdef0000000000000000000000000000000000",
          remoteShort: "abcdef0",
          behind: 2,
          fetchedAt: "2026-09-24T00:00:00.000Z",
          repoPath: "/home/me/Aelvyril",
        },
      },
    ]);
    const status = await client.getUpdateStatus();
    expect(status.behind).toBe(2);
    expect(status.currentShort).toBe("8213db5");
    expect(status.remoteShort).toBe("abcdef0");
    expect(status.repoPath).toBe("/home/me/Aelvyril");
  });

  it("applyUpdate POSTs to /v1/admin/update and returns the started shape", async () => {
    const { client } = makeClient();
    const { fetchMock } = mockFetchSequence([
      { ok: true, status: 202, body: { started: true, message: "queued" } },
    ]);
    const result = await client.applyUpdate();
    expect(result.started).toBe(true);
    expect(result.message).toBe("queued");
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe("http://example.test/v1/admin/update");
    expect((call[1] as RequestInit | undefined)?.method).toBe("POST");
  });

  it("applyUpdate throws on non-2xx with the status code", async () => {
    const { client } = makeClient();
    mockFetchSequence([{ ok: false, status: 400, body: { error: "update_failed" } }]);
    await expect(client.applyUpdate()).rejects.toThrow(/update apply failed: 400/);
  });
});

describe("thread client methods", () => {
  it("createThread POSTs to /v1/threads", async () => {
    const { client } = makeClient();
    const { fetchMock } = mockFetchSequence([
      { ok: true, body: { id: "t1", status: "draft" } },
    ]);
    const t = await client.createThread();
    expect(t.id).toBe("t1");
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe("http://example.test/v1/threads");
    expect((call[1] as RequestInit).method).toBe("POST");
  });

  it("listThreads GETs /v1/threads and maps the conversations wire key", async () => {
    const { client } = makeClient();
    const { fetchMock } = mockFetchSequence([
      { ok: true, body: { conversations: [{ id: "t1" }] } },
    ]);
    const out = await client.listThreads();
    expect(out).toEqual([{ id: "t1" }]);
    expect(fetchMock.mock.calls[0]![0]).toBe("http://example.test/v1/threads");
  });

  it("patchSpec answer PATCHes with kind=answer", async () => {
    const { client } = makeClient();
    const { fetchMock } = mockFetchSequence([{ ok: true, body: { ok: true } }]);
    await client.patchSpec("t1", { kind: "answer", answers: { q1: "admin" } });
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe("http://example.test/v1/threads/t1/spec");
    expect((call[1] as RequestInit).method).toBe("PATCH");
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({
      kind: "answer",
      answers: { q1: "admin" },
    });
  });

  it("approveSpec/abandonThread/retryThread POST to lifecycle routes", async () => {
    const { client } = makeClient();
    const { fetchMock } = mockFetchSequence([
      { ok: true, body: { ok: true } },
      { ok: true, body: { ok: true } },
      { ok: true, body: { ok: true } },
    ]);
    await client.approveSpec("t1");
    await client.abandonThread("t1");
    await client.retryThread("t1");
    const urls = fetchMock.mock.calls.map((c) => c[0]);
    expect(urls).toEqual([
      "http://example.test/v1/threads/t1/approve",
      "http://example.test/v1/threads/t1/abandon",
      "http://example.test/v1/threads/t1/retry",
    ]);
  });

  it("patchSpec throws on non-2xx with the status code", async () => {
    const { client } = makeClient();
    mockFetchSequence([{ ok: false, status: 400, body: { error: "invalid_body" } }]);
    await expect(
      client.patchSpec("t1", { kind: "answer" } as never),
    ).rejects.toThrow(/patch spec failed: 400/);
  });

  it("abortThread/deleteThread hit the canonical thread routes", async () => {
    const { client } = makeClient();
    const { fetchMock } = mockFetchSequence([
      { ok: true, status: 202, body: { accepted: true } },
      { ok: true, status: 204 },
    ]);
    await client.abortThread("t1");
    await client.deleteThread("t1");
    const urls = fetchMock.mock.calls.map((c) => c[0]);
    expect(urls).toEqual([
      "http://example.test/v1/threads/t1/abort",
      "http://example.test/v1/threads/t1",
    ]);
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe("POST");
    expect((fetchMock.mock.calls[1]![1] as RequestInit).method).toBe("DELETE");
  });
});