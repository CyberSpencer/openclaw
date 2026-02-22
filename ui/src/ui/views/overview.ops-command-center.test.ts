import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { OpsCommandCenterSnapshot } from "../types.ts";
import { renderOverview, type OverviewProps } from "./overview.ts";

function buildProps(partial?: Partial<OverviewProps>): OverviewProps {
  return {
    connected: true,
    hello: null,
    settings: {
      gatewayUrl: "ws://localhost:32555",
      token: "",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "dark",
      chatFocusMode: false,
      chatShowThinking: true,
      splitRatio: 0.58,
      navCollapsed: false,
      navGroupsCollapsed: {},
      ttsVoice: "",
      ttsInstruct: "",
      ttsLanguage: "",
    },
    password: "",
    lastError: null,
    presenceCount: 1,
    sessionsCount: 2,
    cronEnabled: true,
    cronNext: Date.now() + 60_000,
    lastChannelsRefresh: Date.now(),
    systemStatusLoading: false,
    systemStatusError: null,
    routerStatus: null,
    sparkStatus: null,
    opsSnapshot: null,
    opsSnapshotLoading: false,
    opsSnapshotError: null,
    onSettingsChange: () => undefined,
    onPasswordChange: () => undefined,
    onSessionKeyChange: () => undefined,
    onConnect: () => undefined,
    onRefresh: () => undefined,
    onOpenTab: () => undefined,
    onRouterSetEnabled: () => undefined,
    ...partial,
  };
}

function buildSnapshot(): OpsCommandCenterSnapshot {
  return {
    generatedAt: Date.now(),
    orchestrator: {
      status: "degraded",
      activeRuns: 3,
      stalledRuns: 1,
      errorRuns: 2,
      stalledAfterMs: 120_000,
      active: [
        {
          runId: "run-1",
          sessionKey: "main",
          startedAt: Date.now() - 100_000,
          ageMs: 100_000,
          lastDeltaAt: Date.now() - 95_000,
          idleMs: 95_000,
          stalled: false,
          cardId: "card-1",
          cardTitle: "Feature task",
        },
      ],
      links: [{ label: "Open Orchestrator", tab: "orchestrator" }],
    },
    hygiene: {
      status: "degraded",
      installKind: "git",
      packageManager: "pnpm",
      git: {
        branch: "feature/ops",
        upstream: "origin/feature/ops",
        dirty: true,
        ahead: 0,
        behind: 2,
        fetchOk: null,
        sha: "abc123",
      },
      deps: { status: "ok" },
      ci: {
        detected: true,
        provider: "github-actions",
        workflow: "CI",
        event: "pull_request",
        branch: "feature/ops",
        runId: "123",
        runUrl: "https://github.com/openclaw/openclaw/actions/runs/123",
      },
      pr: {
        detected: true,
        number: 42,
        url: "https://github.com/openclaw/openclaw/pull/42",
        baseRef: "main",
        headRef: "feature/ops",
      },
      checks: [
        { id: "branch-clean", label: "Branch clean", status: "degraded", detail: "dirty" },
        { id: "branch-sync", label: "Branch sync", status: "degraded", detail: "behind" },
      ],
    },
    voiceSystem: {
      status: "degraded",
      degradedReasons: ["Spark voice pipeline is unavailable."],
      router: {
        enabled: true,
        healthy: true,
        url: "http://127.0.0.1:8001/health",
        checkedAt: Date.now(),
      },
      spark: {
        enabled: true,
        active: true,
        overall: "degraded",
        voiceAvailable: false,
      },
      links: [
        { label: "Overview", tab: "overview" },
        { label: "DGX", tab: "dgx" },
      ],
    },
  };
}

describe("overview ops command center", () => {
  it("renders unavailable state when snapshot is missing", async () => {
    const container = document.createElement("div");
    render(renderOverview(buildProps()), container);
    await Promise.resolve();

    expect(container.textContent).toContain("Ops Command Center");
    expect(container.textContent).toContain("Snapshot unavailable");
  });

  it("renders status chips, key counts, and drill-down links", async () => {
    const onOpenTab = vi.fn();
    const container = document.createElement("div");
    render(renderOverview(buildProps({ opsSnapshot: buildSnapshot(), onOpenTab })), container);
    await Promise.resolve();

    expect(container.textContent).toContain("Orchestrator");
    expect(container.textContent).toContain("Hygiene");
    expect(container.textContent).toContain("Voice/System");
    expect(container.textContent).toContain("Active runs");
    expect(container.textContent).toContain("Stalled");
    expect(container.textContent).toContain("Errors");
    expect(container.textContent).toContain("Degraded reasons");

    const buttons = Array.from(container.querySelectorAll("button"));
    const orchestratorBtn = buttons.find((button) =>
      button.textContent?.includes("Open Orchestrator"),
    );
    expect(orchestratorBtn).toBeDefined();
    orchestratorBtn?.dispatchEvent(new MouseEvent("click"));
    expect(onOpenTab).toHaveBeenCalledWith("orchestrator");
  });
});
