// ensureServer must not keep the process that spawned the server alive.
//
// It used to spawn `opencode serve` with stdout/stderr as pipes. proc.unref()
// releases the child handle but not those pipe handles, so a task worker that
// started the server (the review loop's reviewer is often the first opencode
// user now that coder runs on agy) finished its job and then sat in
// epoll_wait forever, holding the server's output sockets.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTmpDir, cleanupTmpDir } from "./helpers.mjs";

const SERVER_MODULE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../plugins/opencode/scripts/lib/opencode-server.mjs",
);

// A stand-in `opencode` that answers the health check, and writes to stdout
// and stderr the way the real server does.
const FAKE_OPENCODE = `#!/usr/bin/env node
const http = require("node:http");
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
http.createServer((req, res) => { res.statusCode = 200; res.end("{}"); })
  .listen(port, "127.0.0.1", () => {
    console.log("fake opencode listening on " + port);
    console.error("fake opencode stderr line");
  });
`;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

describe("ensureServer", () => {
  let dir;
  let serverPid;

  before(() => {
    dir = createTmpDir("ensure-server");
    fs.mkdirSync(path.join(dir, "bin"));
    const bin = path.join(dir, "bin", "opencode");
    fs.writeFileSync(bin, FAKE_OPENCODE, { mode: 0o755 });
  });

  after(() => {
    if (serverPid) {
      try { process.kill(serverPid, "SIGKILL"); } catch { /* already gone */ }
    }
    cleanupTmpDir(dir);
  });

  it("lets the spawning process exit once the server is up, and logs server output", async () => {
    const port = await freePort();
    const script = `
      const { ensureServer } = await import(${JSON.stringify(SERVER_MODULE)});
      const info = await ensureServer({ port: ${port}, cwd: ${JSON.stringify(dir)} });
      console.log(JSON.stringify(info));
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: {
        ...process.env,
        PATH: `${path.join(dir, "bin")}${path.delimiter}${process.env.PATH}`,
        XDG_CONFIG_HOME: path.join(dir, "config"),
        OPENCODE_COMPANION_DATA: path.join(dir, "data"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));

    const exited = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 15_000);
      child.on("exit", () => { clearTimeout(t); resolve(true); });
    });
    if (!exited) child.kill("SIGKILL");

    const info = JSON.parse(out.trim().split("\n").pop() || "{}");
    serverPid = info.pid;
    assert.ok(exited, `spawning process did not exit after ensureServer returned; stderr: ${err}`);
    assert.equal(info.alreadyRunning, false);
    assert.ok(serverPid, "ensureServer should report the spawned pid");

    // The server outlives its parent and still serves.
    const res = await fetch(`http://127.0.0.1:${port}/global/health`);
    assert.equal(res.status, 200);

    const log = fs.readFileSync(path.join(dir, "data", "state", "opencode-serve.log"), "utf8");
    assert.match(log, /fake opencode listening/);
    assert.match(log, /fake opencode stderr line/);
  });
});
