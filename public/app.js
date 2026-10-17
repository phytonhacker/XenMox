// ---------- Helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const enc = encodeURIComponent;

async function api(url, options = {}) {
    const res = await fetch(url, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        // expired session / no user configured yet: back to login
        if (res.status === 401 && data.login) showAuth("login");
        if (res.status === 403 && data.setup) showAuth("setup");
        const err = new Error(data.error || `Error (${res.status})`);
        err.status = res.status;
        throw err;
    }
    return data;
}

const jsonOpts = (method, body) => ({
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
});

function fmtSize(bytes) {
    const mb = bytes / 1024 / 1024;
    return mb >= 1024 ? (mb / 1024).toFixed(2) + " GiB" : mb.toFixed(0) + " MiB";
}

function fmtBytes(n) {
    if (n == null || !isFinite(n)) return "–";
    const u = ["B", "KiB", "MiB", "GiB", "TiB"];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) {
        n /= 1024;
        i++;
    }
    return (i === 0 ? n.toFixed(0) : n.toFixed(1)) + " " + u[i];
}

function fmtDur(s) {
    if (!s) return "–";
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    return (d ? d + "d " : "") + (h || d ? h + "h " : "") + m + "m " + (s % 60) + "s";
}

function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// A single gauge bar: percentage + label
function bar(pct, text) {
    const p = Math.max(0, Math.min(100, Number(pct) || 0));
    const cls = p > 90 ? "crit" : p > 75 ? "warn" : "";
    return `<div class="XM_BAR"><div class="XM_BAR_FILL ${cls}" style="width:${p.toFixed(1)}%"></div></div><small>${esc(text)}</small>`;
}

const card = (title, html) => `<div class="XM_CARD"><h5>${esc(title)}</h5>${html}</div>`;

function showAlert(msg) {
    alert(msg);
}

// ---------- State ----------
// The key of a node: "<datacenter id>/<node id>" (the own datacenter's id: "local")
const state = {
    dcs: [],            // [{id, name, remote, online, nodes:[...]}]
    nodes: {},          // key -> {key, id, name, online, dcId, dcName, remoteDc}
    vms: {},            // key -> [vm]
    isos: {},           // key -> [iso]
    containers: {},     // key -> {list: [container], error: text|null}
    csel: null,         // selected container: {node, name}
    vsel: null,         // VM details: {node, id}
    node: "local/local", // the node selected in the menu
    sel: null,          // VM selected for the console: {node, id}
    open: new Set(["dc:local", "local/local"]), // open branches in the tree
};

const nodeByKey = (k) => state.nodes[k];
const ownDc = () => state.dcs.find((d) => !d.remote);

// Base URL of the given node's API: in the own datacenter /api/nodes/<id>,
// in a linked datacenter /api/dcs/<dc>/nodes/<id>
function nb(key) {
    const n = nodeByKey(key);
    if (!n) throw new Error("Unknown node");
    return n.remoteDc ? `/api/dcs/${enc(n.dcId)}/nodes/${enc(n.id)}` : `/api/nodes/${enc(n.id)}`;
}

// Display name: for a remote datacenter "Datacenter / node"
function nodeLabel(key) {
    const n = nodeByKey(key);
    if (!n) return key;
    return n.remoteDc ? `${n.dcName} / ${n.name}` : n.name;
}

// ---------- Login ----------
let locked = true;
let timers = [];
let authMode = "login";

function lockUi() {
    locked = true;
    timers.forEach(clearInterval);
    timers = [];
    disconnectConsole();
    $("#XM_LAYOUT").hidden = true;
    $("#XM_USERBOX").hidden = true;
}

function showAuth(mode) {
    lockUi();
    authMode = mode;
    const setup = mode === "setup";
    $("#XM_AUTH").hidden = false;
    $("#XM_AUTH_TITLE").innerHTML = setup
        ? '<i class="fa-solid fa-shield-halved"></i> First-time setup'
        : '<i class="fa-solid fa-lock"></i> Login';
    $("#XM_AUTH_INFO").textContent = setup
        ? "Create the administrator user. Until this is set up, the server allows nothing. (The username is 3–32 characters, the password is at least 8.)"
        : "Log in to use XenMox.";
    $("#XM_AUTH_PASS2").hidden = !setup;
    $("#XM_AUTH_PASS2").required = setup;
    $("#XM_AUTH_P2L").hidden = !setup;
    $("#XM_AUTH_PASS").autocomplete = setup ? "new-password" : "current-password";
    $("#XM_AUTH_BTN").textContent = setup ? "Create" : "Login";
    $("#XM_AUTH_ERR").hidden = true;
    $("#XM_AUTH_PASS").value = "";
    $("#XM_AUTH_PASS2").value = "";
}

function authError(msg) {
    const el = $("#XM_AUTH_ERR");
    el.textContent = msg;
    el.hidden = false;
}

$("#XM_AUTH_FORM").addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = $("#XM_AUTH_USER").value.trim();
    const password = $("#XM_AUTH_PASS").value;
    if (authMode === "setup" && password !== $("#XM_AUTH_PASS2").value) return authError("The two passwords do not match");
    const btn = $("#XM_AUTH_BTN");
    btn.disabled = true;
    try {
        const r = await api(authMode === "setup" ? "/api/auth/setup" : "/api/auth/login", jsonOpts("POST", { username, password }));
        $("#XM_AUTH_FORM").reset();
        await enter(r.username);
    } catch (err) {
        if (err.status === 409) return init(); // someone else configured it in the meantime
        authError(err.message);
    } finally {
        btn.disabled = false;
    }
});

async function enter(username) {
    $("#XM_AUTH").hidden = true;
    $("#XM_LAYOUT").hidden = false;
    $("#XM_USERBOX").hidden = false;
    $("#XM_USERNAME").textContent = username;
    locked = false;
    Object.assign(state, { vms: {}, isos: {}, containers: {}, csel: null, vsel: null, sel: null, node: "local/local" });
    try {
        await refreshAll();
        showPane("XM_PANE_VMS");
    } catch (e) {
        console.error(e);
    }
    timers = [
        setInterval(() => !locked && refreshAll().catch(() => {}), 5000),
        setInterval(tickStats, 3000),
    ];
}

async function init() {
    lockUi();
    try {
        const st = await api("/api/auth/status");
        if (!st.configured) return showAuth("setup");
        if (!st.authenticated) return showAuth("login");
        await enter(st.username);
    } catch (e) {
        showAuth("login");
        authError("The server is unreachable");
    }
}

$("#XM_LOGOUT").addEventListener("click", async () => {
    try {
        await api("/api/auth/logout", { method: "POST" });
    } catch {}
    showAuth("login");
});

$("#XM_PW_OPEN").addEventListener("click", () => {
    $("#XM_PW_FORM").reset();
    showPane("XM_PANE_PASSWORD");
});

