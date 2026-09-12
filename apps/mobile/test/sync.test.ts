import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const remove = vi.fn();
  const addEventListener = vi.fn((_event: string, _handler: (state: string) => void) => ({
    remove,
  }));
  return { remove, addEventListener };
});

vi.mock("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: mocks.addEventListener,
  },
}));

import { bindAppStateSync } from "../src/lib/sync-app-state";

describe("bindAppStateSync", () => {
  beforeEach(() => {
    mocks.remove.mockReset();
    mocks.addEventListener.mockClear();
  });

  it("does not subscribe or run when disabled", () => {
    const run = vi.fn();
    const cleanup = bindAppStateSync(run, false);

    expect(run).not.toHaveBeenCalled();
    expect(mocks.addEventListener).not.toHaveBeenCalled();
    cleanup();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("subscribes and runs immediately when enabled in active state", () => {
    const run = vi.fn();
    const cleanup = bindAppStateSync(run, true);

    expect(run).toHaveBeenCalledTimes(1);
    expect(mocks.addEventListener).toHaveBeenCalledTimes(1);

    const handler = mocks.addEventListener.mock.calls[0]?.[1] as
      | ((state: string) => void)
      | undefined;
    expect(handler).toBeTypeOf("function");
    handler?.("active");
    expect(run).toHaveBeenCalledTimes(2);

    cleanup();
    expect(mocks.remove).toHaveBeenCalledTimes(1);
  });
});
