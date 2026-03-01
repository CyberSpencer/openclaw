import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../../runtime.js";

const readConfigFileSnapshotMock = vi.fn();
const loadAndMaybeMigrateDoctorConfigMock = vi.fn();

vi.mock("../../config/config.js", () => ({
  readConfigFileSnapshot: readConfigFileSnapshotMock,
}));

vi.mock("../../commands/doctor-config-flow.js", () => ({
  loadAndMaybeMigrateDoctorConfig: loadAndMaybeMigrateDoctorConfigMock,
}));

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    exit: vi.fn(),
  };
}

function invalidSnapshot() {
  return {
    exists: true,
    valid: false,
    path: "/tmp/openclaw.json",
    hash: "hash",
    raw: "{}",
    config: {},
    issues: [{ path: "gateway.auth.token", message: 'Missing env var "OPENCLAW_GATEWAY_TOKEN"' }],
    legacyIssues: [],
  };
}

describe("ensureConfigReady", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    loadAndMaybeMigrateDoctorConfigMock.mockResolvedValue(undefined);
    readConfigFileSnapshotMock.mockResolvedValue(invalidSnapshot());
  });

  it("allows daemon status when config is invalid", async () => {
    const { ensureConfigReady } = await import("./config-guard.js");
    const runtime = createRuntime();

    await ensureConfigReady({ runtime, commandPath: ["daemon", "status"] });

    expect(runtime.exit).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalled();
  });

  it("still blocks daemon install when config is invalid", async () => {
    const { ensureConfigReady } = await import("./config-guard.js");
    const runtime = createRuntime();

    await ensureConfigReady({ runtime, commandPath: ["daemon", "install"] });

    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});
