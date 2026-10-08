import { cleanup, render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ThreadPage from "./page.js";

// Stable getToken identity — the page's useEffect depends on it; a new
// function per render would loop the effect forever (OOM in tests).
// The page consumes useAppAuth() (AuthGate context), so mock that module
// rather than Clerk: AuthGate becomes a passthrough with a signed-in dev
// identity.
vi.mock("../../../components/auth-gate.js", () => ({
  AuthGate: (props: { children?: React.ReactNode }) => props.children ?? null,
  useAppAuth: () => ({ getToken: h.mockGetToken, userId: "u1" }),
}));

// Hoisted shared state: mutable navigation params (to exercise both the
// /thread/:id and /thread/new renders) and a single GatewayClient instance
// mock so tests can assert call counts on its methods.
const h = vi.hoisted(() => {
  const mockGetToken = async () => "tok";
  const push = vi.fn();
  const nav = { params: { id: "t1" } };
  const client = {
    listThreads: vi.fn(),
    createThread: vi.fn(),
    prompt: vi.fn(),
    deleteThread: vi.fn(),
    renameConversation: vi.fn(),
    killAllThreads: vi.fn(),
  };
  // Mutable slice of the useThread mock — tests flip error to null so the
  // page-level actionError path (new-thread create failures) is reachable,
  // and grab the deps.onStatus callback to simulate live spec_status events.
  const hook = { error: null as string | null, onStatus: null as ((s: string) => void) | null };
  return { mockGetToken, push, nav, client, hook };
});

vi.mock("next/navigation", () => ({
  useParams: () => h.nav.params,
  useRouter: () => ({ push: h.push }),
}));

vi.mock("../../../lib/api.js", () => ({
  GatewayClient: vi.fn().mockImplementation(() => h.client),
}));

vi.mock("../../../lib/use-thread.js", async () => {
  const { useState } = await import("react");
  return {
    useThread: (_id: string | null, deps?: { onStatus?: (s: string) => void }) => {
      h.hook.onStatus = deps?.onStatus ?? null;
      // Error lives in real state so dismissal re-renders (the band's
      // precedence behavior is pinned against this hook seam).
      const [error, setError] = useState(h.hook.error);
      return {
        status: "draft", statusLive: false, questions: [], draft: null, plan: ["step1"], trace: [], timeline: [], diff: [],
        error, degraded: true, blocked: null, waiting: false, usage: null,
        ask: vi.fn(), submitAnswers: vi.fn(), editSpec: vi.fn(), approve: vi.fn(), abandon: vi.fn(), retry: vi.fn(),
        stop: vi.fn(), dismissError: () => setError(null),
      };
    },
  };
});

function threadRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id, title: null, workspace: null, state: "idle", createdAt: "2026-09-23T00:00:00.000Z",
    status: "draft", specDraft: null, specQuestions: [], specAnswers: {}, usage: null,
    ...overrides,
  };
}