$("#XM_PW_FORM").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pw = $("#XM_PW_NEW").value;
    if (pw !== $("#XM_PW_NEW2").value) return showAlert("The two new passwords do not match");
    try {
        await api("/api/auth/password", jsonOpts("POST", { current: $("#XM_PW_CUR").value, password: pw }));
        $("#XM_PW_FORM").reset();
        showAlert("The password has been changed. The other logged-in sessions have been logged out.");
        showPane("XM_PANE_VMS");
    } catch (err) {
        showAlert(err.message);
    }
});

// ---------- Loading data ----------
async function refreshAll() {
    const data = await api("/api/dcs");
    state.dcs = data.dcs;

    state.nodes = {};
    for (const dc of state.dcs) {
        for (const n of dc.nodes) {
            const key = `${dc.id}/${n.id}`;
            state.nodes[key] = {
                ...n,
                key,
                dcId: dc.id,
                dcName: dc.name,
                remoteDc: dc.remote,
                online: dc.online && n.online,
            };
        }
    }
    if (!nodeByKey(state.node)) state.node = "local/local";

    await Promise.all(
        Object.values(state.nodes).map(async (n) => {
            if (!n.online) {
                state.vms[n.key] = [];
                state.containers[n.key] = { list: [], error: null };
                return;
            }
            await Promise.all([
                api(`${nb(n.key)}/vms`)
                    .then((v) => (state.vms[n.key] = v))
                    .catch(() => (state.vms[n.key] = [])),
                api(`${nb(n.key)}/containers`)
                    .then((list) => (state.containers[n.key] = { list, error: null }))
                    .catch((e) => (state.containers[n.key] = { list: [], error: e.message })),
            ]);
        })
    );
    if (locked) return;

    renderTree();
    renderVmList();
    renderCtList();
    renderDcPane();
    renderNodeSelect();
    renderCtNodeSelect();
    syncConsole();
    syncVm();
    syncContainer();
}

async function refreshIsos(key) {
    const n = nodeByKey(key);
    if (!n || !n.online) {
        state.isos[key] = [];
    } else {
        try {
            state.isos[key] = await api(`${nb(key)}/isos`);
        } catch {
            state.isos[key] = [];
        }
    }
    renderIsoSelect();
    renderIsoList();
}

// ---------- Sidebar fa ----------
function renderNodeBranch(n) {
    const vms = state.vms[n.key] || [];
    const vmItems = vms.map((v) => {
        const selected = [state.sel, state.vsel].some((s) => s && s.node === n.key && s.id === v.id);
        return `
        <li class="${v.status}${selected ? " selected" : ""}" data-vm="${v.id}" data-node="${esc(n.key)}"
            title="Click: console, double click: stats and settings">
            <i class="fa-solid fa-desktop"></i> ${v.id} (${esc(v.name)})
        </li>`;
    }).join("");

    const ctItems = ((state.containers[n.key] || {}).list || []).map((c) => `
        <li class="${ctClass(c)}${state.csel && state.csel.node === n.key && state.csel.name === c.name ? " selected" : ""}"
            data-ct="${esc(c.name)}" data-node="${esc(n.key)}"
            title="Click: logs, double click: stats and settings">
            <i class="fa-brands fa-docker"></i> ${esc(c.name)}
        </li>`).join("");

    return `
        <details data-node="${esc(n.key)}" ${state.open.has(n.key) ? "open" : ""}>
            <summary><i class="fa-solid fa-server"></i> ${esc(n.name)}
                <span class="XM_DOT ${n.online ? "online" : "offline"}" title="${n.online ? "online" : "offline"}"></span>
            </summary>
            ${n.online ? `
            <ul>
                <li data-view="XM_PANE_VMS" data-node="${esc(n.key)}"><i class="fa-solid fa-list"></i> Overview</li>
                <li data-view="XM_PANE_CREATE" data-node="${esc(n.key)}"><i class="fa-solid fa-plus"></i> Create VM</li>
                <li data-view="XM_PANE_CCREATE" data-node="${esc(n.key)}"><i class="fa-brands fa-docker"></i> Create container</li>
                <li data-view="XM_PANE_SETTINGS" data-node="${esc(n.key)}"><i class="fa-solid fa-gear"></i> Settings (ISO)</li>
            </ul>
            <ul class="XM_TREE_VMS">${vmItems}${ctItems}</ul>` : `<ul><li class="XM_OFFLINE_NOTE">The node is unreachable</li></ul>`}
        </details>`;
}

function renderTree() {
    $("#XM_TREE_ROOT").innerHTML = state.dcs.map((dc) => {
        const settings = dc.remote ? "" : `<ul><li data-view="XM_PANE_DC"><i class="fa-solid fa-gear"></i> Datacenter settings</li></ul>`;
        const body = dc.online
            ? dc.nodes.map((n) => renderNodeBranch(nodeByKey(`${dc.id}/${n.id}`))).join("")
            : `<ul><li class="XM_OFFLINE_NOTE">${esc(dc.error || "The datacenter is unreachable")}</li></ul>`;
        return `
            <details data-dc="${esc(dc.id)}" class="XM_TREE_DC" ${state.open.has("dc:" + dc.id) ? "open" : ""}>
                <summary><i class="fa-solid fa-building"></i> Datacenter (${esc(dc.name)})
                    ${dc.remote ? `<span class="XM_DOT ${dc.online ? "online" : "offline"}" title="linked datacenter"></span>` : ""}
                </summary>
                ${settings}
                ${body}
            </details>`;
    }).join("");
}

// Preserve the open/closed state on redraw (the toggle does not bubble, hence capture)
$("#XM_TREE_ROOT").addEventListener("toggle", (e) => {
    const ds = e.target.dataset || {};
    const key = ds.dc !== undefined ? "dc:" + ds.dc : ds.node;
    if (!key) return;
    if (e.target.open) state.open.add(key);
    else state.open.delete(key);
}, true);

// One click: console / logs; double click: stats + settings.
// The short delay is needed so that a double click does not open the console first.
let clickTimer = null;

$("#XM_TREE_ROOT").addEventListener("click", (e) => {
    const vmLi = e.target.closest("[data-vm]");
    if (vmLi) {
        clearTimeout(clickTimer);
        const { node, vm } = vmLi.dataset;
        clickTimer = setTimeout(() => openConsole(node, Number(vm)), 250);
        return;
    }
    const ctLi = e.target.closest("[data-ct]");
    if (ctLi) {
        clearTimeout(clickTimer);
        const { node, ct } = ctLi.dataset;
        clickTimer = setTimeout(() => openContainer(node, ct, "logs"), 250);
        return;
    }

    const viewLi = e.target.closest("[data-view]");
    if (!viewLi) return;
    if (viewLi.dataset.node) state.node = viewLi.dataset.node;
    showPane(viewLi.dataset.view);
});

