"use strict";
/**
 * Egy XenMox "node" logikája: ISO-k, VM-ek (QEMU), Docker konténerek, statisztikák, VNC híd.
 * Ezt használja a főszerver (helyi node-ként) és a xenmox-con-server is.
 */
const express = require("express");
const multer = require("multer");
const { spawn, execFile, execFileSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const net = require("net");
const os = require("os");
const { WebSocketServer } = require("ws");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- QMP / QGA (JSON soros unix socket) kliens ----------
// fn({send, read}) kapja a kapcsolatot; hiba esetén (idő túllépés, lezárt kapcsolat) elutasít.
function withSocket(socketPath, timeoutMs, fn) {
    return new Promise((resolve, reject) => {
        const sock = net.connect(socketPath);
        const lines = [];
        let buf = "";
        let waiter = null;
        let timer = null;
        let done = false;

        const finish = (err, val) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            sock.destroy();
            err ? reject(err) : resolve(val);
        };
        const deliver = () => {
            while (waiter && lines.length) {
                const w = waiter;
                waiter = null;
                w(lines.shift());
            }
        };

        timer = setTimeout(() => finish(new Error("timeout")), timeoutMs);
        sock.setEncoding("utf8");
        sock.on("data", (d) => {
            buf += d;
            let i;
            while ((i = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, i).trim();
                buf = buf.slice(i + 1);
                if (!line) continue;
                try {
                    lines.push(JSON.parse(line));
                } catch {}
            }
            deliver();
        });
        sock.on("error", (e) => finish(e));
        sock.on("close", () => finish(new Error("closed")));
        sock.on("connect", () => {
            const api = {
                send: (o) => sock.write(JSON.stringify(o) + "\n"),
                read: () => new Promise((res) => { waiter = res; deliver(); }),
            };
            fn(api).then((v) => finish(null, v), (e) => finish(e));
        });
    });
}

// A következő válasz ("return" vagy "error"), az eseményeket átugorja
async function readReply(c) {
    for (;;) {
        const m = await c.read();
        if (m && ("return" in m || "error" in m)) return m;
    }
}

// QMP: a parancsok válaszai tömbben, [{ok, value|error}]
function qmpCommands(socketPath, commands) {
    return withSocket(socketPath, 2500, async (c) => {
        await c.read(); // üdvözlő üzenet
        c.send({ execute: "qmp_capabilities" });
        await readReply(c);
        const out = [];
        for (const cmd of commands) {
            c.send(cmd);
            const m = await readReply(c);
            out.push("return" in m ? { ok: true, value: m.return } : { ok: false, error: m.error });
        }
        return out;
    });
}

// QGA (qemu-guest-agent a vendégben): először guest-sync, aztán a parancsok
function qgaCommands(socketPath, commands) {
    return withSocket(socketPath, 3000, async (c) => {
        const id = Math.floor(Math.random() * 1e9);
        c.send({ execute: "guest-sync", arguments: { id } });
        for (;;) {
            const m = await c.read();
            if (m && m.return === id) break;
        }
        const out = [];
        for (const name of commands) {
            c.send({ execute: name });
            const m = await readReply(c);
            out.push("return" in m ? { ok: true, value: m.return } : { ok: false, error: m.error });
        }
        return out;
    });
}

const CLK_TCK = (() => {
    try {
        return Number(execFileSync("getconf", ["CLK_TCK"]).toString()) || 100;
    } catch {
        return 100;
    }
})();

function readCpuTicks(pid) {
    try {
        const s = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
        const f = s.slice(s.lastIndexOf(")") + 2).split(" ");
        return Number(f[11]) + Number(f[12]); // utime + stime
    } catch {
        return null;
    }
}

function readRss(pid) {
    try {
        const m = /VmRSS:\s+(\d+)\s*kB/.exec(fs.readFileSync(`/proc/${pid}/status`, "utf8"));
        return m ? Number(m[1]) * 1024 : null;
    } catch {
        return null;
    }
}

function imgInfo(file) {
    return new Promise((resolve) => {
        execFile("qemu-img", ["info", "-U", "--output=json", file], { timeout: 5000 }, (err, stdout) => {
            if (err) return resolve(null);
            try {
                resolve(JSON.parse(stdout));
            } catch {
                resolve(null);
            }
        });
    });
}

