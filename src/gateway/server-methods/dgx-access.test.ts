import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveDgxAccess } from "./dgx-access.js";

describe("resolveDgxAccess", () => {
  it("selects WAN mode with ngrok + token headers when forced and configured", async () => {
    const env = {
      DGX_ENABLED: "1",
      DGX_HOST: "192.168.1.93",
      DGX_ACCESS_MODE: "wan",
      DGX_WAN_BASE_URL: "https://abc123.ngrok-free.dev/",
      DGX_WAN_TOKEN: "wan-token",
      DGX_ACCESS_CACHE_TTL_MS: "0",
    };

    const result = await resolveDgxAccess(env);
    expect(result.context?.mode).toBe("wan");
    expect(result.context?.wanBaseUrl).toBe("https://abc123.ngrok-free.dev");
    expect(result.context?.requestHeaders).toEqual({
      "ngrok-skip-browser-warning": "true",
      "X-OpenClaw-Token": "wan-token",
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

  it("loads WAN token from contract-adjacent secrets.env when env token is unresolved", async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), "dgx-access-"));
    const configDir = path.join(tempRoot, "config");
    const contractPath = path.join(configDir, "workspace.env");
    const secretsPath = path.join(configDir, "secrets.env");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(contractPath, 'DGX_WAN_TOKEN="${DGX_WAN_TOKEN:-}"\n', "utf8");
    writeFileSync(secretsPath, "DGX_WAN_TOKEN=wan-token-from-secrets\n", "utf8");

    const prevContract = process.env.OPENCLAW_CONTRACT;
    const prevToken = process.env.DGX_WAN_TOKEN;
    delete process.env.DGX_WAN_TOKEN;
    process.env.OPENCLAW_CONTRACT = contractPath;

    try {
      const env = {
        DGX_ENABLED: "1",
        DGX_HOST: "192.168.1.93",
        DGX_ACCESS_MODE: "wan",
        DGX_WAN_BASE_URL: "https://abc123.ngrok-free.dev/",
        DGX_WAN_TOKEN: "${DGX_WAN_TOKEN:-}",
        DGX_ACCESS_CACHE_TTL_MS: "0",
      };

      const result = await resolveDgxAccess(env);
      expect(result.context?.requestHeaders["X-OpenClaw-Token"]).toBe("wan-token-from-secrets");
    } finally {
      if (prevContract == null) {
        delete process.env.OPENCLAW_CONTRACT;
      } else {
        process.env.OPENCLAW_CONTRACT = prevContract;
      }
      if (prevToken == null) {
        delete process.env.DGX_WAN_TOKEN;
      } else {
        process.env.DGX_WAN_TOKEN = prevToken;
      }
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