$("#XM_TREE_ROOT").addEventListener("dblclick", (e) => {
    const vmLi = e.target.closest("[data-vm]");
    if (vmLi) {
        clearTimeout(clickTimer);
        return openVm(vmLi.dataset.node, Number(vmLi.dataset.vm), "stats");
    }
    const ctLi = e.target.closest("[data-ct]");
    if (ctLi) {
        clearTimeout(clickTimer);
        return openContainer(ctLi.dataset.node, ctLi.dataset.ct, "stats");
    }
});

// ---------- View switching ----------
function showPane(id) {
    document.querySelectorAll(".XM_VIEW_PANE").forEach((p) => (p.hidden = p.id !== id));
    document.querySelectorAll(".XM_PANE_NODE").forEach((el) => (el.textContent = nodeLabel(state.node)));

    if (id !== "XM_PANE_CONSOLE") {
        state.sel = null;
        disconnectConsole();
    }
    if (id !== "XM_PANE_CONTAINER") state.csel = null;
    if (id !== "XM_PANE_VM") state.vsel = null;
    renderTree();

    if (id === "XM_PANE_VMS") {
        renderVmList();
        renderCtList();
    }
    if (id === "XM_PANE_CCREATE") renderCtNodeSelect(state.node);
    if (id === "XM_PANE_DC") {
        renderDcPane();
        refreshFed();
    }
    if (id === "XM_PANE_SETTINGS") refreshIsos(state.node);
    if (id === "XM_PANE_CREATE") {
        renderNodeSelect(state.node);
        refreshIsos($("#cvm-node").value || state.node);
    }
}

// Handling tabs (Stats / Settings / Logs) within a panel
function bindTabs(navSel, onChange) {
    const nav = $(navSel);
    nav.addEventListener("click", (e) => {
        const b = e.target.closest("[data-tab]");
        if (b) setTab(navSel, b.dataset.tab, onChange);
    });
}

function setTab(navSel, tab, onChange) {
    const nav = $(navSel);
    nav.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    const root = nav.closest(".XM_CREATEVM_WINDOW");
    root.querySelectorAll(".XM_TABPANE").forEach((p) => (p.hidden = p.dataset.pane !== tab));
    if (onChange) onChange(tab);
}

const activeTab = (navSel) => {
    const b = $(navSel + " .active");
    return b ? b.dataset.tab : null;
};

// ---------- Datacenter pane ----------
function renderDcPane() {
    const own = ownDc();
    if (!own) return;

    const nameInput = $("#XM_DC_NAME");
    if (document.activeElement !== nameInput) nameInput.value = own.name;

    $("#XM_DC_NODES").innerHTML = own.nodes.map((n) => `
        <li>
            <span>
                <i class="fa-solid fa-server"></i> ${esc(n.name)}
                <small>${n.local ? "local" : esc(n.host) + ":" + n.port}</small>
                <small class="${n.online ? "XM_STATUS_running" : "XM_STATUS_stopped"}">${n.online ? "online" : "offline"}</small>
            </span>
            <span>
                <button type="button" class="XM_BTN" data-node-act="rename" data-nid="local/${esc(n.id)}" title="Rename"><i class="fa-solid fa-pen"></i></button>
                ${n.local ? "" : `<button type="button" class="XM_BTN" data-node-act="remove" data-nid="local/${esc(n.id)}" title="Remove"><i class="fa-solid fa-trash"></i></button>`}
            </span>
        </li>`).join("");

    const links = state.dcs.filter((d) => d.remote);
    $("#XM_DC_LINKS").innerHTML = links.length
        ? links.map((d) => `
            <li>
                <span>
                    <i class="fa-solid fa-link"></i> ${esc(d.name)}
                    <small>${esc(d.host)}:${d.port}</small>
                    <small class="${d.online ? "XM_STATUS_running" : "XM_STATUS_stopped"}">${d.online ? "online" : "offline"}</small>
                    ${d.error ? `<small>${esc(d.error)}</small>` : ""}
                </span>
                <button type="button" class="XM_BTN" data-dc-act="unlink" data-did="${esc(d.id)}" title="Unlink"><i class="fa-solid fa-link-slash"></i></button>
            </li>`).join("")
        : "<li>No linked datacenter yet.</li>";
}

async function refreshFed() {
    try {
        $("#XM_FED_TOKEN").value = (await api("/api/federation")).token;
    } catch {}
}

$("#XM_DC_FORM").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
        await api("/api/datacenter", jsonOpts("PATCH", { name: $("#XM_DC_NAME").value }));
        await refreshAll();
    } catch (err) {
        showAlert(err.message);
    }
});

$("#XM_DC_NODES").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-node-act]");
    if (!btn) return;
    const key = btn.dataset.nid;
    const n = nodeByKey(key);
    try {
        if (btn.dataset.nodeAct === "rename") {
            const name = prompt("New name for the node:", n.name);
            if (name === null || name.trim() === n.name) return;
            await api(nb(key), jsonOpts("PATCH", { name: name.trim() }));
        } else if (confirm(`Remove the "${n.name}" node? The VMs remain on the node, only the connection is removed.`)) {
            await api(nb(key), { method: "DELETE" });
            if (state.node === key) state.node = "local/local";
        } else {
            return;
        }
        await refreshAll();
    } catch (err) {
        showAlert(err.message);
    }
});

$("#XM_ADDNODE_FORM").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.submitter || e.target.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
        const node = await api("/api/nodes", jsonOpts("POST", {
            name: $("#XM_AN_NAME").value,
            host: $("#XM_AN_HOST").value,
            port: Number($("#XM_AN_PORT").value),
            username: $("#XM_AN_USER").value,
            password: $("#XM_AN_PASS").value,
        }));
        $("#XM_ADDNODE_FORM").reset();
        $("#XM_AN_PORT").value = 3001;
        state.open.add("local/" + node.id);
        await refreshAll();
    } catch (err) {
        showAlert(err.message);
    } finally {
        btn.disabled = false;
    }
});

// Linking another XenMox main server's datacenter
$("#XM_LINKDC_FORM").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.submitter || e.target.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
        const dc = await api("/api/dcs", jsonOpts("POST", {
            host: $("#XM_LD_HOST").value,
            port: Number($("#XM_LD_PORT").value),
            token: $("#XM_LD_TOKEN").value,
        }));
        $("#XM_LINKDC_FORM").reset();
        $("#XM_LD_PORT").value = 3000;
        state.open.add("dc:" + dc.id);
        await refreshAll();
    } catch (err) {
        showAlert(err.message);
    } finally {
        btn.disabled = false;
    }
});

$("#XM_DC_LINKS").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-dc-act]");
    if (!btn) return;
    const dc = state.dcs.find((d) => d.id === btn.dataset.did);
    if (!dc || !confirm(`Unlink from the "${dc.name}" datacenter? The VMs remain on the other server.`)) return;
    try {
        await api(`/api/dcs/${enc(dc.id)}`, { method: "DELETE" });
        if (nodeByKey(state.node) && nodeByKey(state.node).dcId === dc.id) state.node = "local/local";
        await refreshAll();
    } catch (err) {
        showAlert(err.message);
    }
});

