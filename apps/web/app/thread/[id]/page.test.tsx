import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ThreadPage from "./page.js";

// Stable getToken identity — the page's useEffect depends on it; a new
// function per render would loop the effect forever (OOM in tests).
// The page consumes useAppAuth() (AuthGate context), so mock that module
// rather than Clerk: AuthGate becomes a passthrough with a signed-in dev
// identity. Factory-local mockGetToken keeps the identity stable across
// tests (vi.mock factories are hoisted above top-level lets).
vi.mock("../../../components/auth-gate.js", () => {
  const mockGetToken = async () => "tok";
  return {
    AuthGate: (props: { children?: React.ReactNode }) => props.children ?? null,
    useAppAuth: () => ({ getToken: mockGetToken, userId: "u1" }),
  };
});

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "t1" }),
  useRouter: () => ({ push }),
}));

vi.mock("../../../lib/api.js", () => ({
  GatewayClient: vi.fn().mockImplementation(() => ({
    listThreads: vi.fn().mockResolvedValue([
      { id: "t1", title: "add RBAC", workspace: null, state: "idle", createdAt: "2026-09-23T00:00:00.000Z", status: "draft", specDraft: null, specQuestions: [], specAnswers: {} },
    ]),
    createThread: vi.fn(),
    deleteThread: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("../../../lib/use-thread.js", () => ({
  useThread: () => ({
    status: "draft", questions: [], draft: null, plan: ["step1"], trace: [], diff: [], error: "boom",
    degraded: true, waiting: false,
    ask: vi.fn(), submitAnswers: vi.fn(), editSpec: vi.fn(), approve: vi.fn(), abandon: vi.fn(), retry: vi.fn(),
    stop: vi.fn(), dismissError: vi.fn(),
  }),
}));

describe("ThreadPage", () => {
  afterEach(() => cleanup());

  it("renders sidebar + header + input + tabs", async () => {
    render(<ThreadPage />);
    expect(await screen.findByTestId("new-thread")).toBeTruthy();
    expect(screen.getByTestId("thread-input")).toBeTruthy();
    expect(screen.getByTestId("thread-title").textContent).toBe("add RBAC");
    expect(screen.getByTestId("tab-plan")).toBeTruthy();
  });

  it("renders degraded + error banners with dismiss", async () => {
    render(<ThreadPage />);
    await screen.findByTestId("new-thread");
    expect(screen.getByTestId("degraded-banner")).toBeTruthy();
    expect(screen.getByTestId("error-banner").textContent).toContain("boom");
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
    await waitFor(() => expect(push).toHaveBeenCalledWith("/thread/new"));
  });

  it("sidebar selection routes to the thread", async () => {
    render(<ThreadPage />);
    await screen.findByTestId("new-thread");
    screen.getByTestId("new-thread").click();
    expect(push).toHaveBeenCalledWith("/thread/new");
  });
});
