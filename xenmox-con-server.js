"use strict";
/**
 * xenmox-con-server – a node ügynök.
 * Nincs webes felülete: egy XenMox főszerver adja hozzá (Datacenter settings → Add node),
 * és innentől onnan irányítja a VM-eket és konténereket.
 *
 * Első használat előtt felhasználót kell beállítani:   npm run con-server -- --setup
 * Amíg nincs beállítva felhasználó, a szerver minden kérést visszautasít.
 *
 * Beállítások (környezeti változók):
 *   XENMOX_PORT   port (alapból 3001)
 *   XENMOX_DATA   adatmappa (alapból ./data)
 *   XENMOX_USER, XENMOX_PASS   csak a --setup nem interaktív használatához
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

    // null, ha a kérés hitelesített; különben {status, msg}
    async function authenticate(req) {
        auth.refresh();
        if (!auth.configured) {
            return { status: 503, msg: "A con-server még nincs beállítva (futtasd rajta: npm run con-server -- --setup)", setup: true };
        }
        const ip = req.socket.remoteAddress || "";
        if (limiter.blocked(ip)) return { status: 429, msg: "Túl sok sikertelen próbálkozás, próbáld újra később" };
        if (await auth.verifyBasic(req.headers.authorization)) {
            limiter.ok(ip);
            return null;
        }
        limiter.fail(ip);
        return { status: 401, msg: "Hibás vagy hiányzó felhasználónév/jelszó" };
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
    app.use((req, res) => res.status(404).json({ error: "Nincs ilyen útvonal" }));

    const server = app.listen(PORT, () => {
        console.log("xenmox-con-server fut");
        console.log(`  port: ${PORT}`);
        if (auth.configured) {
            console.log(`  felhasználó: ${auth.username}`);
            console.log("Add hozzá a főszerver webes felületén: Datacenter settings → Add node");
        } else {
            console.log("  ZÁROLVA: még nincs felhasználó beállítva, minden kérés elutasításra kerül.");
            console.log("  Állítsd be (egyszer):  npm run con-server -- --setup");
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