$("#XM_FED_REGEN").addEventListener("click", async () => {
    if (!confirm("You are generating a new token. Previously linked servers lose access until you give them the new one. Continue?")) return;
    try {
        $("#XM_FED_TOKEN").value = (await api("/api/federation/regenerate", { method: "POST" })).token;
    } catch (err) {
        showAlert(err.message);
    }
});

// ---------- VM creation window ----------
const tabs = document.querySelectorAll(".XM_CVM_TAB:not([data-tab])");
const panels = document.querySelectorAll("#XM_PANE_CREATE .XM_CVM_PANEL");
const backBtn = $("#cvm-back");
const nextBtn = $("#cvm-next");
let current = 0;

function showTab(i) {
    current = i;
    tabs.forEach((t, n) => t.classList.toggle("active", n === i));
    panels.forEach((p, n) => p.classList.toggle("active", n === i));
    backBtn.disabled = i === 0;
    nextBtn.textContent = i === tabs.length - 1 ? "Finish" : "Next";
}

tabs.forEach((t, n) => t.addEventListener("click", () => showTab(n)));
backBtn.addEventListener("click", () => showTab(current - 1));

// force: the node selected from the menu (the timed refresh keeps the user's choice)
function renderNodeSelect(force) {
    const sel = $("#cvm-node");
    const prev = force || sel.value || state.node;
    const online = Object.values(state.nodes).filter((n) => n.online);
    sel.innerHTML = online.map((n) => `<option value="${esc(n.key)}">${esc(nodeLabel(n.key))}</option>`).join("");
    if (online.some((n) => n.key === prev)) sel.value = prev;
}

$("#cvm-node").addEventListener("change", () => refreshIsos($("#cvm-node").value));

nextBtn.addEventListener("click", async () => {
    if (current < tabs.length - 1) return showTab(current + 1);

    const node = $("#cvm-node").value;
    const body = {
        id: Number($("#cvm-id").value),
        name: $("#cvm-name").value.trim(),
        os: $("#cvm-os").value,
        iso: $("#cvm-iso").value,
        disk: Number($("#cvm-disk").value),
        sockets: Number($("#cvm-sockets").value),
        cores: Number($("#cvm-cores").value),
        mem: Number($("#cvm-mem").value),
        model: $("#cvm-model").value,
    };

    nextBtn.disabled = true;
    try {
        await api(`${nb(node)}/vms`, jsonOpts("POST", body));
        state.open.add(node);
        await refreshAll();
        $("#cvm-id").value = body.id + 1;
        $("#cvm-name").value = "";
        showTab(0);
        showAlert(`The VM was created on ${nodeLabel(node)}.`);
    } catch (e) {
        showAlert(e.message);
    } finally {
        nextBtn.disabled = false;
    }
});

// ---------- ISOs (selected node) ----------
function renderIsoSelect() {
    const key = $("#cvm-node").value || state.node;
    const isos = state.isos[key] || [];
    const sel = $("#cvm-iso");
    const prev = sel.value;
    sel.innerHTML = '<option value="">Do not use any media</option>' +
        isos.map((i) => `<option value="${esc(i.name)}">${esc(i.name)}</option>`).join("");
    if (isos.some((i) => i.name === prev)) sel.value = prev;
}

function renderIsoList() {
    const isos = state.isos[state.node] || [];
    $("#XM_ISO_LIST").innerHTML = isos.length
        ? isos.map((i) => `
            <li>
                <span><i class="fa-solid fa-compact-disc"></i> ${esc(i.name)} <small>(${fmtSize(i.size)})</small></span>
                <button type="button" class="XM_BTN" data-del-iso="${esc(i.name)}"><i class="fa-solid fa-trash"></i></button>
            </li>`).join("")
        : "<li>No ISO uploaded on this node yet.</li>";
}

$("#XM_ISO_LIST").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-del-iso]");
    if (!btn || !confirm("Are you sure you want to delete the ISO?")) return;
    try {
        await api(`${nb(state.node)}/isos/${enc(btn.dataset.delIso)}`, { method: "DELETE" });
        refreshIsos(state.node);
    } catch (err) {
        showAlert(err.message);
    }
});

$("#XM_ISO_FORM").addEventListener("submit", (e) => {
    e.preventDefault();
    const file = $("#XM_ISO_FILE").files[0];
    if (!file) return showAlert("Choose an .iso file!");

    const key = state.node;
    const fd = new FormData();
    fd.append("iso", file);

    const xhr = new XMLHttpRequest();
    const bar = $("#XM_ISO_PROGRESS");
    bar.hidden = false;
    bar.value = 0;

    xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable) bar.value = (ev.loaded / ev.total) * 100;
    };
    xhr.onload = () => {
        bar.hidden = true;
        if (xhr.status >= 200 && xhr.status < 300) {
            $("#XM_ISO_FILE").value = "";
            refreshIsos(key);
        } else {
            let msg = "Upload error";
            try { msg = JSON.parse(xhr.responseText).error || msg; } catch {}
            if (xhr.status === 401) showAuth("login");
            showAlert(msg);
        }
    };
    xhr.onerror = () => {
        bar.hidden = true;
        showAlert("Network error during upload");
    };
    xhr.open("POST", `${nb(key)}/isos`);
    xhr.send(fd);
});

// ---------- VM list (selected node) ----------
function renderVmList() {
    const vms = state.vms[state.node] || [];
    $("#XM_VM_LIST").innerHTML = vms.length
        ? vms.map((v) => `
            <li data-vmrow="${v.id}" title="Double click: stats and settings">
                <span>
                    <i class="fa-solid fa-desktop"></i> ${v.id} – ${esc(v.name)}
                    <small class="XM_STATUS_${v.status}">${v.status}</small>
                </span>
                <span>
                    <button type="button" class="XM_BTN" data-act="details" data-id="${v.id}" title="Stats and settings"><i class="fa-solid fa-chart-line"></i></button>
                    ${v.status === "running"
                        ? `<button type="button" class="XM_BTN" data-act="console" data-id="${v.id}" title="Konzol"><i class="fa-solid fa-display"></i></button>
                           <button type="button" class="XM_BTN" data-act="stop" data-id="${v.id}"><i class="fa-solid fa-stop"></i></button>`
                        : `<button type="button" class="XM_BTN" data-act="start" data-id="${v.id}"><i class="fa-solid fa-play"></i></button>
                           <button type="button" class="XM_BTN" data-act="delete" data-id="${v.id}"><i class="fa-solid fa-trash"></i></button>`}
                </span>
            </li>`).join("")
        : "<li>No VM on this node yet.</li>";
}

