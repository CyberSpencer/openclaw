import { beforeEach, describe, expect, it, vi } from "vitest";

const { buildExecutiveBriefPayload } = vi.hoisted(() => ({
  buildExecutiveBriefPayload: vi.fn(),
}));

vi.mock("../executive-brief.js", () => ({
  buildExecutiveBriefPayload,
}));

import { executiveBriefHandlers } from "./executive-brief.js";

describe("brief.get handler", () => {
  beforeEach(() => {
    buildExecutiveBriefPayload.mockReset();
  });

  it("rejects invalid params", async () => {
    const respond = vi.fn();

    await executiveBriefHandlers["brief.get"]({
      req: { id: "1", method: "brief.get", params: { preset: "night" } },
      params: { preset: "night" },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {} as never,
    });

    expect(respond).toHaveBeenCalledOnce();
    const [ok, payload, error] = respond.mock.calls[0] as [boolean, unknown, { message: string }];
    expect(ok).toBe(false);
    expect(payload).toBeUndefined();
    expect(error.message).toContain("invalid brief.get params");
  });

  it("returns brief payload for valid params", async () => {
    buildExecutiveBriefPayload.mockResolvedValue({
      generatedAt: 1,
      topActions: [{ id: "a" }],
    });

    const respond = vi.fn();

    await executiveBriefHandlers["brief.get"]({
      req: { id: "2", method: "brief.get", params: { preset: "pm", topActionsLimit: 2 } },
      params: { preset: "pm", topActionsLimit: 2 },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: { marker: "ctx" } as never,
    });

    expect(buildExecutiveBriefPayload).toHaveBeenCalledWith({
      context: { marker: "ctx" },
      preset: "pm",
      windows: undefined,
      topActionsLimit: 2,
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      { generatedAt: 1, topActions: [{ id: "a" }] },
      undefined,
    );
  });
});
