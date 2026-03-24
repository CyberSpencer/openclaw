import {
  buildDailyObservabilityRollup,
  resolveObservabilityRollupFilePath,
  writeDailyObservabilityRollup,
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
      "observability-rollup.ts",
      "",
      "Options:",
      "  --day YYYY-MM-DD         Roll up one gateway-local day (default: today)",
      "  --timeZone <iana>        Display the day using this timezone",
      "  --events-file <path>     Override the source NDJSON file",
      "  --state-dir <path>       Resolve default paths from this state dir",
      "  --write                  Write to the default daily rollup path",
      "  --output <path>          Write to a specific output file",
      "  --quiet                  Suppress stdout JSON when writing",
    ].join("\n"),
  );
  process.exit(code);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help === true) {
    usageAndExit(0);
  }

  const rollup = await buildDailyObservabilityRollup({
    day: typeof args.day === "string" ? args.day : undefined,
    timeZone: typeof args.timeZone === "string" ? args.timeZone : undefined,
    stateDir: typeof args["state-dir"] === "string" ? args["state-dir"] : undefined,
    eventsFilePath: typeof args["events-file"] === "string" ? args["events-file"] : undefined,
  });

  const outputPath =
    typeof args.output === "string"
      ? args.output
      : args.write === true
        ? resolveObservabilityRollupFilePath({
            day: rollup.day,
            stateDir: typeof args["state-dir"] === "string" ? args["state-dir"] : undefined,
          })
        : null;

  if (outputPath) {
    await writeDailyObservabilityRollup({ rollup, outputPath });
    if (args.quiet !== true) {
      console.error(`wrote ${outputPath}`);
    }
  }

  if (args.quiet !== true) {
    process.stdout.write(`${JSON.stringify(rollup, null, 2)}\n`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
