"use strict";
/**
 * xenmox-con-server – a node ügynök.
 * Nincs webes felülete: egy másik gépen futó XenMox főszerver adja hozzá
 * (Datacenter settings → Add node), és innentől innen irányítja a VM-eket.
 *
 * Beállítások (környezeti változók):
 *   XENMOX_PORT   port (alapból 3001)
 *   XENMOX_TOKEN  a hozzáférési token (alapból a data/con-server.json-ban generált)
 *   XENMOX_DATA   adatmappa (alapból ./data)
 */
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { createNode } = require("./lib/node");

const DATA_DIR = path.resolve(process.env.XENMOX_DATA || path.join(__dirname, "data"));
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- Token ----------
const CONF_FILE = path.join(DATA_DIR, "con-server.json");
let conf = fs.existsSync(CONF_FILE) ? JSON.parse(fs.readFileSync(CONF_FILE, "utf8")) : {};
if (!conf.token) {
    conf.token = crypto.randomBytes(24).toString("hex");
    fs.writeFileSync(CONF_FILE, JSON.stringify(conf, null, 2), { mode: 0o600 });
}
const TOKEN = process.env.XENMOX_TOKEN || conf.token;
const PORT = Number(process.env.XENMOX_PORT || conf.port || 3001);

function safeEqual(a, b) {
    const A = Buffer.from(a);
    const B = Buffer.from(b);
    return A.length === B.length && crypto.timingSafeEqual(A, B);
}

function authOk(req) {
    const h = req.headers.authorization || "";
    return h.startsWith("Bearer ") && safeEqual(h.slice(7), TOKEN);
}

function requireToken(req, res, next) {
    if (authOk(req)) return next();
    res.status(401).json({ error: "Hibás vagy hiányzó token" });
}

// ---------- Szerver ----------
const node = createNode({ dataDir: DATA_DIR });
const app = express();
app.use("/api", requireToken, node.router);

const server = app.listen(PORT, () => {
    console.log("xenmox-con-server fut");
    console.log(`  port : ${PORT}`);
    console.log(`  token: ${TOKEN}`);
    console.log("Add hozzá a főszerver webes felületén: Datacenter settings → Add node");
});

server.on("upgrade", (req, socket, head) => {
    const m = /^\/api\/vms\/(\d+)\/vnc$/.exec(req.url.split("?")[0]);
    if (!m || !authOk(req)) {
        socket.write(`HTTP/1.1 ${m ? 401 : 404} Error\r\n\r\n`);
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
