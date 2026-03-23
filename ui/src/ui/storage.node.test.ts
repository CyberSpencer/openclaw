import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function createStorageMock(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  };
}

describe("loadSettings default gateway URL derivation", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("navigator", { language: "en-US" } as Navigator);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses configured base path and normalizes trailing slash", async () => {
    vi.stubGlobal("location", {
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/ignored/path",
    } as Location);
    vi.stubGlobal("window", { __OPENCLAW_CONTROL_UI_BASE_PATH__: " /openclaw/ " } as Window &
      typeof globalThis);

    const { loadSettings } = await import("./storage.ts");
    expect(loadSettings().gatewayUrl).toBe("wss://gateway.example:8443/openclaw");
  });

  it("infers base path from nested pathname when configured base path is not set", async () => {
    vi.stubGlobal("location", {
      protocol: "http:",
      host: "gateway.example:18789",
      pathname: "/apps/openclaw/chat",
    } as Location);
    vi.stubGlobal("window", {} as Window & typeof globalThis);

    const { loadSettings } = await import("./storage.ts");
    expect(loadSettings().gatewayUrl).toBe("ws://gateway.example:18789/apps/openclaw");
  });
});

describe("alignLoopbackGatewayUrlWithDocument", () => {
  it("rewrites 127.0.0.1 to localhost when the document uses localhost", async () => {
    const { alignLoopbackGatewayUrlWithDocument } = await import("./storage.ts");
    expect(
      alignLoopbackGatewayUrlWithDocument("ws://127.0.0.1:32555", "localhost:32555", "localhost"),
    ).toBe("ws://localhost:32555/");
  });

  it("rewrites localhost to 127.0.0.1 when the document uses 127.0.0.1", async () => {
    const { alignLoopbackGatewayUrlWithDocument } = await import("./storage.ts");
    expect(
      alignLoopbackGatewayUrlWithDocument("ws://localhost:32555", "127.0.0.1:32555", "127.0.0.1"),
    ).toBe("ws://127.0.0.1:32555/");
  });

  it("leaves non-loopback gateway URLs unchanged", async () => {
    const { alignLoopbackGatewayUrlWithDocument } = await import("./storage.ts");
    const url = "wss://gateway.example:8443/openclaw";
    expect(alignLoopbackGatewayUrlWithDocument(url, "localhost:32555", "localhost")).toBe(url);
  });

  it("leaves loopback URL unchanged when host already matches the document", async () => {
    const { alignLoopbackGatewayUrlWithDocument } = await import("./storage.ts");
    expect(
      alignLoopbackGatewayUrlWithDocument("ws://localhost:32555", "localhost:32555", "localhost"),
    ).toBe("ws://localhost:32555");
  });
});

describe("loadSettings loopback gateway URL alignment", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("navigator", { language: "en-US" } as Navigator);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("aligns persisted 127.0.0.1 URL to localhost when the page is localhost", async () => {
    vi.stubGlobal("location", {
      protocol: "http:",
      host: "localhost:32555",
      hostname: "localhost",
      pathname: "/chat",
    } as Location);
    vi.stubGlobal("window", {} as Window & typeof globalThis);

    const storage = createStorageMock();
    storage.setItem(
      "openclaw.control.settings.v1",
      JSON.stringify({ gatewayUrl: "ws://127.0.0.1:32555" }),
    );
    vi.stubGlobal("localStorage", storage);

    const { loadSettings } = await import("./storage.ts");
    expect(loadSettings().gatewayUrl).toBe("ws://localhost:32555/");
  });

  it("aligns gatewayUrl when saving settings", async () => {
    vi.stubGlobal("location", {
      protocol: "http:",
      host: "localhost:32555",
      hostname: "localhost",
      pathname: "/chat",
    } as Location);
    vi.stubGlobal("window", {} as Window & typeof globalThis);

    const storage = createStorageMock();
    vi.stubGlobal("localStorage", storage);

    const { saveSettings, loadSettings } = await import("./storage.ts");
    const base = loadSettings();
    saveSettings({ ...base, gatewayUrl: "ws://127.0.0.1:32555" });
    const parsed = JSON.parse(storage.getItem("openclaw.control.settings.v1") ?? "{}");
    expect(parsed.gatewayUrl).toMatch(/localhost:32555/);
    expect(parsed.gatewayUrl).not.toMatch(/127\\.0\\.0\\.1/);
  });
});
