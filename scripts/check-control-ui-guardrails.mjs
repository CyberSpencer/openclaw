#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function main() {
  const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptsDir, "..");
  const distRoot = path.join(repoRoot, "dist", "control-ui");
  const indexPath = path.join(distRoot, "index.html");
  const assetsDir = path.join(distRoot, "assets");

  assert.ok(fs.existsSync(distRoot), `Missing Control UI build output at ${distRoot}`);
  assert.ok(fs.existsSync(indexPath), `Missing Control UI index at ${indexPath}`);
  assert.ok(fs.existsSync(assetsDir), `Missing Control UI assets directory at ${assetsDir}`);

  const assetNames = fs.readdirSync(assetsDir);
  const jsAsset = assetNames.find((name) => name.endsWith(".js"));
  const cssAsset = assetNames.find((name) => name.endsWith(".css"));

  assert.ok(jsAsset, `Expected at least one JS asset in ${assetsDir}`);
  assert.ok(cssAsset, `Expected at least one CSS asset in ${assetsDir}`);

  const indexHtml = fs.readFileSync(indexPath, "utf8");
  assert.match(indexHtml, /<html/i, `Expected ${indexPath} to look like HTML`);
  assert.match(
    indexHtml,
    /src="\.\/assets\/.+\.js"|src="\/assets\/.+\.js"|src="assets\/.+\.js"/i,
    `Expected ${indexPath} to reference a built JS asset`,
  );
  assert.match(
    indexHtml,
    /href="\.\/assets\/.+\.css"|href="\/assets\/.+\.css"|href="assets\/.+\.css"/i,
    `Expected ${indexPath} to reference a built CSS asset`,
  );

  process.stdout.write(
    [
      `OK dist root: ${distRoot}`,
      `OK index: ${indexPath}`,
      `OK assets: ${jsAsset} and ${cssAsset}`,
    ].join("\n") + "\n",
  );
}

main();
