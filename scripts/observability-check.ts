import {
  inspectObservabilityFreshness,
  resolveGatewayLogFilePath,
} from "../src/infra/observability-rollup.js";

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i] ?? "";
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function usageAndExit(code: number): never {
  console.error(
    [
      "observability-check.ts",
      "",
      "Options:",
      "  --day YYYY-MM-DD             Inspect one gateway-local day (default: today)",
      "  --state-dir <path>           Resolve default observability path from this state dir",
      "  --events-file <path>         Override observability NDJSON source path",
      "  --gateway-log <path>         Override gateway log path (recommended if logging.file is customized)",
      "  --max-stale-minutes <n>      Staleness threshold in minutes (default: 60)",
      "  --json                       Emit machine-readable JSON",
    ].join("\n"),
  );
  process.exit(code);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help === true) {
    usageAndExit(0);
  }

  const maxStaleMinutes =
    typeof args["max-stale-minutes"] === "string" ? Number(args["max-stale-minutes"]) : 60;
  const maxStaleMs =
    Number.isFinite(maxStaleMinutes) && maxStaleMinutes > 0
      ? maxStaleMinutes * 60_000
      : 60 * 60_000;

  const freshness = await inspectObservabilityFreshness({
    day: typeof args.day === "string" ? args.day : undefined,
    stateDir: typeof args["state-dir"] === "string" ? args["state-dir"] : undefined,
    eventsFilePath: typeof args["events-file"] === "string" ? args["events-file"] : undefined,
    gatewayLogPath:
      typeof args["gateway-log"] === "string" ? args["gateway-log"] : resolveGatewayLogFilePath(),
    maxStaleMs,
  });

  if (args.json === true) {
    process.stdout.write(`${JSON.stringify(freshness, null, 2)}\n`);
  } else {
    console.log(freshness.summary);
    console.log(`gateway log: ${freshness.gatewayLog.path}`);
    console.log(`events file: ${freshness.eventsFile.path}`);
    if (freshness.warnings.length > 0) {
      for (const warning of freshness.warnings) {
        console.log(`- ${warning}`);
      }
    }
  }

  process.exit(freshness.level === "ok" ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
