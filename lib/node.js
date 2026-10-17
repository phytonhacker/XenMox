"use strict";
/**
 * Logic of a XenMox "node": ISOs, VMs (QEMU), Docker containers, statistics, VNC bridge.
 * Used by the main server (as the local node) and by xenmox-con-server.
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

// ---------- QMP / QGA (JSON line-based unix socket) client ----------
// fn({send, read}) receives the connection; rejects on error (timeout, closed connection).
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

// The next reply ("return" or "error"), skipping events
async function readReply(c) {
    for (;;) {
        const m = await c.read();
        if (m && ("return" in m || "error" in m)) return m;
    }
}

// QMP: command replies in an array, [{ok, value|error}]
function qmpCommands(socketPath, commands) {
    return withSocket(socketPath, 2500, async (c) => {
        await c.read(); // greeting message
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

// QGA (qemu-guest-agent in the guest): guest-sync first, then the commands
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

    // Short path for the unix sockets (the socket path length is limited)
    const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "xm-"));
    const sockOf = (vm) => ({ qmp: path.join(RUN_DIR, `vm-${vm.id}.qmp`), qga: path.join(RUN_DIR, `vm-${vm.id}.qga`) });

    let vms = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, "utf8")) : [];
    for (const v of vms) if (!Array.isArray(v.fwd)) v.fwd = [];
    const saveDb = () => fs.writeFileSync(DB_FILE, JSON.stringify(vms, null, 2));

    const running = new Map(); // vm id -> child process
    const startTimes = new Map(); // vm id -> start time (ms)
    const cpuSamples = new Map(); // vm id -> {t, ticks, pct}
    const guestDown = new Map(); // "qmp:id" / "qga:id" -> time of last failed connection

    // ---------- Helpers ----------
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

    // ---------- ISO management ----------
    const upload = multer({
        storage: multer.diskStorage({
            destination: ISO_DIR,
            filename: (req, file, cb) => cb(null, safeIsoName(file.originalname) || "invalid"),
        }),
        fileFilter: (req, file, cb) => {
            if (!safeIsoName(file.originalname)) return cb(new Error("Only .iso files can be uploaded"));
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
        if (!req.file) return res.status(400).json({ error: "No file uploaded" });
        res.json({ name: req.file.filename, size: req.file.size });
    });

    router.delete("/isos/:name", (req, res) => {
        const name = safeIsoName(req.params.name);
        const file = name && path.join(ISO_DIR, name);
        if (!file || !fs.existsSync(file)) return res.status(404).json({ error: "No such ISO" });
        fs.unlinkSync(file);
        res.json({ ok: true });
    });

    // ---------- VMs ----------
    // Validates the VM settings (for both creation and editing)
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

        if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/.test(vm.name)) return { error: "Invalid name (letters, digits, hyphen)" };
        if (!["Linux", "Windows", "Other"].includes(vm.os)) return { error: "Invalid OS" };
        if (!["virtio", "e1000"].includes(vm.model)) return { error: "Invalid network card model" };
        if (!isInt(vm.disk, 1, 4096)) return { error: "The disk can be between 1 and 4096 GiB" };
        if (!isInt(vm.sockets, 1, 8)) return { error: "The number of sockets can be between 1 and 8" };
        if (!isInt(vm.cores, 1, 64)) return { error: "The number of cores can be between 1 and 64" };
        if (!isInt(vm.mem, 64, 1048576)) return { error: "Memory can be between 64 MiB and 1 TiB" };
        if (vm.iso) {
            const iso = safeIsoName(vm.iso);
            if (!iso || iso !== vm.iso || !fs.existsSync(path.join(ISO_DIR, iso))) return { error: "The selected ISO does not exist" };
        }

        const fwd = cleanList(b.fwd);
        if (fwd.length > 20) return { error: "Too many port forwards (max. 20)" };
        for (const f of fwd) {
            const m = PORT_RE.exec(f);
            const hp = m && Number(m[1]);
            const gp = m && Number(m[2]);
            if (!m || hp < 1 || hp > 65535 || gp < 1 || gp > 65535) return { error: `Invalid port forward: "${f}" (format: 2222:22 or 8080:80/tcp)` };
            vm.fwd.push(`${hp}:${gp}/${m[3] || "tcp"}`);
        }
        return { vm };
    }

    router.get("/vms", (req, res) => res.json(vms.map(publicVm)));

    router.post("/vms", (req, res) => {
        const b = req.body || {};
        const id = Number(b.id);
        if (!isInt(id, 100, 999)) return res.status(400).json({ error: "The VM ID can be between 100 and 999" });
        if (vms.some((v) => v.id === id)) return res.status(409).json({ error: "This VM ID is already taken" });
        const parsed = parseVm(b, id);
        if (parsed.error) return res.status(400).json({ error: parsed.error });
        const vm = parsed.vm;

        execFile("qemu-img", ["create", "-f", "qcow2", diskOf(vm), `${vm.disk}G`], (err) => {
            if (err) {
                const msg = err.code === "ENOENT" ? "qemu-img is not installed" : "Failed to create the disk";
                return res.status(500).json({ error: msg });
            }
            vms.push(vm);
            saveDb();
            res.status(201).json(publicVm(vm));
        });
    });

    function findVm(req, res) {
        const vm = vms.find((v) => v.id === Number(req.params.id));
        if (!vm) res.status(404).json({ error: "No such VM" });
        return vm;
    }

    // Edit VM settings (only while stopped, the disk can only be increased)
    router.put("/vms/:id", (req, res) => {
        const vm = findVm(req, res);
        if (!vm) return;
        if (running.has(vm.id)) return res.status(409).json({ error: "VM settings can only be edited while the VM is stopped" });

        const parsed = parseVm(req.body || {}, vm.id);
        if (parsed.error) return res.status(400).json({ error: parsed.error });
        const next = parsed.vm;
        if (next.disk < vm.disk) return res.status(400).json({ error: `The disk can only be increased (currently ${vm.disk} GiB)` });

        const apply = () => {
            Object.assign(vm, next);
            saveDb();
            res.json(publicVm(vm));
        };
        if (next.disk === vm.disk) return apply();

        execFile("qemu-img", ["resize", diskOf(vm), `${next.disk}G`], (err) => {
            if (err) return res.status(500).json({ error: "Failed to resize the disk" });
            apply();
        });
    });

    router.post("/vms/:id/start", (req, res) => {
        const vm = findVm(req, res);
        if (!vm) return;
        if (running.has(vm.id)) return res.status(409).json({ error: "The VM is already running" });

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
            // for stats: QMP, qemu-guest-agent channel, memory-balloon stats
            "-qmp", `unix:${socks.qmp},server=on,wait=off`,
            "-chardev", `socket,id=qga0,path=${socks.qga},server=on,wait=off`,
            "-device", "virtio-serial-pci",
            "-device", "virtserialport,chardev=qga0,name=org.qemu.guest_agent.0",
            "-device", "virtio-balloon-pci,id=balloon0,guest-stats-polling-interval=5",
        ];

        if (fs.existsSync("/dev/kvm")) args.push("-accel", "kvm", "-cpu", "host");
        else args.push("-accel", "tcg", "-cpu", "qemu64");

        // The ISO only boots on the first start of the QEMU process (once=d): at the end of the installer the machine restarts,
        // and boots from the disk, so it does not reinstall. After installation the ISO can be ejected (Eject).
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
            const msg = err.code === "ENOENT" ? `${qemuBin} is not installed` : err.message;
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
            if (code) console.error(`VM ${vm.id} exited (${code}): ${stderr.trim()}`);
        });
    });

    // Eject the installer ISO: from the virtual drive on a running machine, and from the settings too (so it does not come back on the next start)
    router.post("/vms/:id/eject", async (req, res) => {
        const vm = findVm(req, res);
        if (!vm) return;
        if (!vm.iso) return res.status(409).json({ error: "No ISO inserted" });
        if (running.has(vm.id)) {
            try {
                const [r] = await qmpCommands(sockOf(vm).qmp, [{ execute: "eject", arguments: { id: "cdrom0", force: true } }]);
                if (!r.ok) return res.status(500).json({ error: "Failed to eject the ISO from the running machine" });
            } catch {
                return res.status(500).json({ error: "The VM's control channel is unavailable" });
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
        if (!child) return res.status(409).json({ error: "The VM is not running" });
        child.kill("SIGTERM");
        res.json({ ok: true });
    });

    router.delete("/vms/:id", (req, res) => {
        const vm = findVm(req, res);
        if (!vm) return;
        if (running.has(vm.id)) return res.status(409).json({ error: "A running VM cannot be deleted" });
        fs.rmSync(diskOf(vm), { force: true });
        vms = vms.filter((v) => v.id !== vm.id);
        saveDb();
        res.json({ ok: true });
    });

    // ---------- VM statistics ----------
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
        if (dt < 0.3) return prev.pct ?? 0; // too frequent polling: return the previous value
        const vcpus = vm.sockets * vm.cores;
        const pct = Math.max(0, Math.min(100, ((cur.ticks - prev.ticks) / CLK_TCK / dt / vcpus) * 100));
        cpuSamples.set(vm.id, { ...cur, pct });
        return pct;
    }

    const isDown = (key) => (guestDown.get(key) || 0) > Date.now() - 30000;

    // Guest memory usage from the virtio-balloon stats (QMP)
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

    // IP addresses and filesystems from the qemu-guest-agent
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

    // ---------- Docker containers ----------
    // Only containers created by XenMox (with the xenmox.managed=true label) are managed.
    // Every docker call uses an argument list (no shell), and the inputs are strictly validated.
    const CT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
    const OLD_PREFIX = "xenmox-old-"; // temporary name used during editing
    const IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/;
    const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*=[^\r\n\0]{0,4096}$/;
    const VOL_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}:\/[A-Za-z0-9_./-]{0,200}$/;
    const RESTARTS = ["no", "always", "unless-stopped", "on-failure"];
    const MAX_OUT = 4 * 1024 * 1024;
    const pending = new Map(); // name -> {image, state: "creating" | "error", error}
    const notes = new Map(); // name -> message of the last failed change

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
        if (r.error && r.error.code === "ENOENT") return { status: 503, msg: "Docker is not installed on this node" };
        if (/permission denied/i.test(text)) return { status: 503, msg: "No permission for Docker (run as root, or add the user to the docker group)" };
        if (/cannot connect to the docker daemon|is the docker daemon running|failed to connect to the docker api|daemon is running/i.test(text)) return { status: 503, msg: "The Docker service is not running on this node" };
        if (/no such (container|object)/i.test(text)) return { status: 404, msg: "No such container" };
        return { status: 500, msg: lastLine(text) || "Docker error" };
    }

    const sendDockerErr = (res, r) => {
        const e = dockerErr(r);
        res.status(e.status).json({ error: e.msg });
    };

    // Validates the name and that the container belongs to XenMox; on error it responds itself
    async function managedOr(res, name) {
        if (!CT_NAME_RE.test(name)) {
            res.status(400).json({ error: "Invalid container name" });
            return false;
        }
        const r = await runDocker(["inspect", "--type", "container", "--format", '{{index .Config.Labels "xenmox.managed"}}', name]);
        if (r.code !== 0) {
            sendDockerErr(res, r);
            return false;
        }
        if (r.out.trim() !== "true") {
            res.status(403).json({ error: "This container was not created by XenMox" });
            return false;
        }
        return true;
    }

    // Full inspect data of the container (optionally with sizes); on error it responds itself
    async function inspectManaged(res, name, withSize) {
        if (!CT_NAME_RE.test(name)) {
            res.status(400).json({ error: "Invalid container name" });
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
            res.status(500).json({ error: "Invalid docker response" });
            return null;
        }
        if (!data.Config || !data.Config.Labels || data.Config.Labels["xenmox.managed"] !== "true") {
            res.status(403).json({ error: "This container was not created by XenMox" });
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

        if (!CT_NAME_RE.test(name) || name.startsWith(OLD_PREFIX)) return { error: "Invalid container name (letters, digits, . _ -)" };
        if (!IMAGE_RE.test(image)) return { error: "Invalid image name (e.g. nginx:latest)" };
        if (!RESTARTS.includes(restart)) return { error: "Invalid restart policy" };
        if (ports.length > 50 || env.length > 50 || volumes.length > 50) return { error: "Too many ports/variables/volumes (max. 50)" };
        if (memory !== null && !(Number.isInteger(memory) && memory >= 6 && memory <= 1048576)) return { error: "Memory can be between 6 and 1048576 MiB" };
        if (cpus !== null && !(Number.isFinite(cpus) && cpus >= 0.01 && cpus <= 256)) return { error: "The CPU limit can be between 0.01 and 256" };

        const normPorts = [];
        for (const p of ports) {
            const m = PORT_RE.exec(p);
            const hp = m && Number(m[1]);
            const cp = m && Number(m[2]);
            if (!m || hp < 1 || hp > 65535 || cp < 1 || cp > 65535) return { error: `Invalid port: "${p}" (format: 8080:80 or 8080:80/udp)` };
            normPorts.push(`${hp}:${cp}/${m[3] || "tcp"}`);
        }
        for (const e of env) if (!ENV_RE.test(e)) return { error: `Invalid environment variable: "${e.slice(0, 40)}" (format: KEY=value)` };
        for (const v of volumes) if (!VOL_RE.test(v)) return { error: `Invalid volume: "${v}" (format: volumename:/path)` };

        // The settings are also stored in a label so they can be edited later
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
                if (String(j.Names).startsWith(OLD_PREFIX)) continue; // temporary instance during editing
                list.push({ name: j.Names, image: j.Image, state: j.State, status: j.Status, ports: j.Ports || "", note: notes.get(j.Names) || "" });
            } catch {}
        }
        for (const [name, p] of pending) {
            if (list.some((c) => c.name === name)) continue;
            list.push({
                name,
                image: p.image,
                state: p.state,
                status: p.state === "error" ? "error during creation" : "creation in progress (downloading image)",
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

        if (pending.has(name)) return res.status(409).json({ error: "A container with this name is already being created" });
        const exists = await runDocker(["inspect", "--type", "container", name]);
        if (exists.code === 0) return res.status(409).json({ error: "A container with this name already exists" });
        if (exists.error) return sendDockerErr(res, exists);
        if (/permission denied|cannot connect|failed to connect|daemon is running/i.test(exists.err)) return sendDockerErr(res, exists);

        // Downloading the image can take a long time, so it runs in the background and the request responds immediately
        pending.set(name, { image, state: "creating", error: "" });
        notes.delete(name);
        runDocker(args, 15 * 60 * 1000).then((r) => {
            if (r.code === 0) pending.delete(name);
            else pending.set(name, { image, state: "error", error: (r.err || r.out || "Unknown error").trim().slice(-1500) });
        });
        res.status(202).json({ name, state: "creating" });
    });

    // Container details (settings, IP address, state)
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

    // Container statistics (CPU, memory, network, disk)
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

    // Edit container settings: the container is recreated (volume data is preserved)
    router.put("/containers/:name", async (req, res) => {
        const name = req.params.name;
        if (pending.has(name)) return res.status(409).json({ error: "The container is not ready yet" });
        const data = await inspectManaged(res, name, false);
        if (!data) return;
        if (!parseConfigLabel(data)) {
            return res.status(409).json({ error: "This container was created by an older version of XenMox; its settings cannot be edited" });
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
                notes.set(name, "The change failed: " + lastLine(r.err));
                return;
            }
            if (wasRunning) await runDocker(["stop", "-t", "10", tmp], 60000);
            r = await runDocker(built.args, 15 * 60 * 1000);
            if (r.code === 0) {
                await runDocker(["rm", "-f", tmp], 60000);
                pending.delete(name);
                return;
            }
            // Failed: restore the old container
            await runDocker(["rm", "-f", name], 60000);
            await runDocker(["rename", tmp, name]);
            if (wasRunning) await runDocker(["start", name], 60000);
            pending.delete(name);
            notes.set(name, "The change failed; the old container has been restored: " + lastLine(r.err));
        })();
    });

    router.get("/containers/:name/logs", async (req, res) => {
        const name = req.params.name;
        if (pending.has(name)) {
            const p = pending.get(name);
            return res.json({ logs: p.state === "error" ? p.error : "Container creation in progress (downloading the image may take a while)..." });
        }
        if (!(await managedOr(res, name))) return;
        const tail = Math.min(Math.max(parseInt(req.query.tail, 10) || 300, 1), 2000);
        const r = await runDocker(["logs", "--tail", String(tail), "--timestamps", name]);
        if (r.code !== 0) return sendDockerErr(res, r);
        res.json({ logs: r.all });
    });

    router.post("/containers/:name/:action(start|stop|restart)", async (req, res) => {
        const name = req.params.name;
        if (pending.has(name)) return res.status(409).json({ error: "The container is not ready yet" });
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
            if (p.state === "creating") return res.status(409).json({ error: "Container creation is still in progress" });
            pending.delete(name); // remove the trace of a failed creation
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

    // ---------- VNC: WebSocket <-> TCP bridge ----------
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
