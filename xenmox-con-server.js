"use strict";
/**
 * xenmox-con-server – the node agent.
 * It has no web interface: a XenMox main server adds it (Datacenter settings → Add node),
 * and from then on it manages the VMs and containers from there.
 *
 * Before first use, a user must be set up:   npm run con-server -- --setup
 * Until a user is configured, the server rejects every request.
 *
 * Settings (environment variables):
 *   XENMOX_PORT   port (default 3001)
 *   XENMOX_DATA   data directory (default ./data)
 *   XENMOX_USER, XENMOX_PASS   only for non-interactive use of --setup
 */
const express = require("express");
const fs = require("fs");
const path = require("path");
const { createNode } = require("./lib/node");
const { AuthStore, createLimiter, runSetup } = require("./lib/auth");

const DATA_DIR = path.resolve(process.env.XENMOX_DATA || path.join(__dirname, "data"));
fs.mkdirSync(DATA_DIR, { recursive: true });

const auth = new AuthStore(path.join(DATA_DIR, "auth.json"));
const PORT = Number(process.env.XENMOX_PORT || 3001);

if (process.argv.includes("--setup")) {
    runSetup(auth, "xenmox-con-server").then(() => process.exit(0));
} else {
    start();
}

function start() {
    const limiter = createLimiter({ max: 10, windowMs: 60000, lockMs: 60000 });

    // null if the request is authenticated; otherwise {status, msg}
    async function authenticate(req) {
        auth.refresh();
        if (!auth.configured) {
            return { status: 503, msg: "The con-server is not configured yet (run on it: npm run con-server -- --setup)", setup: true };
        }
        const ip = req.socket.remoteAddress || "";
        if (limiter.blocked(ip)) return { status: 429, msg: "Too many failed attempts, try again later" };
        if (await auth.verifyBasic(req.headers.authorization)) {
            limiter.ok(ip);
            return null;
        }
        limiter.fail(ip);
        return { status: 401, msg: "Invalid or missing username/password" };
    }

    const node = createNode({ dataDir: DATA_DIR });
    const app = express();
    app.disable("x-powered-by");

    app.use("/api", async (req, res, next) => {
        const fail = await authenticate(req);
        if (fail) return res.status(fail.status).json({ error: fail.msg, setup: fail.setup });
        next();
    });
    app.use("/api", node.router);
    app.use((req, res) => res.status(404).json({ error: "No such route" }));

    const server = app.listen(PORT, () => {
        console.log("xenmox-con-server running");
        console.log(`  port: ${PORT}`);
        if (auth.configured) {
            console.log(`  user: ${auth.username}`);
            console.log("Add it in the main server's web interface: Datacenter settings → Add node");
        } else {
            console.log("  LOCKED: no user configured yet, every request is rejected.");
            console.log("  Set it up (once):  npm run con-server -- --setup");
        }
    });

    server.on("upgrade", async (req, socket, head) => {
        const m = /^\/api\/vms\/(\d+)\/vnc$/.exec(req.url.split("?")[0]);
        if (!m) {
            socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
            return socket.destroy();
        }
        const fail = await authenticate(req);
        if (fail) {
            socket.write(`HTTP/1.1 ${fail.status} Error\r\n\r\n`);
            return socket.destroy();
        }
        node.handleVncUpgrade(req, socket, head, Number(m[1]));
    });

    for (const sig of ["SIGINT", "SIGTERM"]) {
        process.on(sig, () => {
            node.stopAll();
            process.exit(0);
        });
    }
}