$("#XM_VM_LIST").addEventListener("dblclick", (e) => {
    if (e.target.closest("button")) return;
    const li = e.target.closest("[data-vmrow]");
    if (li) openVm(state.node, Number(li.dataset.vmrow), "stats");
});

$("#XM_VM_LIST").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const { act, id } = btn.dataset;
    if (act === "console") return openConsole(state.node, Number(id));
    if (act === "details") return openVm(state.node, Number(id), "stats");
    if (act === "delete" && !confirm("Are you sure you want to delete the VM and its disk?")) return;
    try {
        await api(`${nb(state.node)}/vms/${id}` + (act === "delete" ? "" : "/" + act), {
            method: act === "delete" ? "DELETE" : "POST",
        });
        await new Promise((r) => setTimeout(r, 400));
        refreshAll();
    } catch (err) {
        showAlert(err.message);
    }
});

// ---------- VM details: stats + settings ----------
const vmOf = (sel) => sel && (state.vms[sel.node] || []).find((v) => v.id === sel.id);
let vmStatsBusy = false;
let vmFormLoaded = null; // which VM's data the settings form is filled with

bindTabs("#XM_VM_TABS", (tab) => {
    if (tab === "stats") loadVmStats();
    if (tab === "settings") loadVmForm(true);
});

function openVm(node, id, tab = "stats") {
    state.node = node;
    state.vsel = { node, id };
    vmFormLoaded = null;
    showPane("XM_PANE_VM");
    $("#XM_VM_STATS").innerHTML = "<small>Loading...</small>";
    setTab("#XM_VM_TABS", tab, (t) => {
        if (t === "stats") loadVmStats();
        if (t === "settings") loadVmForm(true);
    });
    syncVm();
}

function syncVm() {
    if (!state.vsel) return;
    const vm = vmOf(state.vsel);
    if (!vm) return showPane(nodeByKey(state.vsel.node) && nodeByKey(state.vsel.node).online ? "XM_PANE_VMS" : "XM_PANE_DC");

    $("#XM_VM_TITLE").textContent = `${nodeLabel(state.vsel.node)} / ${vm.id} (${vm.name})`;
    const st = $("#XM_VM_STATE");
    st.textContent = vm.status;
    st.className = "XM_STATUS_" + vm.status;
    const isRunning = vm.status === "running";
    $("#XM_VM_START").disabled = isRunning;
    $("#XM_VM_STOP").disabled = !isRunning;
    $("#XM_VM_CONSOLE").disabled = !isRunning;
    $("#XM_VM_EJECT").hidden = !vm.iso;

    // Settings can only be changed while the VM is stopped
    $("#XM_VMSE_FS").disabled = isRunning;
    const msg = $("#XM_VMSE_MSG");
    msg.hidden = !isRunning;
    msg.textContent = isRunning ? "The VM is running: stop it to change the settings." : "";
    if (activeTab("#XM_VM_TABS") === "settings" && vmFormLoaded !== state.vsel.node + ":" + vm.id) loadVmForm(false);
}

async function loadVmForm(force) {
    const vm = vmOf(state.vsel);
    if (!vm) return;
    const key = state.vsel.node + ":" + vm.id;
    if (!force && vmFormLoaded === key) return;
    vmFormLoaded = key;

    let isos = [];
    try {
        isos = await api(`${nb(state.vsel.node)}/isos`);
    } catch {}
    $("#vmse-iso").innerHTML = '<option value="">Do not use any media</option>' +
        isos.map((i) => `<option value="${esc(i.name)}">${esc(i.name)}</option>`).join("");
    $("#vmse-name").value = vm.name;
    $("#vmse-os").value = vm.os;
    $("#vmse-iso").value = vm.iso || "";
    $("#vmse-disk").value = vm.disk;
    $("#vmse-disk").min = vm.disk;
    $("#vmse-sockets").value = vm.sockets;
    $("#vmse-cores").value = vm.cores;
    $("#vmse-mem").value = vm.mem;
    $("#vmse-model").value = vm.model;
    $("#vmse-fwd").value = (vm.fwd || []).join("\n");
}

$("#XM_VMSE_FORM").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!state.vsel) return;
    const { node, id } = state.vsel;
    const btn = $("#XM_VMSE_SAVE");
    btn.disabled = true;
    try {
        await api(`${nb(node)}/vms/${id}`, jsonOpts("PUT", {
            name: $("#vmse-name").value.trim(),
            os: $("#vmse-os").value,
            iso: $("#vmse-iso").value,
            disk: Number($("#vmse-disk").value),
            sockets: Number($("#vmse-sockets").value),
            cores: Number($("#vmse-cores").value),
            mem: Number($("#vmse-mem").value),
            model: $("#vmse-model").value,
            fwd: lines("#vmse-fwd"),
        }));
        vmFormLoaded = null;
        await refreshAll();
        showAlert("The settings have been saved.");
    } catch (err) {
        showAlert(err.message);
    } finally {
        btn.disabled = false;
    }
});

