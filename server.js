"use strict";
/**
 * XenMox main server: web interface (with login) + local node + remote nodes (xenmox-con-server)
 * + displaying the datacenters of other XenMox main servers (federation).
 *
 * On first use, a user must be set up in the web interface (or from the command line: npm start -- --setup).
 * Until then, the server rejects every API request.
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
    runSetup(auth, "XenMox main server").then(() => process.exit(0));
} else {
    start();
}

function start() {
    // ---------- Registry: datacenter, nodes, linked datacenters ----------
    const REG_FILE = path.join(DATA_DIR, "nodes.json");
    let registry = fs.existsSync(REG_FILE)
        ? JSON.parse(fs.readFileSync(REG_FILE, "utf8"))
        : { datacenter: "prod-eu-central", nodes: [] };
    if (!registry.nodes.some((n) => n.local)) registry.nodes.unshift({ id: "local", name: "prod1", local: true });
    if (!Array.isArray(registry.dcs)) registry.dcs = []; // linked remote datacenters
    if (!registry.fedToken) registry.fedToken = crypto.randomBytes(24).toString("hex"); // others can connect to us with this
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

    // The files of the login interface (and the noVNC directory) are public and contain no secrets
    app.use(express.static(path.join(__dirname, "public")));
    app.use("/novnc", express.static(path.join(__dirname, "node_modules", "@novnc", "novnc")));

    // ---------- Helpers ----------
    // Authorization header for the target server: con-server → Basic (user/password), other main server → Bearer (federation token)
    function authHeaderFor(target) {
        if (target.username) return "Basic " + Buffer.from(`${target.username}:${target.password}`).toString("base64");
        return `Bearer ${target.token}`;
    }

    function sessionOf(req) {
        return sessions.get(parseCookies(req.headers.cookie)[COOKIE]);
    }

    function sameOrigin(req) {
        const origin = req.headers.origin;
        if (!origin) return true; // non-browser client
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
        if (!auth.configured) return res.status(503).json({ error: "The server is not configured yet", setup: true });
        if (fedAuthOk(req)) return next();
        res.status(401).json({ error: "Invalid or missing federation token" });
    }

    // GET to a remote server (con-server or another main server)
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
            ? `Connection refused – is ${what} running on this port?`
            : "The server is unreachable (address, port, firewall?)";

    // Forwards the request as a stream (so ISO uploads are not buffered either). The browser cookie is not forwarded.
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
            if (!res.headersSent) res.status(502).json({ error: "The server is unreachable" });
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

    // ---------- Login ----------
    const authRouter = express.Router();
    let setupBusy = false;

    authRouter.get("/status", (req, res) => {
        auth.refresh();
        const s = auth.configured ? sessionOf(req) : null;
        res.json({ configured: auth.configured, authenticated: !!s, username: s ? s.user : null });
    });

    authRouter.post("/setup", express.json(), async (req, res) => {
        auth.refresh();
        if (auth.configured || setupBusy) return res.status(409).json({ error: "The user is already set up" });
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
        if (!auth.configured) return res.status(403).json({ error: "Set up the user first", setup: true });
        const ip = req.socket.remoteAddress || "";
        if (loginLimiter.blocked(ip)) return res.status(429).json({ error: "Too many failed attempts, try again in a minute" });
        const { username, password } = req.body || {};
        if (typeof username !== "string" || typeof password !== "string" || !(await auth.verify(username, password))) {
            loginLimiter.fail(ip);
            return res.status(401).json({ error: "Invalid username or password" });
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
        if (!auth.configured || !sessions.get(id)) return res.status(401).json({ error: "You must log in", login: true });
        const ip = req.socket.remoteAddress || "";
        if (loginLimiter.blocked(`pw:${ip}`)) return res.status(429).json({ error: "Too many failed attempts, try again in a minute" });
        const { current, password } = req.body || {};
        if (typeof current !== "string" || !(await auth.verify(auth.username, current))) {
            loginLimiter.fail(`pw:${ip}`);
            return res.status(400).json({ error: "The current password is incorrect" });
        }
        const err = validateCredentials(auth.username, password);
        if (err) return res.status(400).json({ error: err });
        await auth.set(auth.username, password);
        sessions.destroyAllExcept(id); // the other sessions become invalid
        res.json({ ok: true });
    });

    // Protect browser requests against CSRF: modifying requests may only come from our own page
    app.use("/api", (req, res, next) => {
        if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !sameOrigin(req)) {
            return res.status(403).json({ error: "Request from a foreign origin" });
        }
        next();
    });

    app.use("/api/auth", authRouter);

    // From here on, every /api endpoint requires login
    app.use("/api", (req, res, next) => {
        auth.refresh();
        if (!auth.configured) return res.status(403).json({ error: "Set up the user first", setup: true });
        if (!sessionOf(req)) return res.status(401).json({ error: "You must log in", login: true });
        next();
    });

    // ---------- List of datacenters (own + linked) ----------
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
            if (r.status === 401) return { online: false, name: dc.lastName, nodes: [], error: "The federation token is no longer valid" };
            if (r.status === 503) return { online: false, name: dc.lastName, nodes: [], error: "The other server is not configured yet" };
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

        if (!HOST_RE.test(cand.host)) return res.status(400).json({ error: "Invalid address" });
        if (!Number.isInteger(cand.port) || cand.port < 1 || cand.port > 65535) return res.status(400).json({ error: "Invalid port" });
        if (!cand.token) return res.status(400).json({ error: "The federation token is required" });
        if (safeEqual(cand.token, registry.fedToken)) return res.status(400).json({ error: "This is your own server's token" });
        if (registry.dcs.some((d) => d.host === cand.host && d.port === cand.port)) {
            return res.status(409).json({ error: "This datacenter is already linked" });
        }

        try {
            const r = await getJson(cand, "/fed/nodes", 4000);
            if (r.status === 401) return res.status(400).json({ error: "Invalid federation token" });
            if (r.status === 503) return res.status(400).json({ error: "The other server is not configured yet (create a user on it first)" });
            if (r.status !== 200) return res.status(400).json({ error: "The address is not a XenMox main server" });
            const d = JSON.parse(r.body);
            if (!d.datacenter || !Array.isArray(d.nodes)) return res.status(400).json({ error: "The address is not a XenMox main server" });
            cand.lastName = d.datacenter;
        } catch (err) {
            return res.status(400).json({ error: unreachable(err, "XenMox main server") });
        }

        registry.dcs.push(cand);
        saveRegistry();
        res.status(201).json({ id: cand.id, name: cand.lastName });
    });

    app.delete("/api/dcs/:did", (req, res) => {
        const dc = registry.dcs.find((d) => d.id === req.params.did);
        if (!dc) return res.status(404).json({ error: "No such datacenter" });
        registry.dcs = registry.dcs.filter((d) => d !== dc);
        saveRegistry();
        res.json({ ok: true });
    });

    // Managing the nodes of a linked datacenter: /api/dcs/:did/nodes/:nid/...
    app.use("/api/dcs/:did", (req, res, next) => {
        if (req.url === "/" || req.url === "") return next();
        const dc = registry.dcs.find((d) => d.id === req.params.did);
        if (!dc) return res.status(404).json({ error: "No such datacenter" });
        streamProxy(req, res, dc, "/fed");
    });

    // ---------- Federation token (other servers connect to us with this) ----------
    app.get("/api/federation", (req, res) => res.json({ token: registry.fedToken }));

    app.post("/api/federation/regenerate", (req, res) => {
        registry.fedToken = crypto.randomBytes(24).toString("hex");
        saveRegistry();
        res.json({ token: registry.fedToken });
    });

    // ---------- Managing the own datacenter / nodes ----------
    app.patch("/api/datacenter", express.json(), (req, res) => {
        const name = String((req.body && req.body.name) || "").trim();
        if (!DC_RE.test(name)) return res.status(400).json({ error: "Invalid datacenter name" });
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

        if (!NAME_RE.test(cand.name)) return res.status(400).json({ error: "Invalid node name (letters, digits, . _ -)" });
        if (!HOST_RE.test(cand.host)) return res.status(400).json({ error: "Invalid address" });
        if (!Number.isInteger(cand.port) || cand.port < 1 || cand.port > 65535) return res.status(400).json({ error: "Invalid port" });
        if (!cand.username || !cand.password) return res.status(400).json({ error: "The username and password are required" });
        if (registry.nodes.some((n) => n.name.toLowerCase() === cand.name.toLowerCase())) {
            return res.status(409).json({ error: "A node with this name already exists" });
        }
        if (registry.nodes.some((n) => n.host === cand.host && n.port === cand.port)) {
            return res.status(409).json({ error: "This node has already been added" });
        }

        try {
            const r = await getJson(cand, "/api/ping", 4000);
            if (r.status === 401) return res.status(400).json({ error: "Invalid username or password" });
            if (r.status === 429) return res.status(400).json({ error: "The node has seen too many failed attempts, try again later" });
            if (r.status === 503) return res.status(400).json({ error: "The con-server is not configured yet (run on it: npm run con-server -- --setup)" });
            if (r.status !== 200) return res.status(400).json({ error: "The address is not a xenmox-con-server" });
        } catch (err) {
            return res.status(400).json({ error: unreachable(err, "xenmox-con-server") });
        }

        registry.nodes.push(cand);
        saveRegistry();
        res.status(201).json(publicNode(cand, true));
    });

    app.patch("/api/nodes/:nid", express.json(), (req, res) => {
        const node = registry.nodes.find((n) => n.id === req.params.nid);
        if (!node) return res.status(404).json({ error: "No such node" });
        const name = String((req.body && req.body.name) || "").trim();
        if (!NAME_RE.test(name)) return res.status(400).json({ error: "Invalid node name (letters, digits, . _ -)" });
        if (registry.nodes.some((n) => n !== node && n.name.toLowerCase() === name.toLowerCase())) {
            return res.status(409).json({ error: "A node with this name already exists" });
        }
        node.name = name;
        saveRegistry();
        res.json(publicNode(node, true));
    });

    app.delete("/api/nodes/:nid", (req, res) => {
        const node = registry.nodes.find((n) => n.id === req.params.nid);
        if (!node) return res.status(404).json({ error: "No such node" });
        if (node.local) return res.status(400).json({ error: "The local node cannot be removed" });
        registry.nodes = registry.nodes.filter((n) => n !== node);
        saveRegistry();
        res.json({ ok: true });
    });

    // ---------- Node API: for the UI (/api, with a session) and for other main servers (/fed, with a token) ----------
    // /fed only exposes the own nodes, not the linked datacenters (no chaining/loops),
    // and does not include the management operations (renaming, adding nodes) either.
    const nodeApi = express.Router();

    nodeApi.get("/nodes", async (req, res) => {
        let nodes = await listOwnNodes();
        if (req.baseUrl === "/fed") nodes = nodes.map(({ host, port, ...rest }) => rest);
        res.json({ datacenter: registry.datacenter, nodes });
    });

    nodeApi.use("/nodes/:nid", (req, res, next) => {
        if (req.url === "/" || req.url === "") return next();
        const node = registry.nodes.find((n) => n.id === req.params.nid);
        if (!node) return res.status(404).json({ error: "No such node" });
        if (node.local) return local.router(req, res, next);
        streamProxy(req, res, node, "/api");
    });

    app.use("/api", nodeApi);
    app.use("/fed", requireFedToken, nodeApi);

    app.use((req, res) => res.status(404).json({ error: "No such route" }));

    // ---------- Startup ----------
    const server = app.listen(PORT, () => {
        console.log(`XenMox running: http://localhost:${PORT}`);
        if (!auth.configured) {
            console.log("No user configured yet: open the web interface and create the administrator");
            console.log("(or from the command line: npm start -- --setup). Until then every API request is rejected.");
        }
    });

    // ---------- noVNC: WebSocket bridge ----------
    const wss = new WebSocketServer({ noServer: true });

    const rejectUpgrade = (socket, code, text) => {
        socket.write(`HTTP/1.1 ${code} ${text}\r\n\r\n`);
        socket.destroy();
    };

    // Forwards to a remote server's WebSocket (con-server or another main server)
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

    // Own node VNC: locally or through a con-server
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

        // /api: only a logged-in user, from our own page (against WebSocket hijacking)
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
