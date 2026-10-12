"use strict";
/**
 * Hitelesítés: felhasználó/jelszó tárolás (scrypt), munkamenetek, próbálkozás-korlátozás,
 * és a parancssoros első beállítás (--setup). A főszerver és a con-server is ezt használja.
 */
const crypto = require("crypto");
const fs = require("fs");
const readline = require("readline");
const { promisify } = require("util");

const scrypt = promisify(crypto.scrypt);

const USER_RE = /^[A-Za-z0-9._-]{3,32}$/;
const MIN_PASS = 8;
const MAX_PASS = 200;

function validateCredentials(username, password) {
    if (typeof username !== "string" || !USER_RE.test(username)) return "A felhasználónév 3–32 karakter lehet (betű, szám, . _ -)";
    if (typeof password !== "string" || password.length < MIN_PASS) return `A jelszó legalább ${MIN_PASS} karakter legyen`;
    if (password.length > MAX_PASS) return "A jelszó túl hosszú";
    return null;
}

function safeEqual(a, b) {
    const A = Buffer.from(String(a));
    const B = Buffer.from(String(b));
    return A.length === B.length && crypto.timingSafeEqual(A, B);
}

class AuthStore {
    constructor(file) {
        this.file = file;
        this.data = null;
        this.cache = new Set(); // már ellenőrzött Basic fejlécek (sha256), a con-server gyorsításához
        this.lastReload = 0;
        this.load();
    }

    load() {
        try {
            const d = JSON.parse(fs.readFileSync(this.file, "utf8"));
            this.data = d && d.username && d.salt && d.hash ? d : null;
        } catch {
            this.data = null;
        }
    }

    get configured() {
        return !!this.data;
    }

    get username() {
        return this.data ? this.data.username : null;
    }

    // Ha még nincs beállítva, időnként újraolvassa a fájlt (pl. közben lefutott a --setup)
    refresh() {
        if (this.data || Date.now() - this.lastReload < 1000) return;
        this.lastReload = Date.now();
        this.load();
    }

    async set(username, password) {
        const salt = crypto.randomBytes(16);
        const hash = await scrypt(password, salt, 64);
        this.data = { username, salt: salt.toString("hex"), hash: hash.toString("hex") };
        fs.writeFileSync(this.file, JSON.stringify(this.data), { mode: 0o600 });
        fs.chmodSync(this.file, 0o600);
        this.cache.clear();
    }

    async verify(username, password) {
        // A hash-elés mindig lefut, így az időzítés nem árulja el, hogy létezik-e a felhasználó
        const d = this.data || { username: "", salt: "00".repeat(16), hash: "00".repeat(64) };
        const hash = await scrypt(String(password), Buffer.from(d.salt, "hex"), 64);
        const okHash = crypto.timingSafeEqual(hash, Buffer.from(d.hash, "hex"));
        const okUser = safeEqual(username, d.username);
        return !!this.data && okHash && okUser;
    }

    // "Authorization: Basic ..." ellenőrzése (a con-server minden kérésénél), sikeres találat gyorsítótárazva
    async verifyBasic(header) {
        if (!header || !header.startsWith("Basic ")) return false;
        const key = crypto.createHash("sha256").update(header).digest("hex");
        if (this.cache.has(key)) return true;
        const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
        const i = decoded.indexOf(":");
        if (i < 0) return false;
        const ok = await this.verify(decoded.slice(0, i), decoded.slice(i + 1));
        if (ok) this.cache.add(key);
        return ok;
    }
}

// Memóriában tárolt munkamenetek (újraindításkor mindenki kilépik)
function createSessions(ttlMs = 12 * 3600 * 1000) {
    const map = new Map();
    return {
        create(user) {
            const id = crypto.randomBytes(32).toString("hex");
            map.set(id, { user, expires: Date.now() + ttlMs });
            return id;
        },
        get(id) {
            const s = id && map.get(id);
            if (!s) return null;
            if (s.expires < Date.now()) {
                map.delete(id);
                return null;
            }
            s.expires = Date.now() + ttlMs; // csúszó lejárat
            return s;
        },
        destroy(id) {
            map.delete(id);
        },
        destroyAllExcept(keep) {
            for (const k of [...map.keys()]) if (k !== keep) map.delete(k);
        },
    };
}

// Sikertelen próbálkozások korlátozása kulcsonként (pl. IP-címenként)
function createLimiter({ max = 5, windowMs = 60000, lockMs = 60000 } = {}) {
    const map = new Map();
    return {
        blocked(key) {
            const e = map.get(key);
            return !!e && e.until > Date.now();
        },
        fail(key) {
            const now = Date.now();
            const e = map.get(key) || { count: 0, first: now, until: 0 };
            if (now - e.first > windowMs) {
                e.count = 0;
                e.first = now;
            }
            e.count++;
            if (e.count >= max) {
                e.until = now + lockMs;
                e.count = 0;
                e.first = now;
            }
            map.set(key, e);
        },
        ok(key) {
            map.delete(key);
        },
    };
}

function parseCookies(header) {
    const out = {};
    for (const part of String(header || "").split(";")) {
        const i = part.indexOf("=");
        if (i <= 0) continue;
        try {
            out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
        } catch {}
    }
    return out;
}

// ---------- Parancssoros első beállítás ----------
function promptLine(question, { hidden = false } = {}) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        if (hidden) {
            let muted = false;
            const origWrite = rl._writeToOutput.bind(rl);
            rl._writeToOutput = (s) => {
                if (!muted) origWrite(s);
                else if (/[\r\n]/.test(s)) process.stdout.write("\n");
            };
            process.stdout.write(question);
            muted = true;
            rl.question("", (a) => {
                rl.close();
                resolve(a);
            });
        } else {
            rl.question(question, (a) => {
                rl.close();
                resolve(a);
            });
        }
    });
}

// Felhasználónév/jelszó bekérése és mentése. Nem interaktív esetben XENMOX_USER és XENMOX_PASS változókból.
async function runSetup(store, label) {
    let user = process.env.XENMOX_USER;
    let pass = process.env.XENMOX_PASS;
    if (!(user && pass)) {
        if (!process.stdin.isTTY) {
            console.error("Nem interaktív terminál: add meg a XENMOX_USER és XENMOX_PASS környezeti változókat.");
            process.exit(1);
        }
        console.log(`${label} – felhasználó beállítása`);
        user = (await promptLine("Felhasználónév: ")).trim();
        pass = await promptLine(`Jelszó (min. ${MIN_PASS} karakter): `, { hidden: true });
        const again = await promptLine("Jelszó újra: ", { hidden: true });
        if (pass !== again) {
            console.error("A két jelszó nem egyezik.");
            process.exit(1);
        }
    }
    const err = validateCredentials(user, pass);
    if (err) {
        console.error(err);
        process.exit(1);
    }
    await store.set(user, pass);
    console.log(`A(z) "${user}" felhasználó beállítva.`);
}

module.exports = { AuthStore, createSessions, createLimiter, parseCookies, validateCredentials, safeEqual, runSetup };
