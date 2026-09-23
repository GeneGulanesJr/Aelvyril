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
});