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

## Bejelentkezés és első beállítás

Új telepítésnél **semmi nem használható**, amíg nincs felhasználó beállítva: a főszerver minden API kérést
elutasít (403), a con-server pedig mindent (503).

- **Főszerver:** az első megnyitáskor a böngészőben egy "Első beállítás" ablak jelenik meg, itt add meg a
  felhasználónevet és a jelszót (min. 8 karakter). Utána bejelentkezés kell. Fent a **Logout** és a jelszócsere (kulcs ikon) gomb.
  Ha nem szeretnéd, hogy a hálózaton bárki beállíthassa az első jelszót, állítsd be parancssorból indítás előtt:
  `npm start -- --setup`
- **Con-server (node):** futtasd egyszer: `npm run con-server -- --setup` (felhasználónév + jelszó). Addig minden kérést visszautasít.
- A jelszavak scrypt-tel hashelve vannak (`data/auth.json`, csak a tulajdonos olvashatja). 5 hibás próbálkozás után 1 percre zárol.
- Nem interaktív beállításhoz: `XENMOX_USER=admin XENMOX_PASS=... npm run con-server -- --setup`.

## Két gép összekötése

1. A **második gépen** állítsd be a con-server felhasználóját (`npm run con-server -- --setup`), majd indítsd: `npm run con-server` (port alapból 3001).
2. A főszerver webes felületén: **Datacenter → Datacenter settings → Add node**
   Adj meg nevet, címet (IP), portot és a **con-server felhasználónevét és jelszavát**.
3. Az új node megjelenik a fában (pl. `prod2`), onnantól ugyanúgy kezelhető, mint a `prod1`:
   VM létrehozás, ISO feltöltés (a feltöltött ISO a *kiválasztott node* gépére kerül), indítás, noVNC konzol.

Régebbi, token alapú node-ot töröld, és add hozzá újra felhasználónévvel/jelszóval.

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

## VM és konténer részletek (statisztika, szerkesztés)

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

## Telepítő ISO és újratelepítés

Az ISO csak a VM első indulásakor bootol (a telepítő végén az újraindulás már a lemezről megy).
Telepítés után vedd ki az ISO-t: VM részletek → **Eject ISO** (futó VM-nél is működik), így a következő indításnál sem kerül vissza.

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
- **Biztonság:** aki be tud jelentkezni, az bármilyen image-et futtathat a gépen, ami gyakorlatilag root hozzáférés. Használj erős jelszót.
- A környezeti változók értéke a gép folyamatlistájában látszhat, jelszavakat ezért óvatosan add meg.
- Host könyvtár csatolása (bind mount) szándékosan nincs: csak nevesített kötetek használhatók.
- Egy konténer belső terminálja (exec) még nincs benne, helyette a napló érhető el.

## Beállítások (környezeti változók)

| Változó | Mód | Alapérték |
|---|---|---|
| `PORT` | főszerver | `3000` |
| `XENMOX_PORT` | con-server | `3001` |
| `XENMOX_USER`, `XENMOX_PASS` | mindkettő | csak a nem interaktív `--setup`-hoz |
| `XENMOX_DATA` | mindkettő | `./data` |

Ha a főszervert és a con-servert ugyanazon a gépen próbálod ki, adj nekik külön `XENMOX_DATA` mappát
(a VNC portok viszont ütközhetnek azonos VM ID esetén, ezért éles használatban külön gépen fussanak).

## Biztonság

- Bejelentkezés kötelező (sütis munkamenet: HttpOnly, SameSite=Strict, 12 óra csúszó lejárat), idegen eredetű módosító kérések és WebSocketek tiltva.
- A főszerver és a con-server közti forgalom sima HTTP, a felhasználónév/jelszó (Basic) is így utazik. Csak megbízható hálózaton
  (LAN/VPN) használd, vagy tegyél elé TLS-t terminálló reverse proxyt (HTTPS-nél a süti automatikusan `Secure`).
- A főszerver a node-ok jelszavát a `data/nodes.json` fájlban tárolja titkosítatlanul (0600 jogosultsággal, csak a tulajdonos olvashatja), mert hozzá kell tudnia kapcsolódni.
- Az első beállítást az végzi el, aki előbb megnyitja a felületet: kerülendő nyílt hálózaton, használd a `--setup` parancsot.