describe("ThreadPage", () => {
  beforeEach(() => {
    h.nav.params.id = "t1";
    h.hook.error = null;
    h.hook.onStatus = null;
    h.push.mockClear();
    h.client.listThreads.mockReset().mockResolvedValue([threadRow("t1", { title: "add RBAC" })]);
    h.client.createThread.mockReset().mockResolvedValue(threadRow("t-new"));
    h.client.prompt.mockReset().mockResolvedValue(undefined);
    h.client.deleteThread.mockReset().mockResolvedValue(undefined);
    h.client.renameConversation.mockReset().mockResolvedValue(threadRow("t1"));
    h.client.killAllThreads.mockReset().mockResolvedValue({ abandoned: 0 });
  });

  afterEach(() => cleanup());

  it("renders sidebar + header + input + tabs", async () => {
    render(<ThreadPage />);
    expect(await screen.findByTestId("new-thread")).toBeTruthy();
    expect(screen.getByTestId("thread-input")).toBeTruthy();
    expect(screen.getByTestId("thread-title").textContent).toBe("add RBAC");
    expect(screen.getByTestId("tab-plan")).toBeTruthy();
  });

  it("status band shows one state: error outranks degraded until dismissed", async () => {
    h.hook.error = "boom";
    render(<ThreadPage />);
    await screen.findByTestId("new-thread");
    expect(screen.getByTestId("error-banner").textContent).toContain("boom");
    expect(screen.queryByTestId("degraded-banner")).toBeNull();
    fireEvent.click(screen.getByTestId("dismiss-error"));
    await waitFor(() => expect(screen.getByTestId("degraded-banner")).toBeTruthy());
    expect(screen.queryByTestId("error-banner")).toBeNull();
  });

  it("sidebar search filters the list", async () => {
    render(<ThreadPage />);
    await screen.findByTestId("new-thread");
    fireEvent.change(screen.getByTestId("thread-search"), { target: { value: "nomatch" } });
    expect(screen.queryByTestId("thread-t1")).toBeNull();
  });

  it("two-step delete removes the thread and routes to /thread/new", async () => {
    render(<ThreadPage />);
    await screen.findByTestId("new-thread");
    fireEvent.click(screen.getByTestId("delete-button"));
    fireEvent.click(screen.getByTestId("delete-button"));
    await waitFor(() => expect(h.push).toHaveBeenCalledWith("/thread/new"));
  });

  it("sidebar selection routes to the thread", async () => {
    render(<ThreadPage />);
    await screen.findByTestId("new-thread");
    screen.getByTestId("new-thread").click();
    expect(h.push).toHaveBeenCalledWith("/thread/new");
  });

  it("new-thread create is guarded against double-submit; upserts + routes on success", async () => {
    h.nav.params.id = "new";
    // Hang the create so both clicks land while the first is in flight.
    let resolveCreate!: (t: unknown) => void;
    h.client.createThread.mockImplementationOnce(
      () => new Promise((r) => { resolveCreate = r; }),
    );
    render(<ThreadPage />);
    const input = await screen.findByTestId("thread-input");
    fireEvent.change(input, { target: { value: "hello world" } });
    fireEvent.click(screen.getByTestId("ask-button"));
    fireEvent.click(screen.getByTestId("ask-button"));
    resolveCreate(threadRow("t-new"));
    await waitFor(() => expect(h.push).toHaveBeenCalledWith("/thread/t-new"));
    expect(h.client.createThread).toHaveBeenCalledTimes(1);
    expect(h.client.prompt).toHaveBeenCalledTimes(1);
    expect(h.client.prompt).toHaveBeenCalledWith("t-new", { message: "hello world", specMode: "auto" });
    // The new thread joined the sidebar list before routing.
    expect(await screen.findByTestId("thread-t-new")).toBeTruthy();
  });

  it("a failed new-thread create surfaces the error banner and keeps the input", async () => {
    h.nav.params.id = "new";
    h.client.createThread.mockRejectedValueOnce(new Error("create thread failed: 500"));
    render(<ThreadPage />);
    const input = await screen.findByTestId("thread-input");
    fireEvent.change(input, { target: { value: "precious message" } });
    fireEvent.click(screen.getByTestId("ask-button"));
    const banner = await screen.findByTestId("error-banner");
    expect(banner.textContent).toContain("create thread failed: 500");
    expect((screen.getByTestId("thread-input") as HTMLTextAreaElement).value).toBe("precious message");
    expect(h.push).not.toHaveBeenCalled();
  });

  it("kill-all refetches the thread list from the server (#84 source of truth)", async () => {
    render(<ThreadPage />);
    await screen.findByTestId("new-thread");
    h.client.killAllThreads.mockResolvedValueOnce({ abandoned: 2 });
    h.client.listThreads.mockClear();
    h.client.listThreads.mockResolvedValueOnce([threadRow("t1", { status: "abandoned", state: "idle" })]);
    fireEvent.click(screen.getByTestId("kill-all-button")); // arm
    fireEvent.click(screen.getByTestId("kill-all-button")); // confirm
    await waitFor(() => expect(h.client.killAllThreads).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(h.client.listThreads).toHaveBeenCalledTimes(1));
    // The refetched snapshot wins — no client-side status flipping.
    await waitFor(() =>
      expect(screen.getByTestId("thread-t1").textContent).toContain("abandoned"),
    );
  });

  it("a failed listThreads load surfaces the error banner", async () => {
    h.client.listThreads.mockRejectedValueOnce(new Error("list threads failed: 503"));
    render(<ThreadPage />);
    const banner = await screen.findByTestId("error-banner");
    expect(banner.textContent).toContain("list threads failed: 503");
  });

  it("a failed kill-all surfaces the error banner and keeps the list", async () => {
    render(<ThreadPage />);
    await screen.findByTestId("new-thread");
    h.client.killAllThreads.mockRejectedValueOnce(new Error("kill-all failed: 500"));
    fireEvent.click(screen.getByTestId("kill-all-button")); // arm
    fireEvent.click(screen.getByTestId("kill-all-button")); // confirm
    const banner = await screen.findByTestId("error-banner");
    expect(banner.textContent).toContain("kill-all failed: 500");
    expect(screen.getByTestId("thread-t1")).toBeTruthy();
  });

  it("a failed delete surfaces the error banner, keeps the thread and stays put", async () => {
    render(<ThreadPage />);
    await screen.findByTestId("new-thread");
    h.client.deleteThread.mockRejectedValueOnce(new Error("delete failed: 409"));
    fireEvent.click(screen.getByTestId("delete-button"));
    fireEvent.click(screen.getByTestId("delete-button"));
    const banner = await screen.findByTestId("error-banner");
    expect(banner.textContent).toContain("delete failed: 409");
    expect(screen.getByTestId("thread-t1")).toBeTruthy();
    expect(h.push).not.toHaveBeenCalled();
  });

  it("live spec_status updates the ACTIVE thread's sidebar pill (#83)", async () => {
    render(<ThreadPage />);
    await screen.findByTestId("new-thread");
    expect(screen.getByTestId("thread-t1").textContent).toContain("draft");
    expect(h.hook.onStatus).toBeTruthy();
    await act(async () => {
      h.hook.onStatus!("running");
    });
    await waitFor(() =>
      expect(screen.getByTestId("thread-t1").textContent).toContain("running"),
    );
    // Other list entries are untouched by the live merge.
    expect(screen.getByTestId("thread-t1").textContent).not.toContain("draft");
  });
});