function createNode({ dataDir, qemuBin = "qemu-system-x86_64", dockerBin = process.env.DOCKER_BIN || "docker" }) {
    const ISO_DIR = path.join(dataDir, "isos");
    const DISK_DIR = path.join(dataDir, "disks");
    const DB_FILE = path.join(dataDir, "vms.json");
    for (const dir of [ISO_DIR, DISK_DIR]) fs.mkdirSync(dir, { recursive: true });

    // Rövid útvonal a unix socketeknek (a socket útvonal hossza korlátozott)
    const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "xm-"));
    const sockOf = (vm) => ({ qmp: path.join(RUN_DIR, `vm-${vm.id}.qmp`), qga: path.join(RUN_DIR, `vm-${vm.id}.qga`) });

    let vms = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, "utf8")) : [];
    for (const v of vms) if (!Array.isArray(v.fwd)) v.fwd = [];
    const saveDb = () => fs.writeFileSync(DB_FILE, JSON.stringify(vms, null, 2));

    const running = new Map(); // vm id -> child process
    const startTimes = new Map(); // vm id -> indítás ideje (ms)
    const cpuSamples = new Map(); // vm id -> {t, ticks, pct}
    const guestDown = new Map(); // "qmp:id" / "qga:id" -> utolsó sikertelen kapcsolat ideje

    // ---------- Segédek ----------
    function safeIsoName(name) {
        const clean = path.basename(String(name)).replace(/[^A-Za-z0-9._-]/g, "_");
        return clean.toLowerCase().endsWith(".iso") ? clean : null;
    }
    const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
    const vncPortOf = (vm) => 5900 + (vm.id - 100);
    const diskOf = (vm) => path.join(DISK_DIR, `vm-${vm.id}.qcow2`);
    const publicVm = (vm) => ({
        ...vm,
        status: running.has(vm.id) ? "running" : "stopped",
        vncPort: vncPortOf(vm),
    });
    const PORT_RE = /^(\d{1,5}):(\d{1,5})(?:\/(tcp|udp))?$/;
    const cleanList = (v) => (Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean) : []);

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
    // A VM beállításainak ellenőrzése (létrehozáshoz és szerkesztéshez is)
    function parseVm(b, id) {
        const vm = {
            id,
            name: String(b.name || ""),
            iso: b.iso ? String(b.iso) : "",
            os: String(b.os || "Linux"),
            disk: Number(b.disk),
            sockets: Number(b.sockets),
            cores: Number(b.cores),
            mem: Number(b.mem),
            model: String(b.model || "virtio"),
            fwd: [],
        };

        if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/.test(vm.name)) return { error: "Érvénytelen név (betű, szám, kötőjel)" };
        if (!["Linux", "Windows", "Other"].includes(vm.os)) return { error: "Érvénytelen OS" };
        if (!["virtio", "e1000"].includes(vm.model)) return { error: "Érvénytelen hálókártya modell" };
        if (!isInt(vm.disk, 1, 4096)) return { error: "A lemez 1 és 4096 GiB között lehet" };
        if (!isInt(vm.sockets, 1, 8)) return { error: "A socketek száma 1 és 8 között lehet" };
        if (!isInt(vm.cores, 1, 64)) return { error: "A magok száma 1 és 64 között lehet" };
        if (!isInt(vm.mem, 64, 1048576)) return { error: "A memória 64 MiB és 1 TiB között lehet" };
        if (vm.iso) {
            const iso = safeIsoName(vm.iso);
            if (!iso || iso !== vm.iso || !fs.existsSync(path.join(ISO_DIR, iso))) return { error: "A kiválasztott ISO nem létezik" };
        }

        const fwd = cleanList(b.fwd);
        if (fwd.length > 20) return { error: "Túl sok port továbbítás (max. 20)" };
        for (const f of fwd) {
            const m = PORT_RE.exec(f);
            const hp = m && Number(m[1]);
            const gp = m && Number(m[2]);
            if (!m || hp < 1 || hp > 65535 || gp < 1 || gp > 65535) return { error: `Érvénytelen port továbbítás: "${f}" (forma: 2222:22 vagy 8080:80/tcp)` };
            vm.fwd.push(`${hp}:${gp}/${m[3] || "tcp"}`);
        }
        return { vm };
    }

    router.get("/vms", (req, res) => res.json(vms.map(publicVm)));

    router.post("/vms", (req, res) => {
        const b = req.body || {};
        const id = Number(b.id);
        if (!isInt(id, 100, 999)) return res.status(400).json({ error: "A VM ID 100 és 999 között lehet" });
        if (vms.some((v) => v.id === id)) return res.status(409).json({ error: "Ez a VM ID már foglalt" });
        const parsed = parseVm(b, id);
        if (parsed.error) return res.status(400).json({ error: parsed.error });
        const vm = parsed.vm;

        execFile("qemu-img", ["create", "-f", "qcow2", diskOf(vm), `${vm.disk}G`], (err) => {
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

    // VM beállításainak szerkesztése (csak leállított VM-nél, a lemez csak növelhető)
    router.put("/vms/:id", (req, res) => {
        const vm = findVm(req, res);
        if (!vm) return;
        if (running.has(vm.id)) return res.status(409).json({ error: "A VM beállításai csak leállított állapotban szerkeszthetők" });

        const parsed = parseVm(req.body || {}, vm.id);
        if (parsed.error) return res.status(400).json({ error: parsed.error });
        const next = parsed.vm;
        if (next.disk < vm.disk) return res.status(400).json({ error: `A lemez csak növelhető (jelenleg ${vm.disk} GiB)` });

        const apply = () => {
            Object.assign(vm, next);
            saveDb();
            res.json(publicVm(vm));
        };
        if (next.disk === vm.disk) return apply();

        execFile("qemu-img", ["resize", diskOf(vm), `${next.disk}G`], (err) => {
            if (err) return res.status(500).json({ error: "Nem sikerült átméretezni a lemezt" });
            apply();
        });
    });

    router.post("/vms/:id/start", (req, res) => {
        const vm = findVm(req, res);
        if (!vm) return;
        if (running.has(vm.id)) return res.status(409).json({ error: "A VM már fut" });

        const socks = sockOf(vm);
        for (const s of Object.values(socks)) fs.rmSync(s, { force: true });

        const nic = [`user`, `model=${vm.model === "virtio" ? "virtio-net-pci" : "e1000"}`];
        for (const f of vm.fwd || []) {
            const m = PORT_RE.exec(f);
            nic.push(`hostfwd=${m[3] || "tcp"}::${m[1]}-:${m[2]}`);
        }

        const args = [
            "-name", vm.name,
            "-machine", "q35",
            "-m", String(vm.mem),
            "-smp", `sockets=${vm.sockets},cores=${vm.cores}`,
            "-drive", `file=${diskOf(vm)},format=qcow2,if=${vm.os === "Linux" ? "virtio" : "ide"}`,
            "-nic", nic.join(","),
            "-vga", "std",
            "-vnc", `127.0.0.1:${vm.id - 100}`,
            // statisztikákhoz: QMP, qemu-guest-agent csatorna, memória-ballon statisztika
            "-qmp", `unix:${socks.qmp},server=on,wait=off`,
            "-chardev", `socket,id=qga0,path=${socks.qga},server=on,wait=off`,
            "-device", "virtio-serial-pci",
            "-device", "virtserialport,chardev=qga0,name=org.qemu.guest_agent.0",
            "-device", "virtio-balloon-pci,id=balloon0,guest-stats-polling-interval=5",
        ];

        if (fs.existsSync("/dev/kvm")) args.push("-accel", "kvm", "-cpu", "host");
        else args.push("-accel", "tcg", "-cpu", "qemu64");

        // Az ISO csak a QEMU-folyamat első indításakor bootol (once=d): a telepítő végén a gép újraindul,
        // és már a lemezről indul, nem telepít újra. A telepítés után az ISO kivehető (Eject).
        if (vm.iso) {
            args.push(
                "-drive", `if=none,id=cd0,media=cdrom,readonly=on,file=${path.join(ISO_DIR, vm.iso)}`,
                "-device", "ide-cd,drive=cd0,id=cdrom0",
                "-boot", "order=c,once=d"
            );
        }

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
            startTimes.set(vm.id, Date.now());
            res.json(publicVm(vm));
        });

        child.on("exit", (code) => {
            running.delete(vm.id);
            startTimes.delete(vm.id);
            cpuSamples.delete(vm.id);
            for (const k of ["qmp", "qga"]) guestDown.delete(`${k}:${vm.id}`);
            if (code) console.error(`VM ${vm.id} kilépett (${code}): ${stderr.trim()}`);
        });
    });

    // Telepítő ISO kivétele: futó gépnél a virtuális meghajtóból is, és a beállításból is (a következő indításnál sem kerül vissza)
    router.post("/vms/:id/eject", async (req, res) => {
        const vm = findVm(req, res);
        if (!vm) return;
        if (!vm.iso) return res.status(409).json({ error: "Nincs behelyezett ISO" });
        if (running.has(vm.id)) {
            try {
                const [r] = await qmpCommands(sockOf(vm).qmp, [{ execute: "eject", arguments: { id: "cdrom0", force: true } }]);
                if (!r.ok) return res.status(500).json({ error: "Nem sikerült kivenni az ISO-t a futó gépből" });
            } catch {
                return res.status(500).json({ error: "A VM vezérlő csatornája nem érhető el" });
            }
        }
        vm.iso = "";
        saveDb();
        res.json(publicVm(vm));
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
        fs.rmSync(diskOf(vm), { force: true });
        vms = vms.filter((v) => v.id !== vm.id);
        saveDb();
        res.json({ ok: true });
    });

    // ---------- VM statisztikák ----------
    async function cpuPercent(vm, pid) {
        const sample = () => {
            const ticks = readCpuTicks(pid);
            return ticks == null ? null : { t: Date.now(), ticks };
        };
        let prev = cpuSamples.get(vm.id);
        if (!prev || Date.now() - prev.t > 30000) {
            prev = sample();
            await sleep(400);
        }
        const cur = sample();
        if (!prev || !cur) return null;
        const dt = (cur.t - prev.t) / 1000;
        if (dt < 0.3) return prev.pct ?? 0; // túl sűrű lekérdezés: az előző érték
        const vcpus = vm.sockets * vm.cores;
        const pct = Math.max(0, Math.min(100, ((cur.ticks - prev.ticks) / CLK_TCK / dt / vcpus) * 100));
        cpuSamples.set(vm.id, { ...cur, pct });
        return pct;
    }

    const isDown = (key) => (guestDown.get(key) || 0) > Date.now() - 30000;

    // Vendég memóriahasználat a virtio-balloon statisztikából (QMP)
    async function balloonStats(vm) {
        const key = `qmp:${vm.id}`;
        if (isDown(key)) return null;
        try {
            const [r] = await qmpCommands(sockOf(vm).qmp, [
                { execute: "qom-get", arguments: { path: "/machine/peripheral/balloon0", property: "guest-stats" } },
            ]);
            const st = r.ok && r.value && r.value.stats;
            if (!st || !(st["stat-total-memory"] > 0)) return null;
            const free = st["stat-available-memory"] ?? st["stat-free-memory"];
            if (!(free >= 0)) return null;
            return { total: st["stat-total-memory"], used: Math.max(0, st["stat-total-memory"] - free) };
        } catch {
            guestDown.set(key, Date.now());
            return null;
        }
    }

    // IP-címek és fájlrendszerek a qemu-guest-agenttől
    async function guestInfo(vm) {
        const key = `qga:${vm.id}`;
        if (isDown(key)) return null;
        try {
            const [ifs, fsi] = await qgaCommands(sockOf(vm).qga, ["guest-network-get-interfaces", "guest-get-fsinfo"]);
            const ips = [];
            if (ifs.ok && Array.isArray(ifs.value)) {
                for (const nic of ifs.value) {
                    if (nic.name === "lo") continue;
                    for (const a of nic["ip-addresses"] || []) {
                        const ip = a["ip-address"];
                        if (!ip || ip.startsWith("fe80") || ip.startsWith("127.")) continue;
                        ips.push({ iface: nic.name, ip, type: a["ip-address-type"] });
                    }
                }
                ips.sort((a, b) => (a.type === "ipv4" ? 0 : 1) - (b.type === "ipv4" ? 0 : 1));
            }
            const fsList = [];
            if (fsi.ok && Array.isArray(fsi.value)) {
                for (const f of fsi.value) {
                    if (f["total-bytes"] > 0 && f["used-bytes"] >= 0) {
                        fsList.push({ mount: f.mountpoint, type: f.type, used: f["used-bytes"], total: f["total-bytes"] });
                    }
                }
            }
            return { ips, fs: fsList };
        } catch {
            guestDown.set(key, Date.now());
            return null;
        }
    }

    router.get("/vms/:id/stats", async (req, res) => {
        const vm = findVm(req, res);
        if (!vm) return;

        const child = running.get(vm.id);
        const info = await imgInfo(diskOf(vm));
        let allocated = null;
        try {
            allocated = fs.statSync(diskOf(vm)).blocks * 512;
        } catch {}

        const out = {
            status: child ? "running" : "stopped",
            uptime: child && startTimes.has(vm.id) ? Math.round((Date.now() - startTimes.get(vm.id)) / 1000) : 0,
            cpu: { percent: null, vcpus: vm.sockets * vm.cores },
            memory: { allocated: vm.mem * 1024 * 1024, used: null, source: null, hostRss: null },
            disk: {
                virtualSize: (info && info["virtual-size"]) || vm.disk * 1024 ** 3,
                hostAllocated: info && info["actual-size"] != null ? info["actual-size"] : allocated,
                guest: null,
            },
            network: { ips: [], agent: false, forwards: vm.fwd || [] },
        };
        if (!child) return res.json(out);

        const [cpu, balloon, guest] = await Promise.all([cpuPercent(vm, child.pid), balloonStats(vm), guestInfo(vm)]);
        out.cpu.percent = cpu;
        out.memory.hostRss = readRss(child.pid);
        if (balloon) {
            out.memory.used = balloon.used;
            out.memory.allocated = balloon.total;
            out.memory.source = "guest";
        } else if (out.memory.hostRss != null) {
            out.memory.used = out.memory.hostRss;
            out.memory.source = "host";
        }
        if (guest) {
            out.network.agent = true;
            out.network.ips = guest.ips;
            out.disk.guest = guest.fs.length ? guest.fs : null;
        }
        res.json(out);
    });

    // ---------- Docker konténerek ----------
    // Csak a XenMox által létrehozott (xenmox.managed=true címkés) konténereket kezeljük.
    // Minden docker hívás argumentumlistával megy (nincs shell), a bemenetek szigorúan validáltak.
    const CT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
    const OLD_PREFIX = "xenmox-old-"; // szerkesztés közbeni ideiglenes név
    const IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/;
    const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*=[^\r\n\0]{0,4096}$/;
    const VOL_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}:\/[A-Za-z0-9_./-]{0,200}$/;
    const RESTARTS = ["no", "always", "unless-stopped", "on-failure"];
    const MAX_OUT = 4 * 1024 * 1024;
    const pending = new Map(); // név -> {image, state: "creating" | "error", error}
    const notes = new Map(); // név -> utolsó sikertelen módosítás üzenete

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

    // A konténer teljes inspect adata (opcionálisan méretekkel); hiba esetén maga válaszol
    async function inspectManaged(res, name, withSize) {
        if (!CT_NAME_RE.test(name)) {
            res.status(400).json({ error: "Érvénytelen konténer név" });
            return null;
        }
        const args = ["inspect", "--type", "container"];
        if (withSize) args.push("--size");
        args.push("--format", "{{json .}}", name);
        const r = await runDocker(args, withSize ? 60000 : 30000);
        if (r.code !== 0) {
            sendDockerErr(res, r);
            return null;
        }
        let data;
        try {
            data = JSON.parse(r.out);
        } catch {
            res.status(500).json({ error: "Érvénytelen docker válasz" });
            return null;
        }
        if (!data.Config || !data.Config.Labels || data.Config.Labels["xenmox.managed"] !== "true") {
            res.status(403).json({ error: "Ez a konténer nem a XenMox-ban készült" });
            return null;
        }
        return data;
    }

    function containerIps(data) {
        const ns = data.NetworkSettings || {};
        const ips = Object.values(ns.Networks || {}).map((n) => n.IPAddress).filter(Boolean);
        if (!ips.length && ns.IPAddress) ips.push(ns.IPAddress);
        return ips;
    }

    function parseConfigLabel(data) {
        try {
            const c = JSON.parse(data.Config.Labels["xenmox.config"]);
            return c && typeof c === "object" ? c : null;
        } catch {
            return null;
        }
    }

    function buildRunArgs(b) {
        const name = String(b.name || "").trim();
        const image = String(b.image || "").trim();
        const restart = String(b.restart || "unless-stopped");
        const ports = cleanList(b.ports);
        const env = cleanList(b.env);
        const volumes = cleanList(b.volumes);
        const memory = b.memory === "" || b.memory == null ? null : Number(b.memory);
        const cpus = b.cpus === "" || b.cpus == null ? null : Number(b.cpus);

        if (!CT_NAME_RE.test(name) || name.startsWith(OLD_PREFIX)) return { error: "Érvénytelen konténer név (betű, szám, . _ -)" };
        if (!IMAGE_RE.test(image)) return { error: "Érvénytelen image név (pl. nginx:latest)" };
        if (!RESTARTS.includes(restart)) return { error: "Érvénytelen újraindítási szabály" };
        if (ports.length > 50 || env.length > 50 || volumes.length > 50) return { error: "Túl sok port/változó/kötet (max. 50)" };
        if (memory !== null && !(Number.isInteger(memory) && memory >= 6 && memory <= 1048576)) return { error: "A memória 6 és 1048576 MiB között lehet" };
        if (cpus !== null && !(Number.isFinite(cpus) && cpus >= 0.01 && cpus <= 256)) return { error: "A CPU limit 0.01 és 256 között lehet" };

        const normPorts = [];
        for (const p of ports) {
            const m = PORT_RE.exec(p);
            const hp = m && Number(m[1]);
            const cp = m && Number(m[2]);
            if (!m || hp < 1 || hp > 65535 || cp < 1 || cp > 65535) return { error: `Érvénytelen port: "${p}" (forma: 8080:80 vagy 8080:80/udp)` };
            normPorts.push(`${hp}:${cp}/${m[3] || "tcp"}`);
        }
        for (const e of env) if (!ENV_RE.test(e)) return { error: `Érvénytelen környezeti változó: "${e.slice(0, 40)}" (forma: KULCS=érték)` };
        for (const v of volumes) if (!VOL_RE.test(v)) return { error: `Érvénytelen kötet: "${v}" (forma: kotetnev:/utvonal)` };

        // A beállításokat címkében is eltároljuk, hogy később szerkeszthetők legyenek
        const config = { restart, ports: normPorts, env, volumes, memory, cpus };
        const args = ["run", "-d", "--name", name, "--label", "xenmox.managed=true", "--label", `xenmox.config=${JSON.stringify(config)}`, "--restart", restart];
        if (memory !== null) args.push("--memory", `${memory}m`);
        if (cpus !== null) args.push("--cpus", String(cpus));
        for (const p of normPorts) args.push("-p", p);
        for (const e of env) args.push("-e", e);
        for (const v of volumes) args.push("-v", v);
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
                if (String(j.Names).startsWith(OLD_PREFIX)) continue; // szerkesztés közbeni ideiglenes példány
                list.push({ name: j.Names, image: j.Image, state: j.State, status: j.Status, ports: j.Ports || "", note: notes.get(j.Names) || "" });
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
                note: "",
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
        notes.delete(name);
        runDocker(args, 15 * 60 * 1000).then((r) => {
            if (r.code === 0) pending.delete(name);
            else pending.set(name, { image, state: "error", error: (r.err || r.out || "Ismeretlen hiba").trim().slice(-1500) });
        });
        res.status(202).json({ name, state: "creating" });
    });

    // Konténer részletei (beállítások, IP-cím, állapot)
    router.get("/containers/:name", async (req, res) => {
        const name = req.params.name;
        const p = pending.get(name);
        if (p) {
            return res.json({ name, image: p.image, state: p.state, status: p.state, error: p.error, ips: [], config: null, editable: false, note: "" });
        }
        const data = await inspectManaged(res, name, false);
        if (!data) return;
        const config = parseConfigLabel(data);
        res.json({
            name,
            image: data.Config.Image,
            state: data.State && data.State.Status,
            status: data.State && data.State.Status,
            startedAt: data.State && data.State.StartedAt,
            ips: containerIps(data),
            config,
            editable: !!config,
            note: notes.get(name) || "",
        });
    });

    // Konténer statisztikák (CPU, memória, hálózat, lemez)
    router.get("/containers/:name/stats", async (req, res) => {
        const name = req.params.name;
        if (pending.has(name)) return res.json({ state: pending.get(name).state });
        const data = await inspectManaged(res, name, true);
        if (!data) return;

        const state = (data.State && data.State.Status) || "unknown";
        const out = {
            state,
            uptime: 0,
            cpu: { percent: null },
            memory: { used: null, limit: null, percent: null },
            network: { io: null, ips: containerIps(data) },
            block: null,
            pids: null,
            disk: { writable: data.SizeRw ?? null, rootfs: data.SizeRootFs ?? null },
        };
        if (state === "running") {
            const started = Date.parse(data.State.StartedAt);
            if (started) out.uptime = Math.max(0, Math.round((Date.now() - started) / 1000));
            const r = await runDocker(["stats", "--no-stream", "--format", "{{json .}}", name], 30000);
            if (r.code === 0) {
                try {
                    const s = JSON.parse(r.out.trim().split("\n")[0]);
                    const [used, limit] = String(s.MemUsage || "").split(" / ");
                    out.cpu.percent = parseFloat(s.CPUPerc);
                    out.memory = { used: used || null, limit: limit || null, percent: parseFloat(s.MemPerc) };
                    out.network.io = s.NetIO || null;
                    out.block = s.BlockIO || null;
                    out.pids = s.PIDs ?? null;
                } catch {}
            }
        }
        res.json(out);
    });

    // Konténer beállításainak szerkesztése: a konténer újra lesz létrehozva (a kötetek adatai megmaradnak)
    router.put("/containers/:name", async (req, res) => {
        const name = req.params.name;
        if (pending.has(name)) return res.status(409).json({ error: "A konténer még nem áll készen" });
        const data = await inspectManaged(res, name, false);
        if (!data) return;
        if (!parseConfigLabel(data)) {
            return res.status(409).json({ error: "Ez a konténer a XenMox egy régebbi verziójában készült, a beállításai nem szerkeszthetők" });
        }
        const built = buildRunArgs({ ...(req.body || {}), name });
        if (built.error) return res.status(400).json({ error: built.error });

        const wasRunning = !!(data.State && data.State.Running);
        pending.set(name, { image: built.image, state: "creating", error: "" });
        notes.delete(name);
        res.status(202).json({ name, state: "creating" });

        (async () => {
            const tmp = `${OLD_PREFIX}${name}-${crypto.randomBytes(3).toString("hex")}`.slice(0, 63);
            let r = await runDocker(["rename", name, tmp]);
            if (r.code !== 0) {
                pending.delete(name);
                notes.set(name, "A módosítás nem sikerült: " + lastLine(r.err));
                return;
            }
            if (wasRunning) await runDocker(["stop", "-t", "10", tmp], 60000);
            r = await runDocker(built.args, 15 * 60 * 1000);
            if (r.code === 0) {
                await runDocker(["rm", "-f", tmp], 60000);
                pending.delete(name);
                return;
            }
            // Sikertelen: a régi konténer visszaállítása
            await runDocker(["rm", "-f", name], 60000);
            await runDocker(["rename", tmp, name]);
            if (wasRunning) await runDocker(["start", name], 60000);
            pending.delete(name);
            notes.set(name, "A módosítás nem sikerült, a régi konténer vissza lett állítva: " + lastLine(r.err));
        })();
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
        notes.delete(name);
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
        notes.delete(name);
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
        try {
            fs.rmSync(RUN_DIR, { recursive: true, force: true });
        } catch {}
    }

    return { router, handleVncUpgrade, stopAll };
}

module.exports = { createNode };