function renderVmStats(s) {
    const running = s.status === "running";
    const cards = [];

    cards.push(card("Status", `<div class="XM_BIG XM_STATUS_${s.status}">${esc(s.status)}</div>
        <small>${running ? "Uptime: " + fmtDur(s.uptime) : "The VM is stopped"}</small>`));

    cards.push(card("CPU", s.cpu.percent == null
        ? `<div class="XM_BIG">–</div><small>${running ? "Not measurable" : "Stopped"} · ${s.cpu.vcpus} vCPU</small>`
        : `<div class="XM_BIG">${s.cpu.percent.toFixed(1)}%</div>${bar(s.cpu.percent, `${s.cpu.vcpus} vCPU`)}`));

    if (s.memory.used == null) {
        cards.push(card("Memory", `<div class="XM_BIG">${fmtBytes(s.memory.allocated)}</div><small>${running ? "Not measurable" : "Allocated memory (stopped)"}</small>`));
    } else {
        const pct = (s.memory.used / s.memory.allocated) * 100;
        cards.push(card("Memory", `<div class="XM_BIG">${fmtBytes(s.memory.used)} / ${fmtBytes(s.memory.allocated)}</div>
            ${bar(pct, s.memory.source === "guest"
                ? `${pct.toFixed(0)}% – based on the guest system's report`
                : `${pct.toFixed(0)}% – host-side allocation (for the guest's exact value, a virtio-balloon driver is needed in the guest)`)}`));
    }

    const d = s.disk;
    let diskHtml = `<div class="XM_BIG">${fmtBytes(d.virtualSize)}</div>
        <small>Disk image on the host: ${fmtBytes(d.hostAllocated)} allocated</small>`;
    if (d.guest) {
        diskHtml += d.guest.map((f) => `<div><small>${esc(f.mount)} (${esc(f.type)}): ${fmtBytes(f.used)} / ${fmtBytes(f.total)}</small>${bar((f.used / f.total) * 100, `${((f.used / f.total) * 100).toFixed(0)}%`)}</div>`).join("");
    } else if (running) {
        diskHtml += "<small>The guest disk usage requires the qemu-guest-agent in the guest.</small>";
    }
    cards.push(card("Disk", diskHtml));

    let net = "";
    if (s.network.ips.length) {
        net += s.network.ips.map((i) => `<div><strong>${esc(i.ip)}</strong> <small style="display:inline">${esc(i.iface)}</small></div>`).join("");
    } else {
        net += `<small>${running ? "No IP data: install and start the qemu-guest-agent in the guest. (On the built-in network the guest address is usually 10.0.2.15.)" : "The VM is stopped"}</small>`;
    }
    if (s.network.forwards.length) {
        net += `<small>Port forwards (host:guest): ${s.network.forwards.map(esc).join(", ")}</small>`;
    }
    cards.push(card("Network", net));

    $("#XM_VM_STATS").innerHTML = `<div class="XM_CARDS">${cards.join("")}</div>`;
}

async function loadVmStats() {
    if (!state.vsel || vmStatsBusy || locked) return;
    vmStatsBusy = true;
    const sel = state.vsel;
    try {
        const s = await api(`${nb(sel.node)}/vms/${sel.id}/stats`);
        if (state.vsel && state.vsel.node === sel.node && state.vsel.id === sel.id) renderVmStats(s);
    } catch (err) {
        if (state.vsel) $("#XM_VM_STATS").innerHTML = `<p class="XM_ERR">${esc(err.message)}</p>`;
    } finally {
        vmStatsBusy = false;
    }
}

async function vmDetailAction(act) {
    if (!state.vsel) return;
    try {
        await api(`${nb(state.vsel.node)}/vms/${state.vsel.id}/${act}`, { method: "POST" });
    } catch (e) {
        showAlert(e.message);
    }
    await new Promise((r) => setTimeout(r, 800));
    vmFormLoaded = null;
    await refreshAll();
    loadVmStats();
}

$("#XM_VM_START").addEventListener("click", () => vmDetailAction("start"));
$("#XM_VM_STOP").addEventListener("click", () => vmDetailAction("stop"));
$("#XM_VM_CONSOLE").addEventListener("click", () => state.vsel && openConsole(state.vsel.node, state.vsel.id));
$("#XM_VM_EJECT").addEventListener("click", async () => {
    if (!state.vsel) return;
    if (!confirm("Eject the installer ISO? On the next start the VM will boot from its disk.")) return;
    await vmDetailAction("eject");
});

// ---------- noVNC konzol ----------
const screenEl = $("#XM_CONSOLE_SCREEN");
let rfb = null;
let rfbKey = null; // "node-kulcs:vm"
let connecting = false;
let retries = 0;

const selKey = () => (state.sel ? `${state.sel.node}:${state.sel.id}` : null);

function setScreenMsg(text) {
    screenEl.innerHTML = text ? `<div class="XM_CONSOLE_MSG">${text}</div>` : "";
}

function disconnectConsole() {
    if (!rfb) return;
    const r = rfb;
    rfb = null;
    rfbKey = null;
    try { r.disconnect(); } catch {}
}

async function connectConsole() {
    const key = selKey();
    if (!key || connecting || (rfb && rfbKey === key)) return;
    connecting = true;
    try {
        disconnectConsole();
        setScreenMsg("Connecting...");
        const { default: RFB } = await import("/novnc/core/rfb.js");
        if (selKey() !== key) return; // another VM was selected in the meantime

        screenEl.innerHTML = "";
        const proto = location.protocol === "https:" ? "wss" : "ws";
        const { node, id } = state.sel;
        const r = new RFB(screenEl, `${proto}://${location.host}${nb(node)}/vms/${id}/vnc`);
        r.scaleViewport = true;
        r.background = "#000";

        r.addEventListener("connect", () => { retries = 0; });
        r.addEventListener("disconnect", () => {
            if (rfb !== r) return; // intentional close
            rfb = null;
            rfbKey = null;
            setScreenMsg("The connection was lost, reconnecting...");
            if (retries++ < 5) setTimeout(syncConsole, 1500);
        });

        rfb = r;
        rfbKey = key;
    } finally {
        connecting = false;
    }
}

function openConsole(node, id) {
    state.node = node;
    showPane("XM_PANE_CONSOLE");
    state.sel = { node, id };
    retries = 0;
    renderTree();
    syncConsole();
}

function syncConsole() {
    if (!state.sel) return;
    const { node, id } = state.sel;
    const vm = (state.vms[node] || []).find((v) => v.id === id);
    if (!vm) return showPane(nodeByKey(node) && nodeByKey(node).online ? "XM_PANE_VMS" : "XM_PANE_DC");

    $("#XM_CONSOLE_TITLE").textContent = `${nodeLabel(node)} / ${vm.id} (${vm.name})`;
    const st = $("#XM_CONSOLE_STATE");
    st.textContent = vm.status;
    st.className = "XM_STATUS_" + vm.status;

    const isRunning = vm.status === "running";
    $("#XM_CON_START").disabled = isRunning;
    $("#XM_CON_STOP").disabled = !isRunning;
    $("#XM_CON_CAD").disabled = !isRunning;
    $("#XM_CON_FULL").disabled = !isRunning;

    if (isRunning) {
        connectConsole().catch((err) => setScreenMsg("Error: " + esc(err.message)));
    } else {
        disconnectConsole();
        setScreenMsg("The VM is stopped. Start it with the Start button.");
    }
}

async function vmAction(act) {
    if (!state.sel) return;
    try {
        await api(`${nb(state.sel.node)}/vms/${state.sel.id}/${act}`, { method: "POST" });
    } catch (e) {
        showAlert(e.message);
    }
    // on start due to the VNC port, on stop due to the process exiting
    await new Promise((r) => setTimeout(r, 800));
    await refreshAll();
}

$("#XM_CON_START").addEventListener("click", () => vmAction("start"));
$("#XM_CON_STOP").addEventListener("click", () => vmAction("stop"));
$("#XM_CON_DETAILS").addEventListener("click", () => state.sel && openVm(state.sel.node, state.sel.id, "stats"));
$("#XM_CON_CAD").addEventListener("click", () => rfb && rfb.sendCtrlAltDel());
$("#XM_CON_FULL").addEventListener("click", () => screenEl.requestFullscreen && screenEl.requestFullscreen());

// ---------- Docker containers ----------
function ctClass(c) {
    if (c.state === "running") return "running";
    if (c.state === "creating") return "creating";
    if (c.state === "error") return "error";
    return "stopped";
}

