import { describe, expect, it } from "vitest";
import { listChannelPlugins } from "../channels/plugins/index.js";
import { listGatewayMethods } from "./server-methods-list.js";
import { coreGatewayHandlers } from "./server-methods.js";

describe("gateway method inventory parity", () => {
  it("ensures all non-plugin advertised methods have handlers", () => {
    const pluginMethods = new Set(
      listChannelPlugins().flatMap((plugin) => plugin.gatewayMethods ?? []),
    );
    // Intentionally external/registered via runtime-specific hooks.
    const externallyHandledMethods = new Set([
      "gateway.restart",
      "doctor.run",
      "exec.approval.request",
      "exec.approval.waitDecision",
      "exec.approval.resolve",
    ]);

    const missing = listGatewayMethods().filter(
      (method) =>
        !pluginMethods.has(method) &&
        !externallyHandledMethods.has(method) &&
        !coreGatewayHandlers[method],
    );

    expect(missing).toEqual([]);
  });
});
