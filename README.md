# XenMox

> A Proxmox-like virtualization platform that is not a full operating system: a Node.js app with a web UI
> that manages virtual machines (QEMU/KVM) and Docker containers. Need VMs or containers, but don't want to
> install and maintain a dedicated OS? XenMox runs on top of the Linux you already have.
>
> *Independent project, not affiliated with Xen or Proxmox.*

- [English](#english)
- [Magyar](#magyar)

---

## English

Two run modes, the same folder/code:

| Mode | Command | What it's for |
|---|---|---|
| **Main server** (web interface) | `npm start` | Web interface, local node, managing additional nodes |
| **xenmox-con-server** (node agent) | `npm run con-server` | A node running on another machine, controlled by the main server |

### Installation (on every machine)

```bash
apt install nodejs npm qemu-system-x86 qemu-utils
apt install docker.io        # only if you also want Docker containers (optional)
npm install
```

### Login and first-time setup

On a fresh installation **nothing can be used** until a user is set up: the main server rejects every API request
(403), and the con-server rejects everything (503).

- **Main server:** on first opening, a "First-time setup" window appears in the browser; enter the username and
  password (min. 8 characters) there. After that, login is required. At the top you'll find the **Logout** and the
  change-password (key icon) buttons. If you don't want anyone on the network to be able to set the first password,
  set it from the command line before starting: `npm start -- --setup`
- **Con-server (node):** run it once: `npm run con-server -- --setup` (username + password). Until then it rejects
  every request.
- Passwords are hashed with scrypt (`data/auth.json`, readable only by the owner). After 5 failed attempts it locks
  for 1 minute.
- For non-interactive setup: `XENMOX_USER=admin XENMOX_PASS=... npm run con-server -- --setup`.

### Connecting two machines

1. On the **second machine**, set up the con-server user (`npm run con-server -- --setup`), then start it:
   `npm run con-server` (port defaults to 3001).
2. In the main server's web interface: **Datacenter → Datacenter settings → Add node**
   Enter a name, address (IP), port and the **con-server username and password**.
3. The new node appears in the tree (e.g. `prod2`), and from then on it can be managed just like `prod1`:
   creating VMs, uploading ISOs (the uploaded ISO goes to the *selected node's* machine), starting, noVNC console.

Delete older, token-based nodes and add them again with a username/password.

Nodes and the datacenter can be renamed (Datacenter settings), and a remote node can be removed
(the VMs remain on the node; only the connection is removed).

### Connecting two main servers (datacenters)

If the main server runs on two machines (both have a web interface), one can display and control the other's
datacenter: a second `Datacenter (...)` branch appears in the tree with its nodes.

1. In the **other main server's** web interface: **Datacenter settings → Federation token** – copy the token from here.
2. On **your own main server**: **Datacenter settings → Link datacenter** – enter the other machine's address, its port
   (defaults to 3000) and the federation token.
3. The other datacenter (and its nodes) appears in the tree. From then on you can create VMs on it, upload ISOs,
   start/stop VMs and use the noVNC console.

Important notes:

- The datacenter's name is set on the other server (there: **Datacenter settings → Name**); your tree follows it.
  It's worth giving the two servers different names, because by default both are `prod-eu-central`.
- On a linked datacenter you can manage VMs and ISOs, but adding/renaming nodes and renaming the datacenter
  happen in the other server's own interface.
- Linking is not chained: if A links B, and B links C, A does not see C (no loops).
  A and B can also be linked to each other, in which case both see each other.
- Removing the link (Linked datacenters → unlink) deletes nothing on the other server.
- Regenerating the federation token (Regenerate) breaks the existing links.

### VM and container details (statistics, editing)

In the tree, **a single click** opens the VM's console (for a container, its logs), and **a double click** opens the details:

- **Stats:** status, uptime, CPU %, memory, disk, IP address(es), port forwards (refreshed every 3 seconds).
- **Settings:** for a VM: name, OS, ISO, disk (can only be increased), CPU, memory, network card, port forwards
  (only while the VM is stopped). For a container: image, restart policy, ports, environment variables, volumes, limits.
- **Editing a container = recreating it:** changes made inside the container and not stored in a volume are lost;
  volume data is preserved. On error the old container is restored. Containers created with an older XenMox version
  cannot be edited.
- **For accurate VM data** the guest needs the `qemu-guest-agent` (IP address, disk usage) and the virtio-balloon driver
  (guest-side memory usage; present by default on Linux). Without them, memory shows the host-side allocation.
- VMs use a built-in (NAT) network: the guest address is typically `10.0.2.15`, and it can only be reached from outside
  on the ports given in the **Port forwards** field (e.g. `2222:22`).

### Installer ISO and reinstall

The ISO only boots on the VM's first start (at the end of the installer, rebooting already boots from the disk).
After installation, eject the ISO: VM details → **Eject ISO** (works on a running VM too), so it does not come back
on the next start.

### Docker containers

On every node (the local one, the con-server nodes and the linked datacenters too) you can create and manage Docker
containers, if Docker is installed and running on the node.

- **Create container:** name, image (e.g. `nginx:latest`), restart policy, ports (`8080:80`, `5353:53/udp`),
  environment variables (`KEY=value`), named volumes (`volumename:/path`), memory and CPU limit.
- The image download runs in the background; until then the container shows as "creation in progress".
  If the download or the start fails, the error can be read among the container's details, and it can be discarded.
- **Overview / tree:** containers appear next to the VMs (with a docker icon), and can be started, stopped,
  restarted and deleted. Clicking a container opens its logs (the last 300 lines, refreshed every 5 seconds).
- Only containers created by XenMox are managed (label `xenmox.managed=true`); others running on the machine are not
  shown and not touched.
- If Docker is not installed or not running, a message indicates this on the node's Overview panel, and the VMs keep working.

Notes:

- The user running XenMox (usually root) must have access to the Docker service.
- **Security:** whoever can log in can run any image on the machine, which is effectively root access. Use a strong password.
- The values of environment variables may be visible in the machine's process list, so provide passwords with care.
- Host directory binding (bind mount) is intentionally not supported: only named volumes can be used.
- A container's internal terminal (exec) is not included yet; the logs are available instead.

### Settings (environment variables)

| Variable | Mode | Default |
|---|---|---|
| `PORT` | main server | `3000` |
| `XENMOX_PORT` | con-server | `3001` |
| `XENMOX_USER`, `XENMOX_PASS` | both | only for the non-interactive `--setup` |
| `XENMOX_DATA` | both | `./data` |

If you try the main server and the con-server on the same machine, give them separate `XENMOX_DATA` directories
(the VNC ports, however, may conflict for the same VM ID, so in production they should run on separate machines).

### Security

- Login is required (cookie session: HttpOnly, SameSite=Strict, 12-hour sliding expiration); modifying requests and
  WebSockets from foreign origins are blocked.
- Traffic between the main server and the con-server is plain HTTP, and the username/password (Basic) travels this way
  too. Use it only on a trusted network (LAN/VPN), or put a TLS-terminating reverse proxy in front of it (with HTTPS the
  cookie automatically becomes `Secure`).
- The main server stores the nodes' passwords in the `data/nodes.json` file unencrypted (with 0600 permissions, readable
  only by the owner), because it needs to be able to connect to them.
- The first-time setup is done by whoever opens the interface first: avoid this on an open network; use the `--setup`
  command.

---

## Magyar

> Proxmox-szerű virtualizációs platform, ami nem egy teljes operációs rendszer: egy Node.js alkalmazás webes
> felülettel, amely virtuális gépeket (QEMU/KVM) és Docker konténereket kezel. VM vagy konténer kell, de nem
> szeretnél külön OS-t telepíteni és karbantartani? A XenMox a meglévő Linuxodon fut.
>
> *Független projekt, nem áll kapcsolatban a Xen vagy a Proxmox projektekkel.*

Két futtatási mód, ugyanaz a mappa/kód:

| Mód | Parancs | Mire való |
|---|---|---|
| **Főszerver** (webes felület) | `npm start` | Webes felület, helyi node, további node-ok kezelése |
| **xenmox-con-server** (node ügynök) | `npm run con-server` | Egy másik gépen futó node, a főszerver irányítja |

### Telepítés (minden gépen)

```bash
apt install nodejs npm qemu-system-x86 qemu-utils
apt install docker.io        # csak ha Docker konténereket is szeretnél (opcionális)
npm install
```

### Bejelentkezés és első beállítás

Új telepítésnél **semmi nem használható**, amíg nincs felhasználó beállítva: a főszerver minden API kérést
elutasít (403), a con-server pedig mindent (503).

- **Főszerver:** az első megnyitáskor a böngészőben egy "Első beállítás" ablak jelenik meg, itt add meg a
  felhasználónevet és a jelszót (min. 8 karakter). Utána bejelentkezés kell. Fent a **Logout** és a jelszócsere (kulcs ikon) gomb.
  Ha nem szeretnéd, hogy a hálózaton bárki beállíthassa az első jelszót, állítsd be parancssorból indítás előtt:
  `npm start -- --setup`
- **Con-server (node):** futtasd egyszer: `npm run con-server -- --setup` (felhasználónév + jelszó). Addig minden kérést visszautasít.
- A jelszavak scrypt-tel hashelve vannak (`data/auth.json`, csak a tulajdonos olvashatja). 5 hibás próbálkozás után 1 percre zárol.
- Nem interaktív beállításhoz: `XENMOX_USER=admin XENMOX_PASS=... npm run con-server -- --setup`.

### Két gép összekötése

1. A **második gépen** állítsd be a con-server felhasználóját (`npm run con-server -- --setup`), majd indítsd: `npm run con-server` (port alapból 3001).
2. A főszerver webes felületén: **Datacenter → Datacenter settings → Add node**
   Adj meg nevet, címet (IP), portot és a **con-server felhasználónevét és jelszavát**.
3. Az új node megjelenik a fában (pl. `prod2`), onnantól ugyanúgy kezelhető, mint a `prod1`:
   VM létrehozás, ISO feltöltés (a feltöltött ISO a *kiválasztott node* gépére kerül), indítás, noVNC konzol.

Rétegebbi, token alapú node-ot töröld, és add hozzá újra felhasználónévvel/jelszóval.

A node-ok és a datacenter átnevezhetők (Datacenter settings), a távoli node eltávolítható
(a VM-ek ilyenkor a node-on megmaradnak, csak a kapcsolat szűnik meg).

### Két főszerver (datacenter) összekötése

Ha két gépen is a főszerver fut (mindkettőnek van webes felülete), az egyik megjelenítheti és irányíthatja
a másik datacentert: a fában egy második `Datacenter (...)` ág jelenik meg a hozzá tartozó node-okkal.

1. A **másik főszerver** webes felületén: **Datacenter settings → Federation token** – innen másold ki a tokent.
2. A **saját főszervereden**: **Datacenter settings → Link datacenter** – add meg a másik gép címét, a portját (alapból 3000)
   és a federációs tokent.
3. A másik datacenter (és a node-jai) megjelenik a fában. Onnantól VM-et hozhatsz létre rajta, ISO-t tölthetsz fel,
   indíthatod/leállíthatod a VM-eket és használhatod a noVNC konzolt.

Fontos tudnivalók:

- A datacenter neve a másik szerveren állítható (ott a **Datacenter settings → Name**), a te fád ezt követi.
  Érdemes a két szerveren különböző nevet adni, mert alapból mindkettő `prod-eu-central`.
- Összekötött datacenteren VM-et és ISO-t kezelhetsz, de a node-ok hozzáadása/átnevezése és a datacenter
  átnevezése a másik szerver saját felületén történik.
- Az összekötés nem láncolódik: ha A összeköti B-t, és B összeköti C-t, A nem látja C-t (nincs hurok).
  A és B kölcsönösen is összeköthető, ilyenkor mindkettő látja a másikat.
- Az összekötés megszüntetése (Linked datacenters → kapcsolat bontása) a másik szerveren semmit nem töröl.
- A federációs token újragenerálása (Regenerate) megszakítja az eddigi összekötéseket.

### VM és konténer részletek (statisztika, szerkesztés)

A fában **egy kattintás** a VM konzolját (konténernél a naplóját) nyitja, **dupla kattintás** a részleteket:

- **Stats:** állapot, uptime, CPU %, memória, lemez, IP-cím(ek), port továbbítások (3 mp-enként frissül).
- **Settings:** VM-nél név, OS, ISO, lemez (csak növelhető), CPU, memória, hálókártya, port továbbítások
  (csak leállított VM-nél). Konténernél image, újraindítási szabály, portok, környezeti változók, kötetek, korlátok.
- **Konténer szerkesztése = újralétrehozás:** a konténeren belüli, kötetben nem tárolt módosítások elvesznek, a kötetek megmaradnak.
  Hiba esetén a régi konténer visszaáll. A régebbi XenMox verzióban készült konténerek nem szerkeszthetők.
- **Pontos VM adatokhoz** a vendégben kell a `qemu-guest-agent` (IP-cím, lemezhasználat) és a virtio-balloon driver
  (vendég oldali memóriahasználat; Linuxon alapból van). Nélkülük a memória a host oldali foglalást mutatja.
- A VM-ek beépített (NAT) hálózatot használnak: a vendég címe jellemzően `10.0.2.15`, kívülről csak a **Port forwards**
  (pl. `2222:22`) mezőben megadott portokon érhető el.

### Telepítő ISO és újratelepítés

Az ISO csak a VM első indulásakor bootol (a telepítő végén az újraindulás már a lemezről megy).
Telepítés után vedd ki az ISO-t: VM részletek → **Eject ISO** (futó VM-nél is működik), így a következő indításnál sem kerül vissza.

### Docker konténerek

Minden node-on (a helyin, a con-server node-okon és az összekötött datacentereken is) létrehozhatsz és
kezelhetsz Docker konténereket, ha a node-on telepítve van és fut a Docker.

- **Create container:** név, image (pl. `nginx:latest`), újraindítási szabály, portok (`8080:80`, `5353:53/udp`),
  környezeti változók (`KULCS=érték`), nevesített kötetek (`kotetnev:/utvonal`), memória- és CPU-korlát.
- Az image letöltése a háttérben fut, a konténer addig "létrehozás folyamatban" állapotban látszik.
  Ha a letöltés vagy az indítás hibás, a hiba a konténer részletei között olvasható, és elvethető.
- **Overview / fa:** a konténerek a VM-ek mellett látszanak (docker ikonnal), indíthatók, leállíthatók,
  újraindíthatók, törölhetők. Egy konténerre kattintva megnyílik a napló (az utolsó 300 sor, 5 mp-enként frissül).
- Csak a XenMox által létrehozott konténereket kezeli (`xenmox.managed=true` címke), a gépen futó többit nem
  mutatja és nem érinti.
- Ha a Docker nincs telepítve vagy nem fut, a node Overview paneljén ezt egy üzenet jelzi, a VM-ek működnek tovább.

Tudnivalók:

- A XenMox-ot futtató felhasználónak (általában root) hozzá kell férnie a Docker szolgáltatáshoz.
- **Biztonság:** aki be tud jelentkezni, az bármilyen image-et futtathat a gépen, ami gyakorlatilag root hozzáférés. Használj erős jelszót.
- A környezeti változók értéke a gép folyamatlistájában látszhat, jelszavakat ezért óvatosan add meg.
- Host könyvtár csatolása (bind mount) szándékosan nincs: csak nevesített kötetek használhatók.
- Egy konténer belső terminálja (exec) még nincs benne, helyette a napló érhető el.

### Beállítások (környezeti változók)

| Változó | Mód | Alapérték |
|---|---|---|
| `PORT` | főszerver | `3000` |
| `XENMOX_PORT` | con-server | `3001` |
| `XENMOX_USER`, `XENMOX_PASS` | mindkettő | csak a nem interaktív `--setup`-hoz |
| `XENMOX_DATA` | mindkettő | `./data` |

Ha a főszervert és a con-servert ugyanazon a gépen próbálod ki, adj nekik külön `XENMOX_DATA` mappát
(a VNC portok viszont ütközhetnek azonos VM ID esetén, ezért éles használatban külön gépen fussanak).

### Biztonság

- Bejelentkezés kötelező (sütis munkamenet: HttpOnly, SameSite=Strict, 12 óra csúszó lejárat), idegen eredetű módosító kérések és WebSocketek tiltva.
- A főszerver és a con-server közti forgalom sima HTTP, a felhasználónév/jelszó (Basic) is így utazik. Csak megbízható hálózaton
  (LAN/VPN) használd, vagy tegyél elé TLS-t terminálló reverse proxyt (HTTPS-nél a süti automatikusan `Secure`).
- A főszerver a node-ok jelszavát a `data/nodes.json` fájlban tárolja titkosítatlanul (0600 jogosultsággal, csak a tulajdonos olvashatja), mert hozzá kell tudnia kapcsolódni.
- Az első beállítást az végzi el, aki előbb megnyitja a felületet: kerülendő nyílt hálózaton, használd a `--setup` parancsot.
