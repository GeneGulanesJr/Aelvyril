import { render, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthGate, useAppAuth, type AppAuth } from "./auth-gate.js";

// Control the module-level auth switch per test: the auth-gate reads these
// consts from lib/auth at render time (mocked here), so tests can exercise
// all three branches — dev identity, keyless signed-out fallback, Clerk.
const h = vi.hoisted(() => {
  return {
    switch: { AUTH_DISABLED: false, CLERK_CLIENT_USABLE: true },
    // Mutable Clerk useAuth() return — tests swap it wholesale and re-render
    // (plain objects aren't reactive, so mutation alone triggers nothing).
    clerk: {
      isLoaded: false,
      isSignedIn: false,
      userId: undefined as string | undefined,
      getToken: (): Promise<string | null> => Promise.resolve("tok"),
    },
  };
});

vi.mock("../lib/auth.js", () => ({
  // Getters, not snapshots: the factory runs once at first import, so plain
  // properties would freeze the initial values and per-test flips would be
  // invisible to the component.
  get AUTH_DISABLED() {
    return h.switch.AUTH_DISABLED;
  },
  get CLERK_CLIENT_USABLE() {
    return h.switch.CLERK_CLIENT_USABLE;
  },
  DEV_USER_ID: "dev-local",
}));

vi.mock("@clerk/nextjs", () => ({
  // ClerkProvider passthrough — the bridge underneath is what's under test.
  ClerkProvider: (props: { children?: React.ReactNode }) => props.children ?? null,
  useAuth: () => h.clerk,
}));

afterEach(() => {
  h.switch.AUTH_DISABLED = false;
  h.switch.CLERK_CLIENT_USABLE = true;
  h.clerk = {
    isLoaded: false,
    isSignedIn: false,
    userId: undefined,
    getToken: (): Promise<string | null> => Promise.resolve("tok"),
  };
});

describe("AuthGate", () => {
  it("Clerk mode: authResolved stays false while Clerk hydrates, then flips with the userId", async () => {
    const view = renderHook(() => useAppAuth(), {
      wrapper: ({ children }: { children?: React.ReactNode }) => <AuthGate>{children}</AuthGate>,
    });

    // Hydrating: no auth decision yet — consumers must show a loading state,
    // NOT the sign-in gate (a null userId here is not "signed out").
    expect(view.result.current.authResolved).toBe(false);
    expect(view.result.current.userId).toBeNull();

    // Clerk finishes hydrating with a signed-in user; re-render the hook.
    h.clerk = {
      isLoaded: true,
      isSignedIn: true,
      userId: "user_2abc",
      getToken: (): Promise<string | null> => Promise.resolve("tok"),
    };
    view.rerender();
    await waitFor(() => expect(view.result.current.authResolved).toBe(true));
    expect(view.result.current.userId).toBe("user_2abc");
    await expect(view.result.current.getToken()).resolves.toBe("tok");
  });

  it("Clerk mode: resolved + signed out keeps userId null (defensive gate is the terminal state)", async () => {
    h.clerk = {
      isLoaded: true,
      isSignedIn: false,
      userId: undefined,
      getToken: (): Promise<string | null> => Promise.resolve(null),
    };
    const { result } = renderHook(() => useAppAuth(), {
      wrapper: ({ children }: { children?: React.ReactNode }) => <AuthGate>{children}</AuthGate>,
    });
    await waitFor(() => expect(result.current.authResolved).toBe(true));
    expect(result.current.userId).toBeNull();
  });

  it("AUTH_DISABLED=1: fixed dev identity, resolved immediately (no Clerk mount)", () => {
    h.switch.AUTH_DISABLED = true;
    const { result } = renderHook(() => useAppAuth(), {
      wrapper: ({ children }: { children?: React.ReactNode }) => <AuthGate>{children}</AuthGate>,
    });
    expect(result.current).toMatchObject<Partial<AppAuth>>({ userId: "dev-local", authResolved: true });
  });

  it("keyless build (no/malformed pk): resolved immediately in the signed-out state", () => {
    h.switch.CLERK_CLIENT_USABLE = false;
    const { result } = renderHook(() => useAppAuth(), {
      wrapper: ({ children }: { children?: React.ReactNode }) => <AuthGate>{children}</AuthGate>,
    });
    expect(result.current).toMatchObject<Partial<AppAuth>>({ userId: null, authResolved: true });
  });

  it("renders children through every branch", () => {
    const flips: Array<() => void> = [
      () => (h.switch.AUTH_DISABLED = true),
      () => {
        h.switch.AUTH_DISABLED = false;
        h.switch.CLERK_CLIENT_USABLE = false;
      },
      () => (h.switch.CLERK_CLIENT_USABLE = true),
    ];
    for (const flip of flips) {
      flip();
      const view = render(
        <AuthGate>
          <p>app surface</p>
        </AuthGate>,
      );
      expect(view.getByText("app surface")).toBeTruthy();
      view.unmount();
    }
  });
});
