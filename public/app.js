// ---------- Segédek ----------
const $ = (sel, root = document) => root.querySelector(sel);
const enc = encodeURIComponent;

async function api(url, options = {}) {
    const res = await fetch(url, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Hiba (${res.status})`);
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

function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- Állapot ----------
// Egy node kulcsa: "<datacenter id>/<node id>" (a saját datacenter id-ja: "local")
const state = {
    dcs: [],            // [{id, name, remote, online, nodes:[...]}]
    nodes: {},          // kulcs -> {key, id, name, online, dcId, dcName, remoteDc}
    vms: {},            // kulcs -> [vm]
    isos: {},           // kulcs -> [iso]
    containers: {},     // kulcs -> {list: [konténer], error: szöveg|null}
    csel: null,         // kiválasztott konténer: {node, name}
    node: "local/local", // a menüben kiválasztott node
    sel: null,          // konzolhoz kiválasztott VM: {node, id}
    open: new Set(["dc:local", "local/local"]), // nyitott ágak a fában
};

const nodeByKey = (k) => state.nodes[k];
const ownDc = () => state.dcs.find((d) => !d.remote);

// Az adott node API-jának alap URL-je: saját datacenterben /api/nodes/<id>,
// összekötött datacenterben /api/dcs/<dc>/nodes/<id>
function nb(key) {
    const n = nodeByKey(key);
    if (!n) throw new Error("Ismeretlen node");
    return n.remoteDc ? `/api/dcs/${enc(n.dcId)}/nodes/${enc(n.id)}` : `/api/nodes/${enc(n.id)}`;
}

// Megjelenített név: távoli datacenternél "Datacenter / node"
function nodeLabel(key) {
    const n = nodeByKey(key);
    if (!n) return key;
    return n.remoteDc ? `${n.dcName} / ${n.name}` : n.name;
}

// ---------- Adatok betöltése ----------
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

    renderTree();
    renderVmList();
    renderCtList();
    renderDcPane();
    renderNodeSelect();
    renderCtNodeSelect();
    syncConsole();
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
    const vmItems = vms.map((v) => `
        <li class="${v.status}${state.sel && state.sel.node === n.key && state.sel.id === v.id ? " selected" : ""}"
            data-vm="${v.id}" data-node="${esc(n.key)}">
            <i class="fa-solid fa-desktop"></i> ${v.id} (${esc(v.name)})
        </li>`).join("");

    const ctItems = ((state.containers[n.key] || {}).list || []).map((c) => `
        <li class="${ctClass(c)}${state.csel && state.csel.node === n.key && state.csel.name === c.name ? " selected" : ""}"
            data-ct="${esc(c.name)}" data-node="${esc(n.key)}">
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
            <ul class="XM_TREE_VMS">${vmItems}${ctItems}</ul>` : `<ul><li class="XM_OFFLINE_NOTE">A node nem érhető el</li></ul>`}
        </details>`;
}

function renderTree() {
    $("#XM_TREE_ROOT").innerHTML = state.dcs.map((dc) => {
        const settings = dc.remote ? "" : `<ul><li data-view="XM_PANE_DC"><i class="fa-solid fa-gear"></i> Datacenter settings</li></ul>`;
        const body = dc.online
            ? dc.nodes.map((n) => renderNodeBranch(nodeByKey(`${dc.id}/${n.id}`))).join("")
            : `<ul><li class="XM_OFFLINE_NOTE">${esc(dc.error || "A datacenter nem érhető el")}</li></ul>`;
        return `
            <details data-dc="${esc(dc.id)}" class="XM_TREE_DC" ${state.open.has("dc:" + dc.id) ? "open" : ""}>
                <summary><i class="fa-solid fa-building"></i> Datacenter (${esc(dc.name)})
                    ${dc.remote ? `<span class="XM_DOT ${dc.online ? "online" : "offline"}" title="összekötött datacenter"></span>` : ""}
                </summary>
                ${settings}
                ${body}
            </details>`;
    }).join("");
}

// A nyitott/zárt állapot megőrzése újrarajzoláskor (a toggle nem buborékol, ezért capture)
$("#XM_TREE_ROOT").addEventListener("toggle", (e) => {
    const ds = e.target.dataset || {};
    const key = ds.dc !== undefined ? "dc:" + ds.dc : ds.node;
    if (!key) return;
    if (e.target.open) state.open.add(key);
    else state.open.delete(key);
}, true);

$("#XM_TREE_ROOT").addEventListener("click", (e) => {
    const vmLi = e.target.closest("[data-vm]");
    if (vmLi) return openConsole(vmLi.dataset.node, Number(vmLi.dataset.vm));
    const ctLi = e.target.closest("[data-ct]");
    if (ctLi) return openContainer(ctLi.dataset.node, ctLi.dataset.ct);

    const viewLi = e.target.closest("[data-view]");
    if (!viewLi) return;
    if (viewLi.dataset.node) state.node = viewLi.dataset.node;
    showPane(viewLi.dataset.view);
});

// ---------- Nézetváltás ----------
function showPane(id) {
    document.querySelectorAll(".XM_VIEW_PANE").forEach((p) => (p.hidden = p.id !== id));
    document.querySelectorAll(".XM_PANE_NODE").forEach((el) => (el.textContent = nodeLabel(state.node)));

    if (id !== "XM_PANE_CONSOLE") {
        state.sel = null;
        disconnectConsole();
    }
    if (id !== "XM_PANE_CONTAINER") state.csel = null;
    if (id !== "XM_PANE_CONSOLE" && id !== "XM_PANE_CONTAINER") renderTree();

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
                <small>${n.local ? "helyi" : esc(n.host) + ":" + n.port}</small>
                <small class="${n.online ? "XM_STATUS_running" : "XM_STATUS_stopped"}">${n.online ? "online" : "offline"}</small>
            </span>
            <span>
                <button type="button" class="XM_BTN" data-node-act="rename" data-nid="local/${esc(n.id)}" title="Átnevezés"><i class="fa-solid fa-pen"></i></button>
                ${n.local ? "" : `<button type="button" class="XM_BTN" data-node-act="remove" data-nid="local/${esc(n.id)}" title="Eltávolítás"><i class="fa-solid fa-trash"></i></button>`}
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
                <button type="button" class="XM_BTN" data-dc-act="unlink" data-did="${esc(d.id)}" title="Összekötés megszüntetése"><i class="fa-solid fa-link-slash"></i></button>
            </li>`).join("")
        : "<li>Még nincs összekötött datacenter.</li>";
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
        alert(err.message);
    }
});

$("#XM_DC_NODES").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-node-act]");
    if (!btn) return;
    const key = btn.dataset.nid;
    const n = nodeByKey(key);
    try {
        if (btn.dataset.nodeAct === "rename") {
            const name = prompt("Új név a node-nak:", n.name);
            if (name === null || name.trim() === n.name) return;
            await api(nb(key), jsonOpts("PATCH", { name: name.trim() }));
        } else if (confirm(`Eltávolítod a(z) "${n.name}" node-ot? A VM-ek a node-on megmaradnak, csak a kapcsolat szűnik meg.`)) {
            await api(nb(key), { method: "DELETE" });
            if (state.node === key) state.node = "local/local";
        } else {
            return;
        }
        await refreshAll();
    } catch (err) {
        alert(err.message);
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
            token: $("#XM_AN_TOKEN").value,
        }));
        $("#XM_ADDNODE_FORM").reset();
        state.open.add("local/" + node.id);
        await refreshAll();
    } catch (err) {
        alert(err.message);
    } finally {
        btn.disabled = false;
    }
});

// Másik XenMox főszerver datacenterének összekötése
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
        alert(err.message);
    } finally {
        btn.disabled = false;
    }
});

$("#XM_DC_LINKS").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-dc-act]");
    if (!btn) return;
    const dc = state.dcs.find((d) => d.id === btn.dataset.did);
    if (!dc || !confirm(`Megszünteted az összekötést a(z) "${dc.name}" datacenterrel? A VM-ek a másik szerveren megmaradnak.`)) return;
    try {
        await api(`/api/dcs/${enc(dc.id)}`, { method: "DELETE" });
        if (nodeByKey(state.node) && nodeByKey(state.node).dcId === dc.id) state.node = "local/local";
        await refreshAll();
    } catch (err) {
        alert(err.message);
    }
});

$("#XM_FED_REGEN").addEventListener("click", async () => {
    if (!confirm("Új tokent generálsz. Az eddig összekötött szerverek elveszítik a hozzáférést, amíg meg nem adod nekik az újat. Folytatod?")) return;
    try {
        $("#XM_FED_TOKEN").value = (await api("/api/federation/regenerate", { method: "POST" })).token;
    } catch (err) {
        alert(err.message);
    }
});

// ---------- VM létrehozó ablak ----------
const tabs = document.querySelectorAll(".XM_CVM_TAB");
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

// force: a menüből választott node (az időzített frissítés a felhasználó választását megtartja)
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
        alert(`A VM létrejött a(z) ${nodeLabel(node)} node-on.`);
    } catch (e) {
        alert(e.message);
    } finally {
        nextBtn.disabled = false;
    }
});

// ---------- ISO-k (kiválasztott node) ----------
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
        : "<li>Még nincs feltöltött ISO ezen a node-on.</li>";
}

$("#XM_ISO_LIST").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-del-iso]");
    if (!btn || !confirm("Biztosan törlöd az ISO-t?")) return;
    try {
        await api(`${nb(state.node)}/isos/${enc(btn.dataset.delIso)}`, { method: "DELETE" });
        refreshIsos(state.node);
    } catch (err) {
        alert(err.message);
    }
});

$("#XM_ISO_FORM").addEventListener("submit", (e) => {
    e.preventDefault();
    const file = $("#XM_ISO_FILE").files[0];
    if (!file) return alert("Válassz egy .iso fájlt!");

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
            let msg = "Feltöltési hiba";
            try { msg = JSON.parse(xhr.responseText).error || msg; } catch {}
            alert(msg);
        }
    };
    xhr.onerror = () => {
        bar.hidden = true;
        alert("Hálózati hiba a feltöltés közben");
    };
    xhr.open("POST", `${nb(key)}/isos`);
    xhr.send(fd);
});

// ---------- VM lista (kiválasztott node) ----------
function renderVmList() {
    const vms = state.vms[state.node] || [];
    $("#XM_VM_LIST").innerHTML = vms.length
        ? vms.map((v) => `
            <li>
                <span>
                    <i class="fa-solid fa-desktop"></i> ${v.id} – ${esc(v.name)}
                    <small class="XM_STATUS_${v.status}">${v.status}</small>
                </span>
                <span>
                    ${v.status === "running"
                        ? `<button type="button" class="XM_BTN" data-act="console" data-id="${v.id}" title="Konzol"><i class="fa-solid fa-display"></i></button>
                           <button type="button" class="XM_BTN" data-act="stop" data-id="${v.id}"><i class="fa-solid fa-stop"></i></button>`
                        : `<button type="button" class="XM_BTN" data-act="start" data-id="${v.id}"><i class="fa-solid fa-play"></i></button>
                           <button type="button" class="XM_BTN" data-act="delete" data-id="${v.id}"><i class="fa-solid fa-trash"></i></button>`}
                </span>
            </li>`).join("")
        : "<li>Még nincs VM ezen a node-on.</li>";
}

$("#XM_VM_LIST").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const { act, id } = btn.dataset;
    if (act === "console") return openConsole(state.node, Number(id));
    if (act === "delete" && !confirm("Biztosan törlöd a VM-et és a lemezét?")) return;
    try {
        await api(`${nb(state.node)}/vms/${id}` + (act === "delete" ? "" : "/" + act), {
            method: act === "delete" ? "DELETE" : "POST",
        });
        await new Promise((r) => setTimeout(r, 400));
        refreshAll();
    } catch (err) {
        alert(err.message);
    }
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
        setScreenMsg("Csatlakozás...");
        const { default: RFB } = await import("/novnc/core/rfb.js");
        if (selKey() !== key) return; // közben másik VM-et választottak

        screenEl.innerHTML = "";
        const proto = location.protocol === "https:" ? "wss" : "ws";
        const { node, id } = state.sel;
        const r = new RFB(screenEl, `${proto}://${location.host}${nb(node)}/vms/${id}/vnc`);
        r.scaleViewport = true;
        r.background = "#000";

        r.addEventListener("connect", () => { retries = 0; });
        r.addEventListener("disconnect", () => {
            if (rfb !== r) return; // szándékos lezárás
            rfb = null;
            rfbKey = null;
            setScreenMsg("A kapcsolat megszakadt, újracsatlakozás...");
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
    state.sel = { node, id };
    retries = 0;
    showPane("XM_PANE_CONSOLE");
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
        connectConsole().catch((err) => setScreenMsg("Hiba: " + esc(err.message)));
    } else {
        disconnectConsole();
        setScreenMsg("A VM le van állítva. Indítsd el a Start gombbal.");
    }
}

async function vmAction(act) {
    if (!state.sel) return;
    try {
        await api(`${nb(state.sel.node)}/vms/${state.sel.id}/${act}`, { method: "POST" });
    } catch (e) {
        alert(e.message);
    }
    // indításnál a VNC port, leállításnál a folyamat kilépése miatt
    await new Promise((r) => setTimeout(r, 800));
    await refreshAll();
}

$("#XM_CON_START").addEventListener("click", () => vmAction("start"));
$("#XM_CON_STOP").addEventListener("click", () => vmAction("stop"));
$("#XM_CON_CAD").addEventListener("click", () => rfb && rfb.sendCtrlAltDel());
$("#XM_CON_FULL").addEventListener("click", () => screenEl.requestFullscreen && screenEl.requestFullscreen());

// ---------- Docker konténerek ----------
function ctClass(c) {
    if (c.state === "running") return "running";
    if (c.state === "creating") return "creating";
    if (c.state === "error") return "error";
    return "stopped";
}

// Konténerek listája az Overview panelen (kiválasztott node)
function renderCtList() {
    const info = state.containers[state.node] || { list: [], error: null };
    const msg = $("#XM_CT_MSG");
    msg.hidden = !info.error;
    msg.textContent = info.error ? "Docker: " + info.error : "";

    $("#XM_CT_LIST").innerHTML = info.error ? "" : info.list.length
        ? info.list.map((c) => {
            const cls = ctClass(c);
            const actions = cls === "running"
                ? `<button type="button" class="XM_BTN" data-ctact="open" data-name="${esc(c.name)}" title="Napló"><i class="fa-solid fa-file-lines"></i></button>
                   <button type="button" class="XM_BTN" data-ctact="restart" data-name="${esc(c.name)}" title="Újraindítás"><i class="fa-solid fa-rotate"></i></button>
                   <button type="button" class="XM_BTN" data-ctact="stop" data-name="${esc(c.name)}" title="Leállítás"><i class="fa-solid fa-stop"></i></button>`
                : cls === "stopped"
                    ? `<button type="button" class="XM_BTN" data-ctact="open" data-name="${esc(c.name)}" title="Napló"><i class="fa-solid fa-file-lines"></i></button>
                       <button type="button" class="XM_BTN" data-ctact="start" data-name="${esc(c.name)}" title="Indítás"><i class="fa-solid fa-play"></i></button>
                       <button type="button" class="XM_BTN" data-ctact="delete" data-name="${esc(c.name)}" title="Törlés"><i class="fa-solid fa-trash"></i></button>`
                    : cls === "error"
                        ? `<button type="button" class="XM_BTN" data-ctact="open" data-name="${esc(c.name)}" title="Hiba részletei"><i class="fa-solid fa-file-lines"></i></button>
                           <button type="button" class="XM_BTN" data-ctact="delete" data-name="${esc(c.name)}" title="Elvetés"><i class="fa-solid fa-trash"></i></button>`
                        : "";
            return `
                <li>
                    <span>
                        <i class="fa-brands fa-docker"></i> ${esc(c.name)}
                        <small>${esc(c.image)}</small>
                        <small class="XM_STATUS_${cls === "running" ? "running" : "stopped"}">${esc(c.status)}</small>
                        ${c.ports ? `<small>${esc(c.ports)}</small>` : ""}
                    </span>
                    <span>${actions}</span>
                </li>`;
        }).join("")
        : "<li>Még nincs konténer ezen a node-on.</li>";
}

$("#XM_CT_LIST").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-ctact]");
    if (!btn) return;
    const { ctact, name } = btn.dataset;
    if (ctact === "open") return openContainer(state.node, name);
    if (ctact === "delete" && !confirm(`Biztosan törlöd a(z) "${name}" konténert?`)) return;
    btn.disabled = true;
    try {
        await api(`${nb(state.node)}/containers/${enc(name)}` + (ctact === "delete" ? "" : "/" + ctact), {
            method: ctact === "delete" ? "DELETE" : "POST",
        });
    } catch (err) {
        alert(err.message);
    }
    refreshAll();
});

