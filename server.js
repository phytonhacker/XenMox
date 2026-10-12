"use strict";
/**
 * XenMox főszerver: webes felület (bejelentkezéssel) + helyi node + távoli node-ok (xenmox-con-server)
 * + más XenMox főszerverek datacenterének megjelenítése (federáció).
 *
 * Első használatkor a webes felületen (vagy parancssorból: npm start -- --setup) felhasználót kell beállítani.
 * Amíg nincs beállítva, a szerver minden API kérést visszautasít.
 */
const express = require("express");
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { WebSocketServer, WebSocket } = require("ws");
const { createNode } = require("./lib/node");
const { AuthStore, createSessions, createLimiter, parseCookies, validateCredentials, safeEqual, runSetup } = require("./lib/auth");

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(process.env.XENMOX_DATA || path.join(__dirname, "data"));
fs.mkdirSync(DATA_DIR, { recursive: true });

const auth = new AuthStore(path.join(DATA_DIR, "auth.json"));

if (process.argv.includes("--setup")) {
    runSetup(auth, "XenMox főszerver").then(() => process.exit(0));
} else {
    start();
}

function start() {
    // ---------- Regisztráció: datacenter, node-ok, összekötött datacenterek ----------
    const REG_FILE = path.join(DATA_DIR, "nodes.json");
    let registry = fs.existsSync(REG_FILE)
        ? JSON.parse(fs.readFileSync(REG_FILE, "utf8"))
        : { datacenter: "prod-eu-central", nodes: [] };
    if (!registry.nodes.some((n) => n.local)) registry.nodes.unshift({ id: "local", name: "prod1", local: true });
    if (!Array.isArray(registry.dcs)) registry.dcs = []; // összekötött távoli datacenterek
    if (!registry.fedToken) registry.fedToken = crypto.randomBytes(24).toString("hex"); // ezzel kapcsolódhatnak hozzánk
    const saveRegistry = () => fs.writeFileSync(REG_FILE, JSON.stringify(registry, null, 2), { mode: 0o600 });
    saveRegistry();
    fs.chmodSync(REG_FILE, 0o600);

    const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
    const DC_RE = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,63}$/;
    const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

    const local = createNode({ dataDir: DATA_DIR });
    const sessions = createSessions();
    const loginLimiter = createLimiter({ max: 5, windowMs: 60000, lockMs: 60000 });
    const COOKIE = "xm_session";
    const SESSION_MAX_AGE = 12 * 3600;

    const app = express();
    app.disable("x-powered-by");

    app.use((req, res, next) => {
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("X-Frame-Options", "DENY");
        res.setHeader("Referrer-Policy", "no-referrer");
        next();
    });

    // A bejelentkező felület fájljai (és a noVNC könyvtár) nyilvánosak, titkot nem tartalmaznak
    app.use(express.static(path.join(__dirname, "public")));
    app.use("/novnc", express.static(path.join(__dirname, "node_modules", "@novnc", "novnc")));

    // ---------- Segédek ----------
    // Hitelesítési fejléc a célszerverhez: con-server → Basic (felhasználó/jelszó), másik főszerver → Bearer (federációs token)
    function authHeaderFor(target) {
        if (target.username) return "Basic " + Buffer.from(`${target.username}:${target.password}`).toString("base64");
        return `Bearer ${target.token}`;
    }

    function sessionOf(req) {
        return sessions.get(parseCookies(req.headers.cookie)[COOKIE]);
    }

    function sameOrigin(req) {
        const origin = req.headers.origin;
        if (!origin) return true; // nem böngészős kliens
        try {
            return new URL(origin).host === req.headers.host;
        } catch {
            return false;
        }
    }

    function setSessionCookie(req, res, id, maxAge = SESSION_MAX_AGE) {
        const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
        res.setHeader("Set-Cookie", `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? "; Secure" : ""}`);
    }

    function fedAuthOk(req) {
        const h = req.headers.authorization || "";
        return auth.configured && h.startsWith("Bearer ") && safeEqual(h.slice(7), registry.fedToken);
    }

    function requireFedToken(req, res, next) {
        auth.refresh();
        if (!auth.configured) return res.status(503).json({ error: "A szerver még nincs beállítva", setup: true });
        if (fedAuthOk(req)) return next();
        res.status(401).json({ error: "Hibás vagy hiányzó federációs token" });
    }

    // GET egy távoli szerverre (con-server vagy másik főszerver)
    function getJson(target, fullPath, timeoutMs = 2500) {
        return new Promise((resolve, reject) => {
            const req = http.request(
                {
                    host: target.host,
                    port: target.port,
                    path: fullPath,
                    method: "GET",
                    headers: { Authorization: authHeaderFor(target) },
                    timeout: timeoutMs,
                },
                (res) => {
                    let body = "";
                    res.on("data", (d) => (body += d));
                    res.on("end", () => resolve({ status: res.statusCode, body }));
                }
            );
            req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
            req.on("error", reject);
            req.end();
        });
    }

    const unreachable = (err, what) =>
        err.code === "ECONNREFUSED"
            ? `A kapcsolat elutasítva – fut a ${what} ezen a porton?`
            : "A szerver nem érhető el (cím, port, tűzfal?)";

    // Kérés továbbítása streamként (az ISO feltöltés sem pufferelődik). A böngésző sütije nem megy tovább.
    function streamProxy(req, res, target, prefix) {
        const headers = { ...req.headers, authorization: authHeaderFor(target), host: `${target.host}:${target.port}` };
        delete headers.cookie;
        delete headers.origin;
        delete headers.referer;
        const proxyReq = http.request(
            { host: target.host, port: target.port, method: req.method, path: prefix + req.url, headers, timeout: 15000 },
            (proxyRes) => {
                res.writeHead(proxyRes.statusCode, proxyRes.headers);
                proxyRes.pipe(res);
            }
        );
        proxyReq.on("timeout", () => proxyReq.destroy(new Error("timeout")));
        proxyReq.on("error", () => {
            if (!res.headersSent) res.status(502).json({ error: "A szerver nem érhető el" });
            else res.destroy();
        });
        req.pipe(proxyReq);
    }

    const publicNode = (n, online) => ({
        id: n.id,
        name: n.name,
        local: !!n.local,
        host: n.host,
        port: n.port,
        online,
    });

    async function listOwnNodes() {
        return Promise.all(
            registry.nodes.map(async (n) => {
                if (n.local) return publicNode(n, true);
                let online = false;
                try {
                    online = (await getJson(n, "/api/ping")).status === 200;
                } catch {}
                return publicNode(n, online);
            })
        );
    }

    // ---------- Bejelentkezés ----------
    const authRouter = express.Router();
    let setupBusy = false;

    authRouter.get("/status", (req, res) => {
        auth.refresh();
        const s = auth.configured ? sessionOf(req) : null;
        res.json({ configured: auth.configured, authenticated: !!s, username: s ? s.user : null });
    });

    authRouter.post("/setup", express.json(), async (req, res) => {
        auth.refresh();
        if (auth.configured || setupBusy) return res.status(409).json({ error: "A felhasználó már be van állítva" });
        const { username, password } = req.body || {};
        const err = validateCredentials(username, password);
        if (err) return res.status(400).json({ error: err });
        setupBusy = true;
        try {
            await auth.set(username, password);
        } finally {
            setupBusy = false;
        }
        setSessionCookie(req, res, sessions.create(username));
        res.status(201).json({ username });
    });

    authRouter.post("/login", express.json(), async (req, res) => {
        auth.refresh();
        if (!auth.configured) return res.status(403).json({ error: "Először állítsd be a felhasználót", setup: true });
        const ip = req.socket.remoteAddress || "";
        if (loginLimiter.blocked(ip)) return res.status(429).json({ error: "Túl sok sikertelen próbálkozás, próbáld újra egy perc múlva" });
        const { username, password } = req.body || {};
        if (typeof username !== "string" || typeof password !== "string" || !(await auth.verify(username, password))) {
            loginLimiter.fail(ip);
            return res.status(401).json({ error: "Hibás felhasználónév vagy jelszó" });
        }
        loginLimiter.ok(ip);
        setSessionCookie(req, res, sessions.create(auth.username));
        res.json({ username: auth.username });
    });

    authRouter.post("/logout", (req, res) => {
        sessions.destroy(parseCookies(req.headers.cookie)[COOKIE]);
        setSessionCookie(req, res, "", 0);
        res.json({ ok: true });
    });

    authRouter.post("/password", express.json(), async (req, res) => {
        const id = parseCookies(req.headers.cookie)[COOKIE];
        if (!auth.configured || !sessions.get(id)) return res.status(401).json({ error: "Be kell jelentkezned", login: true });
        const ip = req.socket.remoteAddress || "";
        if (loginLimiter.blocked(`pw:${ip}`)) return res.status(429).json({ error: "Túl sok sikertelen próbálkozás, próbáld újra egy perc múlva" });
        const { current, password } = req.body || {};
        if (typeof current !== "string" || !(await auth.verify(auth.username, current))) {
            loginLimiter.fail(`pw:${ip}`);
            return res.status(400).json({ error: "A jelenlegi jelszó hibás" });
        }
        const err = validateCredentials(auth.username, password);
        if (err) return res.status(400).json({ error: err });
        await auth.set(auth.username, password);
        sessions.destroyAllExcept(id); // a többi munkamenet érvénytelenné válik
        res.json({ ok: true });
    });

    // Böngészős kérések védelme a CSRF ellen: módosító kérés csak a saját oldalról jöhet
    app.use("/api", (req, res, next) => {
        if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !sameOrigin(req)) {
            return res.status(403).json({ error: "Idegen eredetű kérés" });
        }
        next();
    });

    app.use("/api/auth", authRouter);

    // Innentől minden /api végpont bejelentkezést igényel
    app.use("/api", (req, res, next) => {
        auth.refresh();
        if (!auth.configured) return res.status(403).json({ error: "Először állítsd be a felhasználót", setup: true });
        if (!sessionOf(req)) return res.status(401).json({ error: "Be kell jelentkezned", login: true });
        next();
    });

    // ---------- Datacenterek listája (saját + összekötöttek) ----------
    async function remoteDcState(dc) {
        try {
            const r = await getJson(dc, "/fed/nodes", 3000);
            if (r.status === 200) {
                const d = JSON.parse(r.body);
                if (d.datacenter && d.datacenter !== dc.lastName) {
                    dc.lastName = d.datacenter;
                    saveRegistry();
                }
                return { online: true, name: d.datacenter, nodes: d.nodes || [] };
            }
            if (r.status === 401) return { online: false, name: dc.lastName, nodes: [], error: "A federációs token már nem érvényes" };
            if (r.status === 503) return { online: false, name: dc.lastName, nodes: [], error: "A másik szerver még nincs beállítva" };
        } catch {}
        return { online: false, name: dc.lastName, nodes: [] };
    }

    app.get("/api/dcs", async (req, res) => {
        const [ownNodes, remotes] = await Promise.all([
            listOwnNodes(),
            Promise.all(
                registry.dcs.map(async (dc) => {
                    const st = await remoteDcState(dc);
                    return {
                        id: dc.id,
                        name: st.name || dc.lastName || dc.host,
                        remote: true,
                        host: dc.host,
                        port: dc.port,
                        online: st.online,
                        error: st.error,
                        nodes: st.nodes,
                    };
                })
            ),
        ]);
        res.json({
            dcs: [{ id: "local", name: registry.datacenter, remote: false, online: true, nodes: ownNodes }, ...remotes],
        });
    });

    app.post("/api/dcs", express.json(), async (req, res) => {
        const b = req.body || {};
        const cand = {
            id: crypto.randomBytes(4).toString("hex"),
            host: String(b.host || "").trim(),
            port: Number(b.port || 3000),
            token: String(b.token || "").trim(),
        };

        if (!HOST_RE.test(cand.host)) return res.status(400).json({ error: "Érvénytelen cím" });
        if (!Number.isInteger(cand.port) || cand.port < 1 || cand.port > 65535) return res.status(400).json({ error: "Érvénytelen port" });
        if (!cand.token) return res.status(400).json({ error: "A federációs token kötelező" });
        if (safeEqual(cand.token, registry.fedToken)) return res.status(400).json({ error: "Ez a saját szervered tokenje" });
        if (registry.dcs.some((d) => d.host === cand.host && d.port === cand.port)) {
            return res.status(409).json({ error: "Ez a datacenter már össze van kötve" });
        }

        try {
            const r = await getJson(cand, "/fed/nodes", 4000);
            if (r.status === 401) return res.status(400).json({ error: "Hibás federációs token" });
            if (r.status === 503) return res.status(400).json({ error: "A másik szerver még nincs beállítva (előbb hozz létre rajta felhasználót)" });
            if (r.status !== 200) return res.status(400).json({ error: "A cím nem XenMox főszerver" });
            const d = JSON.parse(r.body);
            if (!d.datacenter || !Array.isArray(d.nodes)) return res.status(400).json({ error: "A cím nem XenMox főszerver" });
            cand.lastName = d.datacenter;
        } catch (err) {
            return res.status(400).json({ error: unreachable(err, "XenMox főszerver") });
        }

        registry.dcs.push(cand);
        saveRegistry();
        res.status(201).json({ id: cand.id, name: cand.lastName });
    });

    app.delete("/api/dcs/:did", (req, res) => {
        const dc = registry.dcs.find((d) => d.id === req.params.did);
        if (!dc) return res.status(404).json({ error: "Nincs ilyen datacenter" });
        registry.dcs = registry.dcs.filter((d) => d !== dc);
        saveRegistry();
        res.json({ ok: true });
    });

    // Összekötött datacenter node-jainak kezelése: /api/dcs/:did/nodes/:nid/...
    app.use("/api/dcs/:did", (req, res, next) => {
        if (req.url === "/" || req.url === "") return next();
        const dc = registry.dcs.find((d) => d.id === req.params.did);
        if (!dc) return res.status(404).json({ error: "Nincs ilyen datacenter" });
        streamProxy(req, res, dc, "/fed");
    });

    // ---------- Federációs token (más szerverek ezzel kapcsolódnak hozzánk) ----------
    app.get("/api/federation", (req, res) => res.json({ token: registry.fedToken }));

    app.post("/api/federation/regenerate", (req, res) => {
        registry.fedToken = crypto.randomBytes(24).toString("hex");
        saveRegistry();
        res.json({ token: registry.fedToken });
    });

    // ---------- Saját datacenter / node-ok kezelése ----------
    app.patch("/api/datacenter", express.json(), (req, res) => {
        const name = String((req.body && req.body.name) || "").trim();
        if (!DC_RE.test(name)) return res.status(400).json({ error: "Érvénytelen datacenter név" });
        registry.datacenter = name;
        saveRegistry();
        res.json({ datacenter: name });
    });

    app.post("/api/nodes", express.json(), async (req, res) => {
        const b = req.body || {};
        const cand = {
            id: crypto.randomBytes(4).toString("hex"),
            name: String(b.name || "").trim(),
            host: String(b.host || "").trim(),
            port: Number(b.port || 3001),
            username: String(b.username || "").trim(),
            password: typeof b.password === "string" ? b.password : "",
        };

        if (!NAME_RE.test(cand.name)) return res.status(400).json({ error: "Érvénytelen node név (betű, szám, . _ -)" });
        if (!HOST_RE.test(cand.host)) return res.status(400).json({ error: "Érvénytelen cím" });
        if (!Number.isInteger(cand.port) || cand.port < 1 || cand.port > 65535) return res.status(400).json({ error: "Érvénytelen port" });
        if (!cand.username || !cand.password) return res.status(400).json({ error: "A felhasználónév és a jelszó kötelező" });
        if (registry.nodes.some((n) => n.name.toLowerCase() === cand.name.toLowerCase())) {
            return res.status(409).json({ error: "Ilyen nevű node már van" });
        }
        if (registry.nodes.some((n) => n.host === cand.host && n.port === cand.port)) {
            return res.status(409).json({ error: "Ez a node már hozzá van adva" });
        }

        try {
            const r = await getJson(cand, "/api/ping", 4000);
            if (r.status === 401) return res.status(400).json({ error: "Hibás felhasználónév vagy jelszó" });
            if (r.status === 429) return res.status(400).json({ error: "A node túl sok sikertelen próbálkozást látott, próbáld újra később" });
            if (r.status === 503) return res.status(400).json({ error: "A con-server még nincs beállítva (futtasd rajta: npm run con-server -- --setup)" });
            if (r.status !== 200) return res.status(400).json({ error: "A cím nem xenmox-con-server" });
        } catch (err) {
            return res.status(400).json({ error: unreachable(err, "xenmox-con-server") });
        }

        registry.nodes.push(cand);
        saveRegistry();
        res.status(201).json(publicNode(cand, true));
    });

    app.patch("/api/nodes/:nid", express.json(), (req, res) => {
        const node = registry.nodes.find((n) => n.id === req.params.nid);
        if (!node) return res.status(404).json({ error: "Nincs ilyen node" });
        const name = String((req.body && req.body.name) || "").trim();
        if (!NAME_RE.test(name)) return res.status(400).json({ error: "Érvénytelen node név (betű, szám, . _ -)" });
        if (registry.nodes.some((n) => n !== node && n.name.toLowerCase() === name.toLowerCase())) {
            return res.status(409).json({ error: "Ilyen nevű node már van" });
        }
        node.name = name;
        saveRegistry();
        res.json(publicNode(node, true));
    });

    app.delete("/api/nodes/:nid", (req, res) => {
        const node = registry.nodes.find((n) => n.id === req.params.nid);
        if (!node) return res.status(404).json({ error: "Nincs ilyen node" });
        if (node.local) return res.status(400).json({ error: "A helyi node nem távolítható el" });
        registry.nodes = registry.nodes.filter((n) => n !== node);
        saveRegistry();
        res.json({ ok: true });
    });

    // ---------- Node API: a UI-nak (/api, munkamenettel) és más főszervereknek (/fed, tokennel) ----------
    // A /fed csak a saját node-okat adja ki, az összekötött datacentereket nem (nincs láncolás/hurok),
    // és a kezelő műveleteket (átnevezés, node hozzáadás) sem tartalmazza.
    const nodeApi = express.Router();

    nodeApi.get("/nodes", async (req, res) => {
        let nodes = await listOwnNodes();
        if (req.baseUrl === "/fed") nodes = nodes.map(({ host, port, ...rest }) => rest);
        res.json({ datacenter: registry.datacenter, nodes });
    });

    nodeApi.use("/nodes/:nid", (req, res, next) => {
        if (req.url === "/" || req.url === "") return next();
        const node = registry.nodes.find((n) => n.id === req.params.nid);
        if (!node) return res.status(404).json({ error: "Nincs ilyen node" });
        if (node.local) return local.router(req, res, next);
        streamProxy(req, res, node, "/api");
    });

    app.use("/api", nodeApi);
    app.use("/fed", requireFedToken, nodeApi);

    app.use((req, res) => res.status(404).json({ error: "Nincs ilyen útvonal" }));

    // ---------- Indítás ----------
    const server = app.listen(PORT, () => {
        console.log(`XenMox fut: http://localhost:${PORT}`);
        if (!auth.configured) {
            console.log("Még nincs felhasználó beállítva: nyisd meg a webes felületet, és hozd létre az adminisztrátort");
            console.log("(vagy parancssorból: npm start -- --setup). Addig minden API kérés elutasításra kerül.");
        }
    });

    // ---------- noVNC: WebSocket híd ----------
    const wss = new WebSocketServer({ noServer: true });

    const rejectUpgrade = (socket, code, text) => {
        socket.write(`HTTP/1.1 ${code} ${text}\r\n\r\n`);
        socket.destroy();
    };

    // Továbbítás egy távoli szerver WebSocketjére (con-server vagy másik főszerver)
    function pipeRemote(req, socket, head, url, target) {
        let opened = false;
        const remote = new WebSocket(url, { headers: { Authorization: authHeaderFor(target) }, handshakeTimeout: 5000 });

        remote.once("open", () => {
            opened = true;
            wss.handleUpgrade(req, socket, head, (ws) => {
                remote.on("message", (d, isBinary) => ws.readyState === 1 && ws.send(d, { binary: isBinary }));
                ws.on("message", (d, isBinary) => remote.readyState === 1 && remote.send(d, { binary: isBinary }));
                remote.on("close", () => ws.close());
                ws.on("close", () => remote.close());
                remote.on("error", () => ws.close());
                ws.on("error", () => remote.close());
            });
        });

        remote.on("error", () => {
            if (opened || socket.destroyed) return;
            rejectUpgrade(socket, 502, "Bad Gateway");
        });
    }

    // Saját node VNC-je: helyi vagy con-serveren keresztül
    function bridgeOwnNode(req, socket, head, nodeId, vmId) {
        const node = registry.nodes.find((n) => n.id === nodeId);
        if (!node) return rejectUpgrade(socket, 404, "Not Found");
        if (node.local) return local.handleVncUpgrade(req, socket, head, vmId);
        pipeRemote(req, socket, head, `ws://${node.host}:${node.port}/api/vms/${vmId}/vnc`, node);
    }

    server.on("upgrade", (req, socket, head) => {
        const url = req.url.split("?")[0];
        let m;
        auth.refresh();

        // /api: csak bejelentkezett felhasználó, saját oldalról (WebSocket-eltérítés ellen)
        if (url.startsWith("/api/")) {
            if (!auth.configured) return rejectUpgrade(socket, 403, "Forbidden");
            if (!sameOrigin(req)) return rejectUpgrade(socket, 403, "Forbidden");
            if (!sessionOf(req)) return rejectUpgrade(socket, 401, "Unauthorized");
        }

        if ((m = /^\/api\/nodes\/([A-Za-z0-9_-]+)\/vms\/(\d+)\/vnc$/.exec(url))) {
            return bridgeOwnNode(req, socket, head, m[1], Number(m[2]));
        }
        if ((m = /^\/fed\/nodes\/([A-Za-z0-9_-]+)\/vms\/(\d+)\/vnc$/.exec(url))) {
            if (!fedAuthOk(req)) return rejectUpgrade(socket, 401, "Unauthorized");
            return bridgeOwnNode(req, socket, head, m[1], Number(m[2]));
        }
        if ((m = /^\/api\/dcs\/([A-Za-z0-9_-]+)\/nodes\/([A-Za-z0-9_-]+)\/vms\/(\d+)\/vnc$/.exec(url))) {
            const dc = registry.dcs.find((d) => d.id === m[1]);
            if (!dc) return rejectUpgrade(socket, 404, "Not Found");
            return pipeRemote(req, socket, head, `ws://${dc.host}:${dc.port}/fed/nodes/${m[2]}/vms/${m[3]}/vnc`, dc);
        }
        rejectUpgrade(socket, 404, "Not Found");
    });

    for (const sig of ["SIGINT", "SIGTERM"]) {
        process.on(sig, () => {
            local.stopAll();
            process.exit(0);
        });
    }
}