// List of containers on the Overview panel (selected node)
function renderCtList() {
    const info = state.containers[state.node] || { list: [], error: null };
    const msg = $("#XM_CT_MSG");
    msg.hidden = !info.error;
    msg.textContent = info.error ? "Docker: " + info.error : "";

    $("#XM_CT_LIST").innerHTML = info.error ? "" : info.list.length
        ? info.list.map((c) => {
            const cls = ctClass(c);
            const n = esc(c.name);
            const details = `<button type="button" class="XM_BTN" data-ctact="stats" data-name="${n}" title="Stats and settings"><i class="fa-solid fa-chart-line"></i></button>`;
            const actions = cls === "running"
                ? `${details}
                   <button type="button" class="XM_BTN" data-ctact="open" data-name="${n}" title="Logs"><i class="fa-solid fa-file-lines"></i></button>
                   <button type="button" class="XM_BTN" data-ctact="restart" data-name="${n}" title="Restart"><i class="fa-solid fa-rotate"></i></button>
                   <button type="button" class="XM_BTN" data-ctact="stop" data-name="${n}" title="Stop"><i class="fa-solid fa-stop"></i></button>`
                : cls === "stopped"
                    ? `${details}
                       <button type="button" class="XM_BTN" data-ctact="open" data-name="${n}" title="Logs"><i class="fa-solid fa-file-lines"></i></button>
                       <button type="button" class="XM_BTN" data-ctact="start" data-name="${n}" title="Start"><i class="fa-solid fa-play"></i></button>
                       <button type="button" class="XM_BTN" data-ctact="delete" data-name="${n}" title="Delete"><i class="fa-solid fa-trash"></i></button>`
                    : cls === "error"
                        ? `<button type="button" class="XM_BTN" data-ctact="open" data-name="${n}" title="Error details"><i class="fa-solid fa-file-lines"></i></button>
                           <button type="button" class="XM_BTN" data-ctact="delete" data-name="${n}" title="Discard"><i class="fa-solid fa-trash"></i></button>`
                        : "";
            return `
                <li data-ctrow="${n}" title="Double click: stats and settings">
                    <span>
                        <i class="fa-brands fa-docker"></i> ${n}
                        <small>${esc(c.image)}</small>
                        <small class="XM_STATUS_${cls === "running" ? "running" : "stopped"}">${esc(c.status)}</small>
                        ${c.ports ? `<small>${esc(c.ports)}</small>` : ""}
                        ${c.note ? `<small>${esc(c.note)}</small>` : ""}
                    </span>
                    <span>${actions}</span>
                </li>`;
        }).join("")
        : "<li>No container on this node yet.</li>";
}

$("#XM_CT_LIST").addEventListener("dblclick", (e) => {
    if (e.target.closest("button")) return;
    const li = e.target.closest("[data-ctrow]");
    if (li) openContainer(state.node, li.dataset.ctrow, "stats");
});

$("#XM_CT_LIST").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-ctact]");
    if (!btn) return;
    const { ctact, name } = btn.dataset;
    if (ctact === "open") return openContainer(state.node, name, "logs");
    if (ctact === "stats") return openContainer(state.node, name, "stats");
    if (ctact === "delete" && !confirm(`Are you sure you want to delete the "${name}" container?`)) return;
    btn.disabled = true;
    try {
        await api(`${nb(state.node)}/containers/${enc(name)}` + (ctact === "delete" ? "" : "/" + ctact), {
            method: ctact === "delete" ? "DELETE" : "POST",
        });
    } catch (err) {
        showAlert(err.message);
    }
    refreshAll();
});

// Container creation form
function renderCtNodeSelect(force) {
    const sel = $("#ccr-node");
    const prev = force || sel.value || state.node;
    const online = Object.values(state.nodes).filter((n) => n.online);
    sel.innerHTML = online.map((n) => `<option value="${esc(n.key)}">${esc(nodeLabel(n.key))}</option>`).join("");
    if (online.some((n) => n.key === prev)) sel.value = prev;
}

const lines = (id) => $(id).value.split("\n").map((s) => s.trim()).filter(Boolean);

$("#XM_CCR_FORM").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.submitter || e.target.querySelector("button[type=submit]");
    const node = $("#ccr-node").value;
    const name = $("#ccr-name").value.trim();
    btn.disabled = true;
    try {
        await api(`${nb(node)}/containers`, jsonOpts("POST", {
            name,
            image: $("#ccr-image").value.trim(),
            restart: $("#ccr-restart").value,
            ports: lines("#ccr-ports"),
            env: lines("#ccr-env"),
            volumes: lines("#ccr-volumes"),
            memory: $("#ccr-memory").value,
            cpus: $("#ccr-cpus").value,
        }));
        $("#XM_CCR_FORM").reset();
        state.open.add(node);
        state.node = node;
        await refreshAll();
        showPane("XM_PANE_VMS");
        showAlert(`Container "${name}" creation has started. Downloading the image may take a while; its state will update in the list.`);
    } catch (err) {
        showAlert(err.message);
    } finally {
        btn.disabled = false;
    }
});

// Container details: logs, stats, settings
const logEl = $("#XM_CLOG");
let logsBusy = false;
let ctStatsBusy = false;
let ctFormLoaded = null;

bindTabs("#XM_CT_TABS", (tab) => {
    if (tab === "logs") loadLogs();
    if (tab === "stats") loadCtStats();
    if (tab === "settings") loadCtForm(true);
});

function openContainer(node, name, tab = "logs") {
    state.node = node;
    showPane("XM_PANE_CONTAINER");
    state.csel = { node, name };
    ctFormLoaded = null;
    renderTree();
    logEl.textContent = "";
    $("#XM_CT_STATS").innerHTML = "<small>Loading...</small>";
    setTab("#XM_CT_TABS", tab, (t) => {
        if (t === "logs") loadLogs();
        if (t === "stats") loadCtStats();
        if (t === "settings") loadCtForm(true);
    });
    syncContainer();
}

async function loadLogs() {
    if (!state.csel || logsBusy) return;
    logsBusy = true;
    const { node, name } = state.csel;
    try {
        const data = await api(`${nb(node)}/containers/${enc(name)}/logs?tail=300`);
        if (state.csel && state.csel.node === node && state.csel.name === name) {
            const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
            logEl.textContent = data.logs || "(no logs)";
            if (atBottom) logEl.scrollTop = logEl.scrollHeight;
        }
    } catch (err) {
        logEl.textContent = err.message;
    } finally {
        logsBusy = false;
    }
}

