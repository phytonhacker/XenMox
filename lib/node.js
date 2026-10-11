"use strict";
/**
 * Egy XenMox "node" logikája: ISO-k, VM-ek, QEMU folyamatok, VNC híd.
 * Ezt használja a főszerver (helyi node-ként) és a xenmox-con-server is.
 */
const express = require("express");
const multer = require("multer");
const { spawn, execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const net = require("net");
const os = require("os");
const { WebSocketServer } = require("ws");

function createNode({ dataDir, qemuBin = "qemu-system-x86_64", dockerBin = process.env.DOCKER_BIN || "docker" }) {
    const ISO_DIR = path.join(dataDir, "isos");
    const DISK_DIR = path.join(dataDir, "disks");
    const DB_FILE = path.join(dataDir, "vms.json");
    for (const dir of [ISO_DIR, DISK_DIR]) fs.mkdirSync(dir, { recursive: true });

    let vms = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, "utf8")) : [];
    const saveDb = () => fs.writeFileSync(DB_FILE, JSON.stringify(vms, null, 2));
    const running = new Map(); // vm id -> child process

    // ---------- Segédek ----------
    function safeIsoName(name) {
        const clean = path.basename(String(name)).replace(/[^A-Za-z0-9._-]/g, "_");
        return clean.toLowerCase().endsWith(".iso") ? clean : null;
    }
    const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
    const vncPortOf = (vm) => 5900 + (vm.id - 100);
    const publicVm = (vm) => ({
        ...vm,
        status: running.has(vm.id) ? "running" : "stopped",
        vncPort: vncPortOf(vm),
    });

    const router = express.Router();
    router.use(express.json());

    router.get("/ping", (req, res) => res.json({ ok: true, hostname: os.hostname() }));

    // ---------- ISO kezelés ----------
    const upload = multer({
        storage: multer.diskStorage({
            destination: ISO_DIR,
            filename: (req, file, cb) => cb(null, safeIsoName(file.originalname) || "invalid"),
        }),
        fileFilter: (req, file, cb) => {
            if (!safeIsoName(file.originalname)) return cb(new Error("Csak .iso fájl tölthető fel"));
            cb(null, true);
        },
    });

    router.get("/isos", (req, res) => {
        const files = fs
            .readdirSync(ISO_DIR)
            .filter((f) => f.toLowerCase().endsWith(".iso"))
            .map((f) => ({ name: f, size: fs.statSync(path.join(ISO_DIR, f)).size }));
        res.json(files);
    });

    router.post("/isos", upload.single("iso"), (req, res) => {
        if (!req.file) return res.status(400).json({ error: "Nincs feltöltött fájl" });
        res.json({ name: req.file.filename, size: req.file.size });
    });

    router.delete("/isos/:name", (req, res) => {
        const name = safeIsoName(req.params.name);
        const file = name && path.join(ISO_DIR, name);
        if (!file || !fs.existsSync(file)) return res.status(404).json({ error: "Nincs ilyen ISO" });
        fs.unlinkSync(file);
        res.json({ ok: true });
    });

    // ---------- VM-ek ----------
    router.get("/vms", (req, res) => res.json(vms.map(publicVm)));

    router.post("/vms", (req, res) => {
        const b = req.body || {};
        const vm = {
            id: Number(b.id),
            name: String(b.name || ""),
            iso: b.iso ? String(b.iso) : "",
            os: String(b.os || "Linux"),
            disk: Number(b.disk),
            sockets: Number(b.sockets),
            cores: Number(b.cores),
            mem: Number(b.mem),
            model: String(b.model || "virtio"),
        };

        if (!isInt(vm.id, 100, 999)) return res.status(400).json({ error: "A VM ID 100 és 999 között lehet" });
        if (vms.some((v) => v.id === vm.id)) return res.status(409).json({ error: "Ez a VM ID már foglalt" });
        if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/.test(vm.name)) return res.status(400).json({ error: "Érvénytelen név (betű, szám, kötőjel)" });
        if (!["Linux", "Windows", "Other"].includes(vm.os)) return res.status(400).json({ error: "Érvénytelen OS" });
        if (!["virtio", "e1000"].includes(vm.model)) return res.status(400).json({ error: "Érvénytelen hálókártya modell" });
        if (!isInt(vm.disk, 1, 4096)) return res.status(400).json({ error: "A lemez 1 és 4096 GiB között lehet" });
        if (!isInt(vm.sockets, 1, 8)) return res.status(400).json({ error: "A socketek száma 1 és 8 között lehet" });
        if (!isInt(vm.cores, 1, 64)) return res.status(400).json({ error: "A magok száma 1 és 64 között lehet" });
        if (!isInt(vm.mem, 64, 1048576)) return res.status(400).json({ error: "A memória 64 MiB és 1 TiB között lehet" });
        if (vm.iso) {
            const iso = safeIsoName(vm.iso);
            if (!iso || iso !== vm.iso || !fs.existsSync(path.join(ISO_DIR, iso))) {
                return res.status(400).json({ error: "A kiválasztott ISO nem létezik" });
            }
        }

        const diskPath = path.join(DISK_DIR, `vm-${vm.id}.qcow2`);
        execFile("qemu-img", ["create", "-f", "qcow2", diskPath, `${vm.disk}G`], (err) => {
            if (err) {
                const msg = err.code === "ENOENT" ? "A qemu-img nincs telepítve" : "Nem sikerült létrehozni a lemezt";
                return res.status(500).json({ error: msg });
            }
            vms.push(vm);
            saveDb();
            res.status(201).json(publicVm(vm));
        });
    });

    function findVm(req, res) {
        const vm = vms.find((v) => v.id === Number(req.params.id));
        if (!vm) res.status(404).json({ error: "Nincs ilyen VM" });
        return vm;
    }

    router.post("/vms/:id/start", (req, res) => {
        const vm = findVm(req, res);
        if (!vm) return;
        if (running.has(vm.id)) return res.status(409).json({ error: "A VM már fut" });

        const diskPath = path.join(DISK_DIR, `vm-${vm.id}.qcow2`);
        const args = [
            "-name", vm.name,
            "-machine", "q35",
            "-m", String(vm.mem),
            "-smp", `sockets=${vm.sockets},cores=${vm.cores}`,
            "-drive", `file=${diskPath},format=qcow2,if=${vm.os === "Linux" ? "virtio" : "ide"}`,
            "-nic", `user,model=${vm.model === "virtio" ? "virtio-net-pci" : "e1000"}`,
            "-vga", "std",
            "-vnc", `127.0.0.1:${vm.id - 100}`,
        ];

        if (fs.existsSync("/dev/kvm")) args.push("-accel", "kvm", "-cpu", "host");
        else args.push("-accel", "tcg", "-cpu", "qemu64");

        if (vm.iso) args.push("-cdrom", path.join(ISO_DIR, vm.iso), "-boot", "order=dc");

        const child = spawn(qemuBin, args, { stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        child.stderr.on("data", (d) => (stderr += d));

        child.once("error", (err) => {
            running.delete(vm.id);
            const msg = err.code === "ENOENT" ? `A ${qemuBin} nincs telepítve` : err.message;
            if (!res.headersSent) res.status(500).json({ error: msg });
        });

        child.once("spawn", () => {
            running.set(vm.id, child);
            res.json(publicVm(vm));
        });

        child.on("exit", (code) => {
            running.delete(vm.id);
            if (code) console.error(`VM ${vm.id} kilépett (${code}): ${stderr.trim()}`);
        });
    });

    router.post("/vms/:id/stop", (req, res) => {
        const vm = findVm(req, res);
        if (!vm) return;
        const child = running.get(vm.id);
        if (!child) return res.status(409).json({ error: "A VM nem fut" });
        child.kill("SIGTERM");
        res.json({ ok: true });
    });

    router.delete("/vms/:id", (req, res) => {
        const vm = findVm(req, res);
        if (!vm) return;
        if (running.has(vm.id)) return res.status(409).json({ error: "Futó VM nem törölhető" });
        fs.rmSync(path.join(DISK_DIR, `vm-${vm.id}.qcow2`), { force: true });
        vms = vms.filter((v) => v.id !== vm.id);
        saveDb();
        res.json({ ok: true });
    });

    // ---------- Docker konténerek ----------
    // Csak a XenMox által létrehozott (xenmox.managed=true címkés) konténereket kezeljük.
    // Minden docker hívás execFile/spawn argumentumlistával megy (nincs shell), a bemenetek szigorúan validáltak.
    const CT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
    const IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/;
    const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*=[^\r\n\0]{0,4096}$/;
    const VOL_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}:\/[A-Za-z0-9_./-]{0,200}$/;
    const PORT_RE = /^(\d{1,5}):(\d{1,5})(?:\/(tcp|udp))?$/;
    const RESTARTS = ["no", "always", "unless-stopped", "on-failure"];
    const MAX_OUT = 4 * 1024 * 1024;
    const pending = new Map(); // név -> {image, state: "creating" | "error", error}

    function runDocker(args, timeoutMs = 30000) {
        return new Promise((resolve) => {
            const child = spawn(dockerBin, args, { stdio: ["ignore", "pipe", "pipe"] });
            let out = "";
            let err = "";
            let all = "";
            const cap = (s) => (s.length > MAX_OUT ? s.slice(-MAX_OUT) : s);
            const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
            child.stdout.on("data", (d) => { out = cap(out + d); all = cap(all + d); });
            child.stderr.on("data", (d) => { err = cap(err + d); all = cap(all + d); });
            child.on("error", (e) => {
                clearTimeout(timer);
                resolve({ code: -1, out, err: e.message, all, error: e });
            });
            child.on("close", (code) => {
                clearTimeout(timer);
                resolve({ code, out, err, all });
            });
        });
    }

    function lastLine(text) {
        const lines = String(text).split("\n").map((l) => l.trim()).filter(Boolean);
        return (lines[lines.length - 1] || "").slice(0, 300);
    }

    function dockerErr(r) {
        const text = (r.err || "").trim();
        if (r.error && r.error.code === "ENOENT") return { status: 503, msg: "A Docker nincs telepítve ezen a node-on" };
        if (/permission denied/i.test(text)) return { status: 503, msg: "Nincs jogosultság a Dockerhez (futtasd rootként, vagy add a felhasználót a docker csoporthoz)" };
        if (/cannot connect to the docker daemon|is the docker daemon running|failed to connect to the docker api|daemon is running/i.test(text)) return { status: 503, msg: "A Docker szolgáltatás nem fut ezen a node-on" };
        if (/no such (container|object)/i.test(text)) return { status: 404, msg: "Nincs ilyen konténer" };
        return { status: 500, msg: lastLine(text) || "Docker hiba" };
    }

    const sendDockerErr = (res, r) => {
        const e = dockerErr(r);
        res.status(e.status).json({ error: e.msg });
    };

    // Ellenőrzi a nevet, és hogy a konténer a XenMox-é-e; hiba esetén maga válaszol
    async function managedOr(res, name) {
        if (!CT_NAME_RE.test(name)) {
            res.status(400).json({ error: "Érvénytelen konténer név" });
            return false;
        }
        const r = await runDocker(["inspect", "--type", "container", "--format", '{{index .Config.Labels "xenmox.managed"}}', name]);
        if (r.code !== 0) {
            sendDockerErr(res, r);
            return false;
        }
        if (r.out.trim() !== "true") {
            res.status(403).json({ error: "Ez a konténer nem a XenMox-ban készült" });
            return false;
        }
        return true;
    }

    function buildRunArgs(b) {
        const name = String(b.name || "").trim();
        const image = String(b.image || "").trim();
        const restart = String(b.restart || "unless-stopped");
        const list = (v) => (Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean) : []);
        const ports = list(b.ports);
        const env = list(b.env);
        const volumes = list(b.volumes);
        const memory = b.memory === "" || b.memory == null ? null : Number(b.memory);
        const cpus = b.cpus === "" || b.cpus == null ? null : Number(b.cpus);

        if (!CT_NAME_RE.test(name)) return { error: "Érvénytelen konténer név (betű, szám, . _ -)" };
        if (!IMAGE_RE.test(image)) return { error: "Érvénytelen image név (pl. nginx:latest)" };
        if (!RESTARTS.includes(restart)) return { error: "Érvénytelen újraindítási szabály" };
        if (ports.length > 50 || env.length > 50 || volumes.length > 50) return { error: "Túl sok port/változó/kötet (max. 50)" };
        if (memory !== null && !(Number.isInteger(memory) && memory >= 6 && memory <= 1048576)) return { error: "A memória 6 és 1048576 MiB között lehet" };
        if (cpus !== null && !(Number.isFinite(cpus) && cpus >= 0.01 && cpus <= 256)) return { error: "A CPU limit 0.01 és 256 között lehet" };

        const args = ["run", "-d", "--name", name, "--label", "xenmox.managed=true", "--restart", restart];
        if (memory !== null) args.push("--memory", `${memory}m`);
        if (cpus !== null) args.push("--cpus", String(cpus));

        for (const p of ports) {
            const m = PORT_RE.exec(p);
            const hp = m && Number(m[1]);
            const cp = m && Number(m[2]);
            if (!m || hp < 1 || hp > 65535 || cp < 1 || cp > 65535) return { error: `Érvénytelen port: "${p}" (forma: 8080:80 vagy 8080:80/udp)` };
            args.push("-p", `${hp}:${cp}/${m[3] || "tcp"}`);
        }
        for (const e of env) {
            if (!ENV_RE.test(e)) return { error: `Érvénytelen környezeti változó: "${e.slice(0, 40)}" (forma: KULCS=érték)` };
            args.push("-e", e);
        }
        for (const v of volumes) {
            if (!VOL_RE.test(v)) return { error: `Érvénytelen kötet: "${v}" (forma: kotetnev:/utvonal)` };
            args.push("-v", v);
        }
        args.push(image);
        return { name, image, args };
    }

    router.get("/containers", async (req, res) => {
        const r = await runDocker(["ps", "-a", "--filter", "label=xenmox.managed=true", "--no-trunc", "--format", "{{json .}}"]);
        if (r.code !== 0) return sendDockerErr(res, r);

        const list = [];
        for (const line of r.out.split("\n").filter(Boolean)) {
            try {
                const j = JSON.parse(line);
                list.push({ name: j.Names, image: j.Image, state: j.State, status: j.Status, ports: j.Ports || "" });
            } catch {}
        }
        for (const [name, p] of pending) {
            if (list.some((c) => c.name === name)) continue;
            list.push({
                name,
                image: p.image,
                state: p.state,
                status: p.state === "error" ? "hiba a létrehozáskor" : "létrehozás folyamatban (image letöltése)",
                ports: "",
                error: p.error,
            });
        }
        list.sort((a, b) => a.name.localeCompare(b.name));
        res.json(list);
    });

    router.post("/containers", async (req, res) => {
        const built = buildRunArgs(req.body || {});
        if (built.error) return res.status(400).json({ error: built.error });
        const { name, image, args } = built;

        if (pending.has(name)) return res.status(409).json({ error: "Ilyen nevű konténer létrehozása már folyamatban van" });
        const exists = await runDocker(["inspect", "--type", "container", name]);
        if (exists.code === 0) return res.status(409).json({ error: "Ilyen nevű konténer már létezik" });
        if (exists.error) return sendDockerErr(res, exists);
        if (/permission denied|cannot connect|failed to connect|daemon is running/i.test(exists.err)) return sendDockerErr(res, exists);

        // Az image letöltése sokáig tarthat, ezért a háttérben fut, a kérés azonnal válaszol
        pending.set(name, { image, state: "creating", error: "" });
        runDocker(args, 15 * 60 * 1000).then((r) => {
            if (r.code === 0) pending.delete(name);
            else pending.set(name, { image, state: "error", error: (r.err || r.out || "Ismeretlen hiba").trim().slice(-1500) });
        });
        res.status(202).json({ name, state: "creating" });
    });

    router.get("/containers/:name/logs", async (req, res) => {
        const name = req.params.name;
        if (pending.has(name)) {
            const p = pending.get(name);
            return res.json({ logs: p.state === "error" ? p.error : "A konténer létrehozása folyamatban (az image letöltése eltarthat egy ideig)..." });
        }
        if (!(await managedOr(res, name))) return;
        const tail = Math.min(Math.max(parseInt(req.query.tail, 10) || 300, 1), 2000);
        const r = await runDocker(["logs", "--tail", String(tail), "--timestamps", name]);
        if (r.code !== 0) return sendDockerErr(res, r);
        res.json({ logs: r.all });
    });

    router.post("/containers/:name/:action(start|stop|restart)", async (req, res) => {
        const name = req.params.name;
        if (pending.has(name)) return res.status(409).json({ error: "A konténer még nem áll készen" });
        if (!(await managedOr(res, name))) return;
        const action = req.params.action;
        const args = action === "start" ? ["start", name] : [action, "-t", "10", name];
        const r = await runDocker(args, 60000);
        if (r.code !== 0) return sendDockerErr(res, r);
        res.json({ ok: true });
    });

    router.delete("/containers/:name", async (req, res) => {
        const name = req.params.name;
        const p = pending.get(name);
        if (p) {
            if (p.state === "creating") return res.status(409).json({ error: "A konténer létrehozása még folyamatban van" });
            pending.delete(name); // hibás létrehozás nyomának eltávolítása
            return res.json({ ok: true });
        }
        if (!(await managedOr(res, name))) return;
        const r = await runDocker(["rm", "-f", name], 60000);
        if (r.code !== 0) return sendDockerErr(res, r);
        res.json({ ok: true });
    });

    router.use((err, req, res, next) => {
        res.status(400).json({ error: err.message });
    });

    // ---------- VNC: WebSocket <-> TCP híd ----------
    const wss = new WebSocketServer({ noServer: true });

    function handleVncUpgrade(req, socket, head, vmId) {
        const vm = vms.find((v) => v.id === vmId);
        if (!vm || !running.has(vm.id)) {
            socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
            return socket.destroy();
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
            const tcp = net.connect(vncPortOf(vm), "127.0.0.1");
            tcp.on("data", (d) => ws.readyState === 1 && ws.send(d));
            tcp.on("close", () => ws.close());
            tcp.on("error", () => ws.close());
            ws.on("message", (d) => tcp.writable && tcp.write(d));
            ws.on("close", () => tcp.destroy());
            ws.on("error", () => tcp.destroy());
        });
    }

    function stopAll() {
        for (const child of running.values()) child.kill("SIGTERM");
    }

    return { router, handleVncUpgrade, stopAll };
}

module.exports = { createNode };
