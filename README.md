# XenMox

> A Proxmox-like virtualization platform that is not a full operating system: a Node.js app with a web UI
> that manages virtual machines (QEMU/KVM) and Docker containers. Need VMs or containers, but don't want to
> install and maintain a dedicated OS? XenMox runs on top of the Linux you already have.
>
> *Independent project, not affiliated with Xen or Proxmox.*

Két futtatási mód, ugyanaz a mappa/kód:

| Mód | Parancs | Mire való |
|---|---|---|
| **Főszerver** (webes felület) | `npm start` | Webes felület, helyi node, további node-ok kezelése |
| **xenmox-con-server** (node ügynök) | `npm run con-server` | Egy másik gépen futó node, a főszerver irányítja |

## Telepítés (minden gépen)

```bash
apt install nodejs npm qemu-system-x86 qemu-utils
apt install docker.io        # csak ha Docker konténereket is szeretnél (opcionális)
npm install
```

## Két gép összekötése

1. A **második gépen** indítsd el: `npm run con-server`
   Kiírja a portot (alapból 3001) és a **tokent**. A token a `data/con-server.json` fájlban is megvan.
2. A főszerver webes felületén: **Datacenter → Datacenter settings → Add node**
   Adj meg nevet, címet (IP), portot és a tokent.
3. Az új node megjelenik a fában (pl. `prod2`), onnantól ugyanúgy kezelhető, mint a `prod1`:
   VM létrehozás, ISO feltöltés (a feltöltött ISO a *kiválasztott node* gépére kerül), indítás, noVNC konzol.

A node-ok és a datacenter átnevezhetők (Datacenter settings), a távoli node eltávolítható
(a VM-ek ilyenkor a node-on megmaradnak, csak a kapcsolat szűnik meg).

## Két főszerver (datacenter) összekötése

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

## Docker konténerek

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
- **Biztonság:** mivel a felületen nincs bejelentkezés, aki eléri, az bármilyen image-et futtathat a gépen,
  ami gyakorlatilag root hozzáférés. Csak megbízható hálózaton használd.
- A környezeti változók értéke a gép folyamatlistájában látszhat, jelszavakat ezért óvatosan add meg.
- Host könyvtár csatolása (bind mount) szándékosan nincs: csak nevesített kötetek használhatók.
- Egy konténer belső terminálja (exec) még nincs benne, helyette a napló érhető el.

## Beállítások (környezeti változók)

| Változó | Mód | Alapérték |
|---|---|---|
| `PORT` | főszerver | `3000` |
| `XENMOX_PORT` | con-server | `3001` |
| `XENMOX_TOKEN` | con-server | a `data/con-server.json`-ban generált |
| `XENMOX_DATA` | mindkettő | `./data` |

Ha a főszervert és a con-servert ugyanazon a gépen próbálod ki, adj nekik külön `XENMOX_DATA` mappát
(a VNC portok viszont ütközhetnek azonos VM ID esetén, ezért éles használatban külön gépen fussanak).

## Biztonság

- A főszerver webes felületén **nincs bejelentkezés**.
- A főszerver és a con-server közti forgalom sima HTTP, a token is így utazik. Csak megbízható hálózaton
  (LAN/VPN) használd, vagy tegyél elé TLS-t terminálló reverse proxyt.
- A főszerver a node-ok tokenjét a `data/nodes.json` fájlban tárolja (csak a tulajdonos olvashatja).
