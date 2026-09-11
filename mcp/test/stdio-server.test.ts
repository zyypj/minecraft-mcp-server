import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import test from "ava";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const compiledEntry = join(packageRoot, "dist", "main.js");

/**
 * Drive the *compiled* server over real stdio, with the exact arguments the container entrypoint
 * uses.
 *
 * The unit tests call tool handlers directly, which proves the logic but not the packaging. This
 * proves the packaging: that `dist/main.js` runs under plain Node with no transpiler, that the
 * engine backend needs none of the optional bot dependencies, and that the directory flags the
 * Dockerfile passes are the ones the server actually accepts.
 */
interface Rpc {
  id?: number;
  result?: { tools?: { name: string }[]; content?: { type: string; text?: string }[]; isError?: boolean };
  error?: { message: string };
}

async function talk(requests: object[], dirs: { schematics: string; builds: string; styles: string }) {
  const child = spawn(
    process.execPath,
    [
      compiledEntry,
      "--backend",
      "engine",
      "--schematics-dir",
      dirs.schematics,
      "--builds-dir",
      dirs.builds,
      "--styles-dir",
      dirs.styles,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );

  const responses: Rpc[] = [];
  let buffer = "";
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const done = new Promise<void>((resolveDone, rejectDone) => {
    const timer = setTimeout(() => {
      child.kill();
      rejectDone(new Error(`timed out; stderr:\n${stderr}`));
    }, 60_000);

    child.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          try {
            responses.push(JSON.parse(line) as Rpc);
          } catch {
            // The server filters its own logging off stdout; anything unparseable is a real defect,
            // because it would corrupt the JSON-RPC stream for a client.
            clearTimeout(timer);
            child.kill();
            rejectDone(new Error(`non-JSON line on stdout: ${line}`));
            return;
          }
        }
        newline = buffer.indexOf("\n");
      }
      if (responses.filter((r) => r.id !== undefined).length >= requests.length) {
        clearTimeout(timer);
        child.stdin.end();
        resolveDone();
      }
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      rejectDone(error);
    });
  });

  for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
  await done;
  child.kill();
  return { responses, stderr };
}

const dirs = () => {
  const root = mkdtempSync(join(tmpdir(), "mcbuild-stdio-"));
  return {
    schematics: join(root, "schematics"),
    builds: join(root, "builds"),
    styles: join(root, "styles"),
    root,
  };
};

test("the compiled server speaks MCP over stdio with the container's arguments", async (t) => {
  t.true(
    existsSync(compiledEntry),
    `dist/main.js is missing — run \`npm run build\` in mcp/ first (${compiledEntry})`,
  );

  const d = dirs();
  const { responses, stderr } = await talk(
    [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "ava", version: "0" },
        },
      },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ],
    d,
  );

  const initialize = responses.find((r) => r.id === 1);
  t.truthy(initialize, `no initialize response; stderr:\n${stderr}`);
  t.falsy(initialize?.error);

  const list = responses.find((r) => r.id === 2);
  const tools = list?.result?.tools ?? [];
  t.true(tools.length > 70, `expected the full build surface, got ${tools.length}`);
  for (const expected of ["build_bedwars_map", "ingest_schematic", "list_schematics", "preview_build", "save_build"]) {
    t.true(
      tools.some((tool) => tool.name === expected),
      `${expected} is advertised`,
    );
  }

  // The directories named on the command line are created, which is what makes the container's
  // volume mounts land somewhere real.
  t.true(existsSync(d.schematics));
  t.true(existsSync(d.builds));
  t.true(existsSync(d.styles));
});

test("a relative filename resolves against the schematics directory", async (t) => {
  const d = dirs();
  const { responses } = await talk(
    [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ava", version: "0" } },
      },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_schematics", arguments: {} } },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "ingest_schematic", arguments: { file: "missing.schematic", styleId: "x" } },
      },
    ],
    d,
  );

  const listed = responses.find((r) => r.id === 2);
  const listedText = listed?.result?.content?.map((c) => c.text ?? "").join("") ?? "";
  t.regex(listedText, /is empty/, "an empty mount is reported as such, not as an error");
  t.regex(listedText, /ingest_schematic/, "and it says what to do next");

  const failed = responses.find((r) => r.id === 3);
  const failedText = failed?.result?.content?.map((c) => c.text ?? "").join("") ?? "";
  t.true(failed?.result?.isError === true);
  t.regex(failedText, /Looked in/, "a missing file reports where it looked");
  t.true(failedText.includes(d.schematics), "including the schematics directory");
});