function renderCtStats(s) {
    const running = s.state === "running";
    const cards = [];
    cards.push(card("Status", `<div class="XM_BIG XM_STATUS_${running ? "running" : "stopped"}">${esc(s.state)}</div>
        <small>${running ? "Uptime: " + fmtDur(s.uptime) : ""}</small>`));

    cards.push(card("CPU", s.cpu.percent == null || isNaN(s.cpu.percent)
        ? `<div class="XM_BIG">–</div>`
        : `<div class="XM_BIG">${s.cpu.percent.toFixed(1)}%</div>${bar(s.cpu.percent, "one core = 100%")}`));

    cards.push(card("Memory", s.memory.used == null
        ? `<div class="XM_BIG">–</div>`
        : `<div class="XM_BIG">${esc(s.memory.used)}</div>
           ${isNaN(s.memory.percent) ? "" : bar(s.memory.percent, `${s.memory.percent.toFixed(1)}% – limit: ${s.memory.limit}`)}`));

    let net = "";
    if (s.network.ips.length) net += s.network.ips.map((ip) => `<div><strong>${esc(ip)}</strong></div>`).join("");
    else net += "<small>No IP address</small>";
    if (s.network.io) net += `<small>Network (in / out): ${esc(s.network.io)}</small>`;
    cards.push(card("Network", net));

    let disk = `<small>Writable layer: ${s.disk.writable == null ? "–" : fmtBytes(s.disk.writable)}</small>
        <small>Image + layer: ${s.disk.rootfs == null ? "–" : fmtBytes(s.disk.rootfs)}</small>`;
    if (s.block) disk += `<small>Disk I/O (read / write): ${esc(s.block)}</small>`;
    if (s.pids != null) disk += `<small>Processes: ${esc(s.pids)}</small>`;
    cards.push(card("Disk", disk));

    $("#XM_CT_STATS").innerHTML = `<div class="XM_CARDS">${cards.join("")}</div>`;
}

async function loadCtStats() {
    if (!state.csel || ctStatsBusy || locked) return;
    ctStatsBusy = true;
    const sel = state.csel;
    try {
        const s = await api(`${nb(sel.node)}/containers/${enc(sel.name)}/stats`);
        if (state.csel && state.csel.node === sel.node && state.csel.name === sel.name) {
            if (s.cpu) renderCtStats(s);
            else $("#XM_CT_STATS").innerHTML = `<small>The container is not ready yet (${esc(s.state)}).</small>`;
        }
    } catch (err) {
        if (state.csel) $("#XM_CT_STATS").innerHTML = `<p class="XM_ERR">${esc(err.message)}</p>`;
    } finally {
        ctStatsBusy = false;
    }
}

async function loadCtForm(force) {
    if (!state.csel) return;
    const { node, name } = state.csel;
    const key = node + ":" + name;
    if (!force && ctFormLoaded === key) return;
    ctFormLoaded = key;
    const msg = $("#XM_CTSE_MSG");
    const form = $("#XM_CTSE_FORM");
    try {
        const d = await api(`${nb(node)}/containers/${enc(name)}`);
        if (!state.csel || state.csel.name !== name) return;
        const c = d.config;
        form.querySelectorAll("input, select, textarea, button").forEach((el) => (el.disabled = !d.editable));
        msg.hidden = d.editable;
        msg.textContent = d.editable ? "" : (d.state === "creating"
            ? "The container is still being created; it can be edited afterwards."
            : "This container was created by an older version of XenMox; its settings cannot be edited.");
        $("#ctse-image").value = d.image || "";
        $("#ctse-restart").value = c ? c.restart : "unless-stopped";
        $("#ctse-ports").value = c ? c.ports.join("\n") : "";
        $("#ctse-env").value = c ? c.env.join("\n") : "";
        $("#ctse-volumes").value = c ? c.volumes.join("\n") : "";
        $("#ctse-memory").value = c && c.memory != null ? c.memory : "";
        $("#ctse-cpus").value = c && c.cpus != null ? c.cpus : "";
    } catch (err) {
        msg.hidden = false;
        msg.textContent = err.message;
    }
}

$("#XM_CTSE_FORM").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!state.csel) return;
    const { node, name } = state.csel;
    if (!confirm(`Saving recreates the "${name}" container. Continue?`)) return;
    const btn = $("#XM_CTSE_SAVE");
    btn.disabled = true;
    try {
        await api(`${nb(node)}/containers/${enc(name)}`, jsonOpts("PUT", {
            image: $("#ctse-image").value.trim(),
            restart: $("#ctse-restart").value,
            ports: lines("#ctse-ports"),
            env: lines("#ctse-env"),
            volumes: lines("#ctse-volumes"),
            memory: $("#ctse-memory").value,
            cpus: $("#ctse-cpus").value,
        }));
        ctFormLoaded = null;
        await refreshAll();
        setTab("#XM_CT_TABS", "logs", () => loadLogs());
        showAlert("The change has started: the container will be recreated; its state will update in the list.");
    } catch (err) {
        showAlert(err.message);
    } finally {
        btn.disabled = false;
    }
});

function syncContainer() {
    if (!state.csel) return;
    const { node, name } = state.csel;
    const c = ((state.containers[node] || {}).list || []).find((x) => x.name === name);
    if (!c) return showPane(nodeByKey(node) && nodeByKey(node).online ? "XM_PANE_VMS" : "XM_PANE_DC");

    const cls = ctClass(c);
    $("#XM_CT_TITLE").textContent = `${nodeLabel(node)} / ${c.name} (${c.image})`;
    const st = $("#XM_CT_STATE");
    st.textContent = c.status;
    st.className = "XM_STATUS_" + (cls === "running" ? "running" : "stopped");

    $("#XM_CT_START").disabled = cls !== "stopped";
    $("#XM_CT_STOP").disabled = cls !== "running";
    $("#XM_CT_RESTART").disabled = cls !== "running";
    $("#XM_CT_DELETE").disabled = cls === "creating";

    const note = $("#XM_CT_NOTE");
    note.hidden = !c.note;
    note.textContent = c.note || "";

    if (activeTab("#XM_CT_TABS") === "logs") loadLogs();
    if (activeTab("#XM_CT_TABS") === "settings" && ctFormLoaded !== node + ":" + name && cls !== "creating") loadCtForm(false);
}

async function ctAction(act) {
    if (!state.csel) return;
    const { node, name } = state.csel;
    try {
        await api(`${nb(node)}/containers/${enc(name)}` + (act === "delete" ? "" : "/" + act), {
            method: act === "delete" ? "DELETE" : "POST",
        });
    } catch (e) {
        showAlert(e.message);
    }
    await refreshAll();
}

$("#XM_CT_START").addEventListener("click", () => ctAction("start"));
$("#XM_CT_STOP").addEventListener("click", () => ctAction("stop"));
$("#XM_CT_RESTART").addEventListener("click", () => ctAction("restart"));
$("#XM_CT_DELETE").addEventListener("click", async () => {
    if (!state.csel || !confirm(`Are you sure you want to delete the "${state.csel.name}" container?`)) return;
    await ctAction("delete");
});
$("#XM_CT_REFRESH").addEventListener("click", loadLogs);

// Live stats: only refreshed on the open Stats tab
function tickStats() {
    if (locked) return;
    if (state.vsel && activeTab("#XM_VM_TABS") === "stats") loadVmStats();
    if (state.csel && activeTab("#XM_CT_TABS") === "stats") loadCtStats();
}

// ---------- Startup ----------
showTab(0);
init();
