// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Mock Clerk's hooks + components. The chat uses useAuth, useUser, UserButton;
// SignedIn/SignedOut aren't used in chat.tsx but kept here for completeness.
vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({
    getToken: vi.fn().mockResolvedValue("test-token"),
    userId: "user_test1",
  }),
  useUser: () => ({
    user: { firstName: "Test" },
    isLoaded: true,
    isSignedIn: true,
  }),
  UserButton: () => <div data-testid="user-button" />,
  SignedIn: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SignedOut: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SignInButton: () => <button />,
}));

// Mock the GatewayClient class — the chat only ever calls a few methods.
const mockClient = {
  listConversations: vi.fn(),
  createConversation: vi.fn(),
  renameConversation: vi.fn(),
  deleteConversation: vi.fn(),
  prompt: vi.fn(),
  abort: vi.fn(),
  openStream: vi.fn().mockReturnValue(() => {}),
};

vi.mock("../lib/api", () => ({
  GatewayClient: vi.fn().mockImplementation(() => mockClient),
}));

// Mock SseParser so the openStream implementation doesn't need a real stream.
vi.mock("../lib/sse", () => ({
  SseParser: vi.fn().mockImplementation(() => ({
    push: () => [],
    lastSeenSeq: -1,
  })),
}));

// Now safe to import the component.
import { Chat } from "./chat.js";

beforeEach(() => {
  vi.clearAllMocks();
  // Default: empty conversation list on mount.
  mockClient.listConversations.mockResolvedValue([]);
  mockClient.createConversation.mockResolvedValue({
    id: "conv_new",
    title: null,
    workspace: null,
    state: "idle",
    createdAt: "2026-09-22T12:00:00.000Z",
  });
  mockClient.renameConversation.mockImplementation(async (id, body) => ({
    id,
    title: body.title,
    workspace: null,
    state: "idle",
    createdAt: "2026-09-22T12:00:00.000Z",
  }));
  mockClient.deleteConversation.mockResolvedValue(undefined);
  mockClient.prompt.mockResolvedValue(undefined);
  mockClient.abort.mockResolvedValue(undefined);
  mockClient.openStream.mockReturnValue(() => {});
});

describe("Chat conversation list", () => {
  // Helper: the dropdown trigger is the <summary> inside <details>; the same
  // string appears on the "+ new conversation" button inside, so we filter by
  // element tag to avoid the multiple-match error.
  const findTrigger = () =>
    screen.getByText(
      "new conversation",
      { selector: "summary" } as never, // RTL accepts this; jsdom path differs
    );
  // Fallback for the version that ignores the selector option: query by tag.
  const findTriggerSafe = () => {
    try {
      return findTrigger();
    } catch {
      const all = screen.getAllByText("new conversation");
      return all.find((el) => el.tagName.toLowerCase() === "summary")!;
    }
  };
  const openDropdown = () => {
    fireEvent.click(findTriggerSafe());
  };

  it("renders the conversation dropdown trigger with 'new conversation' placeholder", async () => {
    render(<Chat />);
    await waitFor(() => {
      expect(findTriggerSafe()).toBeTruthy();
    });
    expect(screen.getByTestId("user-button")).toBeTruthy();
  });

  it("lists existing conversations from the client in the dropdown", async () => {
    mockClient.listConversations.mockResolvedValue([
      { id: "conv_1", title: "Fix login bug", workspace: null, state: "idle", createdAt: "2026-09-22T12:00:00.000Z" },
      { id: "conv_2", title: "Add search", workspace: null, state: "idle", createdAt: "2026-09-22T12:00:00.000Z" },
    ]);
    render(<Chat />);
    openDropdown();
    expect((await screen.findByText("Fix login bug"))).toBeTruthy();
    expect((await screen.findByText("Add search"))).toBeTruthy();
  });

  // Search-filter wiring is covered by filter-conversations.test.ts (the
  // pure function). Skipping a UI integration test for it here because
  // React 19 StrictMode renders the search input twice in the jsdom test
  // env, and targeting the "real" instance vs the StrictMode duplicate
  // depends on internal React 19 behavior that's not stable enough to
  // assert on. If you want a UI integration test later, scope by the
  // details panel's role=group (when refactored to use role="group" or
  // a custom landmark).
  it.skip("filters the conversation list via the search input (covered by filter-conversations.test.ts)", () => {});

  it("renames a conversation: click ✎, type, Enter → calls renameConversation", async () => {
    mockClient.listConversations.mockResolvedValue([
      { id: "conv_1", title: "Old title", workspace: null, state: "idle", createdAt: "2026-09-22T12:00:00.000Z" },
    ]);
    render(<Chat />);
    openDropdown();
    const renameBtn = await screen.findByLabelText(/rename old title/i);
    fireEvent.click(renameBtn);
    const input = await screen.findByDisplayValue("Old title");
    await userEvent.clear(input);
    await userEvent.type(input, "New title{Enter}");
    await waitFor(() => {
      expect(mockClient.renameConversation).toHaveBeenCalledWith("conv_1", { title: "New title" });
    });
  });

  it("deletes a conversation: click ×, then yes → calls deleteConversation", async () => {
    mockClient.listConversations.mockResolvedValue([
      { id: "conv_1", title: "Goodbye", workspace: null, state: "idle", createdAt: "2026-09-22T12:00:00.000Z" },
    ]);
    render(<Chat />);
    openDropdown();
    const deleteBtn = await screen.findByLabelText(/delete goodbye/i);
    fireEvent.click(deleteBtn);
    const yesBtn = await screen.findByRole("button", { name: "yes" });
    fireEvent.click(yesBtn);
    await waitFor(() => {
      expect(mockClient.deleteConversation).toHaveBeenCalledWith("conv_1");
    });
  });
});