import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayBrowserClient } from "./gateway.ts";

type Listener = (event: unknown) => void;

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  private listeners = new Map<string, Listener[]>();

  constructor(_url: string) {
    MockWebSocket.instances.push(this);
  }

  static reset() {
    MockWebSocket.instances = [];
  }

  addEventListener(type: string, listener: Listener) {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  send(data: string) {
    this.sent.push(String(data));
  }

  close(code = 1000, reason = "") {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close", { code, reason });
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.emit("open", {});
  }

  receive(frame: unknown) {
    this.emit("message", { data: JSON.stringify(frame) });
  }

  serverClose(code: number, reason: string) {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close", { code, reason });
  }

  private emit(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

describe("GatewayBrowserClient auth reconnect policy", () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");

  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.reset();
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          store.set(key, value);
        },
        removeItem: (key: string) => {
          store.delete(key);
        },
        clear: () => {
          store.clear();
        },
      },
    });
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: undefined,
    });
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
    if (originalLocalStorage) {
      Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
    } else {
      // @ts-expect-error configurable test-only global cleanup
      delete globalThis.localStorage;
    }
    if (originalCrypto) {
      Object.defineProperty(globalThis, "crypto", originalCrypto);
    } else {
      // @ts-expect-error configurable test-only global cleanup
      delete globalThis.crypto;
    }
    vi.useRealTimers();
  });

  it("treats unauthorized connect failures as terminal and preserves reason text", async () => {
    const onClose = vi.fn();
    const client = new GatewayBrowserClient({
      url: "ws://gateway.local",
      onClose,
    });

    client.start();
    const ws = MockWebSocket.instances[0];
    expect(ws).toBeDefined();
    ws?.open();
    await vi.advanceTimersByTimeAsync(750);

    const connectReq = JSON.parse(ws?.sent[0] ?? "{}") as { id?: string };
    expect(typeof connectReq.id).toBe("string");
    const closeSpy = vi.spyOn(ws, "close");
    ws?.receive({
      type: "res",
      id: connectReq.id,
      ok: false,
      error: {
        code: "unauthorized",
        message: "unauthorized: gateway token mismatch for control-ui",
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1);

    expect(closeSpy).toHaveBeenCalledWith(
      4008,
      "unauthorized: gateway token mismatch for control-ui",
    );
    expect(onClose).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(20_000);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("keeps reconnect behavior for non-auth connect failures", async () => {
    const client = new GatewayBrowserClient({
      url: "ws://gateway.local",
    });

    client.start();
    const ws = MockWebSocket.instances[0];
    expect(ws).toBeDefined();
    ws?.open();
    await vi.advanceTimersByTimeAsync(750);

    const connectReq = JSON.parse(ws?.sent[0] ?? "{}") as { id?: string };
    expect(typeof connectReq.id).toBe("string");
    const closeSpy = vi.spyOn(ws, "close");
    ws?.receive({
      type: "res",
      id: connectReq.id,
      ok: false,
      error: {
        code: "timeout",
        message: "connect timeout",
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1);
    expect(closeSpy).toHaveBeenCalledWith(4008, "connect timeout");
    await vi.advanceTimersByTimeAsync(900);

    expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2);
  });

  it("does not reconnect after server policy close with unauthorized reason", async () => {
    const client = new GatewayBrowserClient({
      url: "ws://gateway.local",
    });

    client.start();
    const ws = MockWebSocket.instances[0];
    ws?.open();
    ws?.serverClose(1008, "unauthorized: gateway token mismatch");
    await vi.advanceTimersByTimeAsync(20_000);

    expect(MockWebSocket.instances).toHaveLength(1);
  });
});
