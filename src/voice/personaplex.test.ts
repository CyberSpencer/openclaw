import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePersonaPlexConfig, selectPersonaPlexEndpoint } from "./personaplex.js";

async function createPersonaPlexInstallRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-personaplex-test-"));
  await fs.mkdir(path.join(root, "moshi"), { recursive: true });
  await fs.writeFile(path.join(root, "moshi", "pyproject.toml"), "[build-system]\n");
  await fs.mkdir(path.join(root, ".venv", "bin"), { recursive: true });
  await fs.writeFile(path.join(root, ".venv", "bin", "python"), "#!/bin/sh\nexit 0\n");
  return root;
}

describe("personaplex endpoint failover", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (!dir) {
        continue;
      }
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("fails over from DGX endpoint to local server endpoint when primary is unhealthy", async () => {
    vi.spyOn(http, "request").mockImplementation(((options: http.RequestOptions, callback) => {
      const req = new EventEmitter() as unknown as http.ClientRequest;
      const port = Number(options.port ?? 0);
      const status = port === 19002 ? 200 : 503;
      const res = new EventEmitter() as unknown as http.IncomingMessage;
      (res as unknown as { statusCode?: number }).statusCode = status;
      (res as unknown as { setEncoding?: (encoding: BufferEncoding) => void }).setEncoding = () =>
        undefined;
      (req as unknown as { write: (chunk: string) => void }).write = () => undefined;
      (req as unknown as { setTimeout: (timeout: number) => void }).setTimeout = () => undefined;
      (req as unknown as { destroy: (error?: Error) => void }).destroy = (error?: Error) => {
        if (error) {
          queueMicrotask(() => {
            (req as unknown as EventEmitter).emit("error", error);
          });
        }
      };
      (req as unknown as { end: () => void }).end = () => {
        queueMicrotask(() => {
          callback?.(res);
          (res as unknown as EventEmitter).emit("data", "ok");
          (res as unknown as EventEmitter).emit("end");
        });
      };
      return req;
    }) as typeof http.request);

    const installPath = await createPersonaPlexInstallRoot();
    dirs.push(installPath);

    const config = resolvePersonaPlexConfig({
      enabled: true,
      installPath,
      transport: "server",
      useSsl: false,
      host: "127.0.0.1",
      port: 8998,
      endpoints: [
        {
          host: "127.0.0.1",
          port: 19001,
          useSsl: false,
          transport: "server",
          priority: 0,
          healthPath: "/healthz",
          healthTimeoutMs: 100,
          healthCacheTtlMs: 0,
        },
        {
          host: "127.0.0.1",
          port: 19002,
          useSsl: false,
          transport: "server",
          priority: 10,
          healthPath: "/healthz",
          healthTimeoutMs: 500,
          healthCacheTtlMs: 0,
        },
      ],
    });

    const selected = await selectPersonaPlexEndpoint(config);
    expect(selected).not.toBeNull();
    expect(selected?.transport).toBe("server");
    expect(selected?.config.host).toBe("127.0.0.1");
    expect(selected?.config.port).toBe(19002);
  });

  it("falls back to local offline PersonaPlex when DGX server endpoints are unavailable", async () => {
    const installPath = await createPersonaPlexInstallRoot();
    dirs.push(installPath);

    const config = resolvePersonaPlexConfig({
      enabled: true,
      installPath,
      host: "127.0.0.1",
      port: 8998,
      transport: "auto",
      endpoints: [
        {
          host: "127.0.0.1",
          port: 28998,
          useSsl: false,
          transport: "server",
          priority: 0,
          healthPath: "/",
          healthTimeoutMs: 100,
          healthCacheTtlMs: 0,
        },
        {
          host: "127.0.0.1",
          transport: "offline",
          priority: 10,
        },
      ],
    });

    const selected = await selectPersonaPlexEndpoint(config);
    expect(selected).not.toBeNull();
    expect(selected?.transport).toBe("offline");
    expect(selected?.config.installPath).toBe(installPath);
  });
});