// Konténer létrehozó űrlap
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
        alert(`A(z) "${name}" konténer létrehozása elindult. Az image letöltése eltarthat egy ideig, az állapota a listában frissül.`);
    } catch (err) {
        alert(err.message);
    } finally {
        btn.disabled = false;
    }
});

// Konténer részletek: állapot, vezérlők, napló
const logEl = $("#XM_CLOG");
let logsBusy = false;

function openContainer(node, name) {
    state.node = node;
    state.csel = { node, name };
    showPane("XM_PANE_CONTAINER");
    renderTree();
    logEl.textContent = "";
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
            logEl.textContent = data.logs || "(nincs napló)";
            if (atBottom) logEl.scrollTop = logEl.scrollHeight;
        }
    } catch (err) {
        logEl.textContent = err.message;
    } finally {
        logsBusy = false;
    }
}

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
    loadLogs();
}

async function ctAction(act) {
    if (!state.csel) return;
    const { node, name } = state.csel;
    try {
        await api(`${nb(node)}/containers/${enc(name)}` + (act === "delete" ? "" : "/" + act), {
            method: act === "delete" ? "DELETE" : "POST",
        });
    } catch (e) {
        alert(e.message);
    }
    await refreshAll();
}

$("#XM_CT_START").addEventListener("click", () => ctAction("start"));
$("#XM_CT_STOP").addEventListener("click", () => ctAction("stop"));
$("#XM_CT_RESTART").addEventListener("click", () => ctAction("restart"));
$("#XM_CT_DELETE").addEventListener("click", async () => {
    if (!state.csel || !confirm(`Biztosan törlöd a(z) "${state.csel.name}" konténert?`)) return;
    await ctAction("delete");
});
$("#XM_CT_REFRESH").addEventListener("click", loadLogs);

// ---------- Indulás ----------
showTab(0);
refreshAll().then(() => showPane("XM_PANE_VMS")).catch(console.error);
setInterval(() => refreshAll().catch(() => {}), 5000);
