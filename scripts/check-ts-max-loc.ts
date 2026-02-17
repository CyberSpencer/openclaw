import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

type ParsedArgs = {
  maxLines: number;
  warnOnly: boolean;
  waiversPath: string;
};

type LocWaiver = {
  path: string;
  maxLines?: number;
  expires?: string;
  reason?: string;
};

type WaiverFile = {
  waivers?: LocWaiver[];
};

function parseArgs(argv: string[]): ParsedArgs {
  let maxLines = 500;
  let warnOnly = false;
  let waiversPath = ".loc-waivers.json";

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--max") {
      const next = argv[index + 1];
      if (!next || Number.isNaN(Number(next))) {
        throw new Error("Missing/invalid --max value");
      }
      maxLines = Number(next);
      index++;
      continue;
    }
    if (arg === "--warn") {
      warnOnly = true;
      continue;
    }
    if (arg === "--waivers") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("Missing --waivers value");
      }
      waiversPath = next;
      index++;
      continue;
    }
  }

  return { maxLines, warnOnly, waiversPath };
}

function gitLsFilesAll(): string[] {
  // Include untracked files too so local refactors don’t “pass” by accident.
  const stdout = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    encoding: "utf8",
  });
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function countLines(filePath: string): Promise<number> {
  const content = await readFile(filePath, "utf8");
  // Count physical lines. Keeps the rule simple + predictable.
  return content.split("\n").length;
}

function parseDate(value?: string): number | null {
  if (!value) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function loadWaivers(filePath: string): LocWaiver[] {
  if (!existsSync(filePath)) {
    return [];
  }
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as WaiverFile;
    if (!Array.isArray(parsed?.waivers)) {
      return [];
    }
    return parsed.waivers.filter((entry) => typeof entry?.path === "string" && entry.path.trim());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[check-ts-max-loc] failed to parse waivers file ${filePath}: ${message}`);
    return [];
  }
}

function resolveWaiver(
  waivers: LocWaiver[],
  filePath: string,
  lineCount: number,
  nowMs: number,
): { waived: boolean; reason?: string } {
  const entry = waivers.find((waiver) => waiver.path === filePath);
  if (!entry) {
    return { waived: false };
  }
  const expiresMs = parseDate(entry.expires);
  if (expiresMs != null && expiresMs < nowMs) {
    return {
      waived: false,
      reason: `waiver expired ${entry.expires}`,
    };
  }
  if (typeof entry.maxLines === "number" && lineCount > entry.maxLines) {
    return {
      waived: false,
      reason: `waiver max ${entry.maxLines} exceeded`,
    };
  }
  const reason = entry.reason?.trim() || "waived";
  return {
    waived: true,
    reason,
  };
}

async function main() {
  // Makes `... | head` safe.
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") {
      process.exit(0);
    }
    throw error;
  });

  const { maxLines, warnOnly, waiversPath } = parseArgs(process.argv.slice(2));
  const waivers = loadWaivers(waiversPath);
  const nowMs = Date.now();

  const files = gitLsFilesAll()
    .filter((filePath) => existsSync(filePath))
    .filter((filePath) => filePath.endsWith(".ts") || filePath.endsWith(".tsx"));

  const results = await Promise.all(
    files.map(async (filePath) => ({ filePath, lines: await countLines(filePath) })),
  );

  const offenders = results
    .filter((result) => result.lines > maxLines)
    .map((result) => ({
      ...result,
      waiver: resolveWaiver(waivers, result.filePath, result.lines, nowMs),
    }))
    .toSorted((a, b) => b.lines - a.lines);

  if (!offenders.length) {
    return;
  }

  let blocking = false;
  for (const offender of offenders) {
    if (offender.waiver.waived) {
      console.log(
        `${offender.lines}\t${offender.filePath}\tWAIVED\t${offender.waiver.reason ?? ""}`,
      );
      continue;
    }

    const suffix = offender.waiver.reason ? ` (${offender.waiver.reason})` : "";
    const line = `${offender.lines}\t${offender.filePath}${suffix}`;
    console.log(line);

    if (warnOnly) {
      // GitHub Actions warning annotation.
      console.log(
        `::warning file=${offender.filePath}::LOC ${offender.lines} exceeds budget ${maxLines}${suffix}`,
      );
      continue;
    }

    blocking = true;
  }

  if (blocking) {
    process.exitCode = 1;
  }
}

await main();
