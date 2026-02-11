import { describe, expect, it, vi } from "vitest";
import { resolveDgxAccess } from "./dgx-access.js";

describe("resolveDgxAccess", () => {
  it("selects WAN mode with ngrok header when forced and configured", async () => {
    const env = {
      DGX_ENABLED: "1",
      DGX_HOST: "192.168.1.93",
      DGX_ACCESS_MODE: "wan",
      DGX_WAN_BASE_URL: "https://abc123.ngrok-free.dev/",
      DGX_ACCESS_CACHE_TTL_MS: "0",
    };

    const result = await resolveDgxAccess(env);
    expect(result.context?.mode).toBe("wan");
    expect(result.context?.wanBaseUrl).toBe("https://abc123.ngrok-free.dev");
    expect(result.context?.requestHeaders).toEqual({
      "ngrok-skip-browser-warning": "true",
    });
  });

  it("selects LAN mode in auto when LAN probe succeeds", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
    const env = {
      DGX_ENABLED: "1",
      DGX_HOST: "192.168.1.93",
      DGX_ACCESS_MODE: "auto",
      DGX_WAN_BASE_URL: "https://abc123.ngrok-free.dev",
      DGX_ACCESS_CACHE_TTL_MS: "0",
    };

    const result = await resolveDgxAccess(env, fetchMock as unknown as typeof fetch);
    expect(result.context?.mode).toBe("lan");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to WAN in auto when LAN probe fails", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("connect timeout");
    });
    const env = {
      DGX_ENABLED: "1",
      DGX_HOST: "192.168.1.93",
      DGX_ACCESS_MODE: "auto",
      DGX_WAN_BASE_URL: "https://abc123.ngrok-free.dev",
      DGX_ACCESS_CACHE_TTL_MS: "0",
    };

    const result = await resolveDgxAccess(env, fetchMock as unknown as typeof fetch);
    expect(result.context?.mode).toBe("wan");
    expect(result.context?.wanBaseUrl).toBe("https://abc123.ngrok-free.dev");
  });

  it("returns an error when WAN mode is forced without WAN base URL", async () => {
    const env = {
      DGX_ENABLED: "1",
      DGX_HOST: "192.168.1.93",
      DGX_ACCESS_MODE: "wan",
      DGX_ACCESS_CACHE_TTL_MS: "0",
    };

    const result = await resolveDgxAccess(env);
    expect(result.context).toBeNull();
    expect(result.error).toContain("DGX_ACCESS_MODE=wan");
  });
});
