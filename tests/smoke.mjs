/**
 * BaseVault – Funktions- und Performance-Smoke-Test.
 *
 * Ausführen:
 *   npm install
 *   npm test              (Funktionstests gegen index.html)
 *   npm run test:bench    (zusätzlich Performance-Messwerte)
 *
 * Optional kann eine andere HTML-Datei geprüft werden:
 *   node tests/smoke.mjs pfad/zur/datei.html [--bench]
 *
 * Die Tests laufen mit jsdom (DOM) und fake-indexeddb (Speicher) und decken ab:
 * Tresor anlegen/entsperren/sperren, Profile, Einnahmen, Statistiken, Abrechnung,
 * Recovery-Key-Workflow, Passwortwechsel, Auto-Sperre, Export und große Datenmengen.
 * Tests mit der Kennzeichnung BUG beschreiben bekannte Defekte im Altbestand.
 */
import fs from "node:fs";
import { webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

const defaultFile = fileURLToPath(new URL("../index.html", import.meta.url));
const file = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : defaultFile;
const runBench = process.argv.includes("--bench");
const html = fs.readFileSync(file, "utf8");

const results = [];
const ok = (name, cond, extra = "") => { results.push({ name, pass: !!cond, extra }); console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  (" + extra + ")" : ""}`); };
const info = (name, value) => { results.push({ name, pass: null, extra: String(value) }); console.log(`INFO  ${name}: ${value}`); };
// Bekannte Defekte der Original-Datei: im Original erwartet FAIL, in der neuen Fassung erwartet PASS.
const bugs = (name, cond, extra = "") => { results.push({ name, pass: !!cond, bugFix: true, extra }); console.log(`${cond ? "FIX  " : "BUG  "}${name}${extra ? "  (" + extra + ")" : ""}`); };

// ---------------------------------------------------------------- Test-Suite
let factory = new IDBFactory();
let dom, win, ev;

function makeDom(factoryInstance = new IDBFactory()) {
  const vc = new VirtualConsole(); // Fehler der Seite einsammeln
  const errors = [];
  vc.on("jsdomError", e => errors.push(e.message));
  vc.on("error", (...a) => errors.push(a.map(String).join(" ")));
  const d = new JSDOM(html, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    url: "https://localhost/",
    virtualConsole: vc,
    beforeParse(window) {
      window.__alerts = []; window.__confirms = []; window.__prompts = [];
      window.__clipboard = []; window.__downloads = []; window.__blobs = new Map(); window.__opens = [];
      window.__confirmResult = true; window.__promptQueue = [];
      Object.defineProperty(window, "crypto", { value: webcrypto, configurable: true });
      Object.defineProperty(window, "indexedDB", { value: factoryInstance, configurable: true });
      Object.defineProperty(window, "IDBKeyRange", { value: IDBKeyRange, configurable: true });
      window.TextEncoder = TextEncoder; window.TextDecoder = TextDecoder;
      window.structuredClone = globalThis.structuredClone;
      window.alert = m => window.__alerts.push(String(m));
      window.confirm = m => { window.__confirms.push(String(m)); return window.__confirmResult; };
      window.prompt = m => { window.__prompts.push(String(m)); return window.__promptQueue.length ? window.__promptQueue.shift() : null; };
      Object.defineProperty(window.navigator, "clipboard", { value: { writeText: async t => { window.__clipboard.push(String(t)); } }, configurable: true });
      window.scrollTo = () => {}; window.open = (u) => { window.__opens.push(String(u)); return null; };
      window.URL.createObjectURL = blob => { const id = "blob:mock/" + (window.__blobs.size + 1); window.__blobs.set(id, blob); return id; };
      window.URL.revokeObjectURL = () => {};
      window.HTMLAnchorElement.prototype.click = function () { window.__downloads.push(this.download || "(ohne Namen)"); };
      window.Element.prototype.scrollIntoView = () => {};
      window.Element.prototype.setSelectionRange = window.Element.prototype.setSelectionRange || (() => {});
      window.document.execCommand = () => true;
    },
  });
  const w = d.window;
  const get = code => w.eval(code);
  const settle = async (ms = 40) => { await new Promise(r => setTimeout(r, ms)); };
  const click = async sel => {
    const el = typeof sel === "string" ? w.document.querySelector(sel) : sel;
    if (!el) throw new Error("Element nicht gefunden: " + sel);
    el.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true }));
    await settle();
  };
  const clickByText = async (sel, needle) => {
    const el = [...w.document.querySelectorAll(sel)].find(e => (e.textContent || "").includes(needle));
    if (!el) throw new Error(`Kein ${sel} mit Text "${needle}"`);
    return click(el);
  };
  const setVal = async (id, value, evt = "input") => {
    const el = w.document.getElementById(id);
    if (!el) throw new Error("Feld fehlt: " + id);
    el.value = value;
    el.dispatchEvent(new w.Event(evt, { bubbles: true }));
    await settle(15);
  };
  const addProfile = async (p) => {
    await clickByText("button, div[role=button]", p.name) // falls Karte existiert: nichts tun
      .catch(() => {});
    get("openEditor()");
    await settle(15);
    await setVal("fName", p.name); await setVal("fUser", p.user); await setVal("fPass", p.pass);
    await setVal("fUrl", p.url); await setVal("fNotes", p.notes);
    get("saveProfile()");
    await settle(60);
  };
  return { dom: d, win: w, get, settle, click, clickByText, setVal, addProfile, errors };
}

const pageText = (w) => ((w.document.querySelector("main.app") || w.document.getElementById("root") || { textContent: "" }).textContent || "");
const listHTML = (w) => {
  const host = w.document.getElementById("profileList") || w.document.querySelector("section.grid");
  if (!host) return "";
  const visibleCards = [...host.querySelectorAll(".profile-card")].filter(c => !c.hasAttribute("hidden")).map(c => c.outerHTML).join("");
  const empty = w.document.getElementById("emptyState");
  const emptyHTML = empty && !empty.hasAttribute("hidden") ? empty.outerHTML : (empty ? "" : host.innerHTML.replace(visibleCards, ""));
  return visibleCards + emptyHTML;
};
const has = code => { try { return win.eval(`typeof ${code}`) !== "undefined"; } catch { return false; } };

async function run() {
  // ---------------------------------------------------------------- 1. Setup
  ({ dom, win, ev } = {}); dom = makeDom(factory); win = dom.win;
  const { get, settle, click, clickByText, setVal, addProfile } = dom;
  await settle(80);
  ok("1 Setup-Screen wird angezeigt", !!win.document.getElementById("p1"), win.document.body.textContent.slice(0, 0));

  // ------------------------------------------------------- 2. Tresor anlegen
  await setVal("p1", "testpass123"); await setVal("p2", "testpass123");
  get("createVault()"); await settle(400);
  const code = ((win.document.querySelector(".recovery-code")?.textContent || "").replace(/-/g, ""))
    || (() => { try { return get("state.recoveryCode") || ""; } catch { return ""; } })();
  ok("2 Tresor erstellt (App sichtbar)", !!win.document.getElementById("profileSearch"));
  ok("2b Recovery-Key angezeigt (64 Hex)", /^[0-9a-f]{64}$/i.test(code.trim()));
  ok("2c Alert zur Erstellung", win.__alerts.some(a => a.includes("Tresor erstellt")));
  const rec = await new Promise((res, rej) => {
    const r = factory.databases ? null : null;
    const dbReq = win.indexedDB.open("basevault-db", 1);
    dbReq.onsuccess = () => { const db = dbReq.result; const g = db.transaction("vault", "readonly").objectStore("vault").get("vault"); g.onsuccess = () => res(g.result); g.onerror = () => rej(g.error); };
    dbReq.onerror = () => rej(dbReq.error);
  });
  ok("2d Datensatz-Struktur (v2 + Krypto-Felder)", rec && rec.v === 2 && rec.salt && rec.check && rec.payload && rec.recovery && rec.wrappedRecoveryKey, `v=${rec && rec.v}`);

  // ------------------------------------------------------- 3. Profil anlegen
  get("openEditor()"); await settle(20);
  ok("3a Editor öffnet", !!win.document.getElementById("fName"));
  await setVal("fName", "Creator 01"); await setVal("fUser", "creator01@mail.de"); await setVal("fPass", "Geheim!123");
  await setVal("fUrl", "https://4based.com/profile/creator01"); await setVal("fNotes", "Wichtige Notiz");
  // Favorit umschalten (Original: inline onclick, Neu: data-act) – Tippwerte müssen erhalten bleiben
  await clickByText("button", "Favorit:");
  bugs("Editor behält Eingaben beim Favoriten-Toggle", win.document.getElementById("fName")?.value === "Creator 01");
  // Original verliert DOM-Werte beim Re-Render -> immer erneut ausfüllen
  await setVal("fName", "Creator 01"); await setVal("fUser", "creator01@mail.de"); await setVal("fPass", "Geheim!123");
  await setVal("fUrl", "https://4based.com/profile/creator01"); await setVal("fNotes", "Wichtige Notiz");
  get("saveProfile()"); await settle(80);
  ok("3b Profil gespeichert", get("state.profiles.length") === 1 && get("state.profiles[0].name") === "Creator 01");
  ok("3c Favorit übernommen", get("state.profiles[0].favorite") === true);
  ok("3d Karte gerendert", /Creator 01/.test(listHTML(win)));
  ok("3e Persistiert (DB-Payload enthält Profil)", await (async () => {
    const db = await new Promise((res, rej) => { const r = win.indexedDB.open("basevault-db", 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const v = await new Promise((res, rej) => { const g = db.transaction("vault", "readonly").objectStore("vault").get("vault"); g.onsuccess = () => res(g.result); g.onerror = () => rej(g.error); });
    win.__rec = v;
    const key = await win.eval(`(async()=>{const k=await derive("testpass123",unb64((await dbGet()).salt));return await decrypt(k,(await dbGet()).payload)})()`);
    return Array.isArray(key) && key.length === 1 && key[0].name === "Creator 01";
  })());

  // -------------------------------------------------- 4. Validierung/URL
  get("openEditor()"); await settle(20);
  await setVal("fName", "Creator 02"); await setVal("fUser", "c02"); await setVal("fPass", "pw2345678");
  await setVal("fUrl", "https://böse.example/x");
  get("saveProfile()"); await settle(30);
  ok("4 Ungültige URL wird blockiert", win.__alerts.some(a => a.includes("4based-URL")) && get("state.profiles.length") === 1);
  await setVal("fUrl", "https://4based.com/u/c02");
  await clickByText("button", "Status:");
  await setVal("fName", "Creator 02"); await setVal("fUser", "c02"); await setVal("fPass", "pw2345678"); await setVal("fUrl", "https://4based.com/u/c02");
  get("saveProfile()"); await settle(80);
  ok("4b Zweites Profil gespeichert", get("state.profiles.length") === 2);
  ok("4c Status inaktiv übernommen", get("state.profiles.find(p=>p.name==='Creator 02').active") === false);

  // -------------------------------------------------- 5. Suche / Filter
  await setVal("profileSearch", "creator 02");
  ok("5 Suche filtert Liste", /Creator 02/.test(listHTML(win)) && !/Creator 01/.test(listHTML(win)));
  ok("5b Suchfeld behält Fokus/Wert", win.document.getElementById("profileSearch").value === "creator 02");
  await setVal("profileSearch", "zzz-nichts");
  ok("5c Leerzustand bei Suchtreffer 0", /Kein Profil gefunden/.test(listHTML(win)));
  await setVal("profileSearch", "");
  await clickByText(".filters button", "Favoriten");
  ok("5d Filter Favoriten", /Creator 01/.test(listHTML(win)) && !/Creator 02/.test(listHTML(win)));
  await clickByText(".filters button", "Aktiv");
  ok("5e Filter Aktiv blendet inaktive Profile aus", /Creator 01/.test(listHTML(win)) && !/Creator 02/.test(listHTML(win)));
  await clickByText(".filters button", "Alle");

  // -------------------------------------------------- 6. Einnahmen
  const id1 = get("state.profiles.find(p=>p.name==='Creator 01').id");
  get(`openProfile(${JSON.stringify(id1)})`); await settle(30);
  ok("6a Detail-Modal öffnet", !!win.document.getElementById("profileModal"));
  await clickByText("#profileModal button", "Einnahme hinzufügen"); await settle(30);
  ok("6b Einnahme-Dialog öffnet", !!win.document.getElementById("incomeAmount"));
  const today = new Date();
  const todayKey = today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0") + "-" + String(today.getDate()).padStart(2, "0");
  await setVal("incomeAmount", "47.50"); await setVal("incomeDate", todayKey); await setVal("incomeNote", "Chat");
  get("saveIncome()"); await settle(120);
  ok("6c Einnahme gespeichert", get("state.profiles.find(p=>p.name==='Creator 01').incomes.length") === 1);
  get(`openProfile(${JSON.stringify(id1)})`); await settle(30);
  ok("6d Einnahme im Detail sichtbar", /47,50/.test(win.document.getElementById("profileModal").innerHTML));
  await clickByText("#profileModal button", "Einzahlungen anzeigen"); await settle(30);
  ok("6e Einzahlungsliste aufklappbar", /income-row/.test(win.document.getElementById("profileModal").innerHTML));

  // -------------------------------------------------- 7. Statistiken
  get("setView('stats')"); await settle(60);
  const statsTxt = pageText(win);
  ok("7a Monatsumsatz 47,50 €", /47,50/.test(statsTxt));
  ok("7b Erlös 20 % = 9,50 €", /9,50/.test(statsTxt));
  ok("7c Gesamtumsatz-Karte", /Gesamtumsatz/.test(statsTxt) && /Dein Erlös/.test(statsTxt));
  const prev = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const prevKey = prev.getFullYear() + "-" + String(prev.getMonth() + 1).padStart(2, "0");
  await setVal("billingMonth", prevKey, "change"); await settle(60);
  ok("7d Abrechnungsmonat wechselbar", win.document.getElementById("billingMonth")?.value === prevKey);
  await clickByText("#billingCard button", "Als abgerechnet markieren"); await settle(150);
  ok("7e Abrechnung markiert und persistiert", get(`state.billingStatus[${JSON.stringify(prevKey)}]`) === true);
  await setVal("rangeFrom", todayKey, "change"); await settle(30);
  await setVal("rangeTo", todayKey, "change"); await settle(60);
  ok("7f Zeitraum-Auswertung", /Zeitraum-Umsatz/.test(pageText(win)) && /Zeitraum-Umsatz/.test(win.document.getElementById("profileList") ? "" : win.document.querySelector("main.app").innerHTML));
  await click("#rangeFrom"); await click("#rangeTo");

  // -------------------------------------------------- 8. Passwort/Clipboard
  get(`openProfile(${JSON.stringify(id1)})`); await settle(30);
  await clickByText("#profileModal button", "👁"); await settle(30);
  ok("8a Passwort einblendbar", win.document.getElementById("detailPassword").textContent === "Geheim!123");
  win.__clipboard.length = 0;
  await click("#copyPassBtn"); await settle(30);
  ok("8b Passwort kopiert", win.__clipboard[0] === "Geheim!123");
  win.__clipboard.length = 0;
  const uBtn = [...win.document.querySelectorAll("#profileModal button")].find(b => (b.getAttribute("title") || "").includes("Username kopieren"));
  if (uBtn) await click(uBtn);
  bugs("Username-Kopie ist nicht URL-kodiert", win.__clipboard.includes("creator01@mail.de"), win.__clipboard.slice(-1)[0]);
  ok("8d 4based-URL öffnen vorhanden", /4based\.com/.test(win.document.getElementById("profileModal").innerHTML));

  // -------------------------------------------------- 9. Notizen
  const notesOpen = /Notizen anzeigen/.test(win.document.getElementById("profileModal").innerHTML);
  if (notesOpen) { await clickByText("#profileModal button", "Notizen anzeigen"); await settle(30); }
  ok("9 Notiz sichtbar nach Aufklappen", notesOpen ? /Wichtige Notiz/.test(win.document.getElementById("profileModal").innerHTML) : true);

  // -------------------------------------------------- 10. Einnahme bearbeiten/löschen
  win.__promptQueue.push("99,00", todayKey, "Korrigiert");
  get(`editIncome(${JSON.stringify(id1)}, state.profiles.find(p=>p.name==='Creator 01').incomes[0].id)`); await settle(120);
  ok("10a Einnahme bearbeitet", get("state.profiles.find(p=>p.name==='Creator 01').incomes[0].amount") === 99);
  win.__confirmResult = true;
  get(`deleteIncome(${JSON.stringify(id1)}, state.profiles.find(p=>p.name==='Creator 01').incomes[0].id)`); await settle(120);
  ok("10b Einnahme gelöscht", get("state.profiles.find(p=>p.name==='Creator 01').incomes.length") === 0);

  // -------------------------------------------------- 11. Master-Passwort ändern
  get("setView('settings')"); await settle(40);
  await clickByText(".settings-list button", "Master-Passwort ändern"); await settle(40);
  ok("11a Ändern-Dialog öffnet", !!win.document.getElementById("changeNewMaster"));
  await setVal("changeOldMaster", "testpass123"); await setVal("changeNewMaster", "neuespass456"); await setVal("changeNewMaster2", "neuespass456");
  get("changeMasterPassword()"); await settle(400);
  ok("11b Passwort geändert (Erfolgsmeldung)", win.__alerts.some(a => a.includes("erfolgreich geändert")));
  const codeAfterChange = await win.eval("getRecoveryCode()");
  ok("11c Recovery-Key bleibt gültig", codeAfterChange === code.trim());
  get("lock()"); await settle(40);
  await setVal("loginpass", "testpass123"); get("unlock()"); await settle(300);
  ok("11d Altes Passwort funktioniert nicht mehr", /Falsches Master-Passwort/.test(win.__alerts.join("|")));
  await setVal("loginpass", "neuespass456"); get("unlock()"); await settle(400);
  ok("11e Neues Passwort entsperrt Tresor", get("state.profiles.length") === 2);
  ok("11f Daten intakt (Einnahmen-Array vorhanden)", get("state.profiles.every(p=>Array.isArray(p.incomes))") === true);

  // -------------------------------------------------- 12. Recovery-Workflow
  const beforeRotate = await win.eval("getRecoveryCode()");
  win.__confirmResult = true;
  get("rotateRecovery()"); await settle(300);
  const afterRotate = await win.eval("getRecoveryCode()");
  ok("12a Recovery-Key rotiert", !!afterRotate && afterRotate !== beforeRotate && /^[0-9a-f]{64}$/.test(afterRotate));
  ok("12b Neuer Key entsperrt Daten", await win.eval(`(async()=>{const v=await dbGet();const list=await decrypt(await recoveryKey(${JSON.stringify(afterRotate)}),v.recovery);return list.length===2})()`));
  // Reset über Recovery-Key
  get("lock()"); await settle(30);
  await clickByText(".card button", "Master-Passwort vergessen?"); await settle(40);
  ok("12c Reset-Formular erreichbar", !!win.document.getElementById("recoveryInput"));
  const formatted = afterRotate.match(/.{1,8}/g).join("-");
  await setVal("recoveryInput", formatted); await setVal("newMaster", "resetpass789"); await setVal("newMaster2", "resetpass789");
  get("resetMaster()"); await settle(400);
  ok("12d Reset erfolgreich", win.__alerts.some(a => a.includes("erfolgreich geändert")) && get("state.profiles.length") === 2);
  get("lock()"); await settle(30);
  await setVal("loginpass", "resetpass789"); get("unlock()"); await settle(400);
  ok("12e Neues Passwort nach Reset aktiv", get("state.profiles.length") === 2);

  // -------------------------------------------------- 12f. Navigation, Tools, Modale
  await clickByText(".bottom button", "Tools"); await settle(60);
  ok("12f Tools-Ansicht erreichbar", /Vault exportieren/.test(pageText(win)));
  win.__downloads.length = 0;
  await clickByText(".tool-card", "Vault exportieren"); await settle(80);
  ok("12g Export aus Tools", win.__downloads.some(d => d.includes("basevault")));
  await clickByText(".bottom button", "Einstellungen"); await settle(60);
  ok("12h Einstellungen erreichbar", /Automatische Sperre/.test(pageText(win)));
  for (const m of [...win.document.body.querySelectorAll(".modal")]) m.remove();   // Reste vorheriger Modale schließen
  await clickByText(".settings-list button", "Recovery-Key anzeigen"); await settle(150);
  const shownCode = (win.document.querySelector(".recovery-code")?.textContent || "").trim();
  ok("12i Recovery-Key anzeigbar", /^([0-9a-f]{8}-){7}[0-9a-f]{8}$/i.test(shownCode), shownCode.slice(0, 12));
  win.__clipboard.length = 0;
  await clickByText(".modal button", "Kopieren"); await settle(80);
  ok("12j Recovery-Key kopierbar", (win.__clipboard[0] || "").includes("-"));
  await clickByText(".modal button", "Schließen"); await settle(40);
  ok("12k Modal schließbar", !win.document.querySelector(".recovery-code"));
  await clickByText(".settings-list button", "Über BaseVault"); await settle(60);
  ok("12l Über-Dialog öffnet", [...win.document.querySelectorAll(".modal.open")].some(m => /Steven Baasner/.test(m.textContent)));
  const aboutModal = [...win.document.querySelectorAll(".modal.open")].find(m => /Steven Baasner/.test(m.textContent));
  if (aboutModal) { aboutModal.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true })); await settle(60); }
  ok("12m Über-Dialog schließt per Hintergrund-Klick", ![...win.document.querySelectorAll(".modal")].some(m => /Steven Baasner/.test(m.textContent)));
  get(`openProfile(${JSON.stringify(id1)})`); await settle(40);
  win.__opens.length = 0;
  await clickByText("#profileModal button", "↗"); await settle(40);
  ok("12n 4based-Link öffnet korrekt", win.__opens[0] === "https://4based.com/profile/creator01", String(win.__opens[0]));
  get("closeProfile()"); await settle(40);
  await clickByText(".bottom button", "Dashboard"); await settle(60);
  ok("12o Navigation zurück zum Dashboard", !!win.document.getElementById("profileSearch"));

  // -------------------------------------------------- 13. Export
  win.__downloads.length = 0; win.__blobs.clear();
  get("exportVault()"); await settle(80);
  ok("13a Vault-Export erzeugt Download", win.__downloads.some(d => d.includes("basevault")));
  const vaultBlob = [...win.__blobs.values()][0];
  const vaultJson = vaultBlob ? JSON.parse(await vaultBlob.text()) : null;
  ok("13b Backup enthält nur verschlüsselte Felder", vaultJson && vaultJson.payload && !/Creator 01/.test(JSON.stringify(vaultJson)));
  win.__downloads.length = 0; win.__blobs.clear();
  get("exportRecovery()"); await settle(80);
  ok("13c Recovery-Export erzeugt Download", win.__downloads.some(d => d.includes("recovery")));

  // -------------------------------------------------- 14. Auto-Lock
  if (has("checkAutoLock")) {
    get("setView('settings')"); await settle(30);
    await clickByText(".settings-list button", "Automatische Sperre"); await settle(40);
    ok("14a Auto-Lock-Dialog öffnet", !!win.document.querySelector(".auto-lock-modal"));
    await clickByText(".auto-lock-option", "1 Minute"); await settle(150);
    ok("14b Auto-Lock = 1 Minute gespeichert", Number(get("state.autoLockMinutes")) === 1);
    win.__alerts.length = 0;
    win.eval("state.lastActivityAt = Date.now() - 61000");
    get("checkAutoLock()"); await settle(60);
    ok("14c Automatische Sperre greift", !win.document.getElementById("profileSearch") && win.__alerts.some(a => a.includes("automatisch gesperrt")));
  } else {
    info("14 Auto-Lock-Test", "übersprungen (kein checkAutoLock – Original)");
  }

  // -------------------------------------------------- 15. Neu laden + Entsperren
  const factory2 = factory;
  const reloaded = makeDom(factory2);
  await reloaded.settle(120);
  ok("15a Nach Reload erscheint Login", !!reloaded.win.document.getElementById("loginpass"));
  await reloaded.setVal("loginpass", "resetpass789");
  reloaded.get("unlock()"); await reloaded.settle(500);
  ok("15b Profile nach Reload vorhanden", reloaded.get("state.profiles.length") === 2);
  ok("15c Billing-Status nach Reload vorhanden", Object.keys(reloaded.get("state.billingStatus")).length >= 1);

  // -------------------------------------------------- 16. Große Datenmengen (Spread-Bug)
  if (!get("!!state.key")) { await setVal("loginpass", "resetpass789"); get("unlock()"); await settle(500); }
  try {
    const big = await win.eval(`(async()=>{
      for(let i=0;i<160;i++){ state.profiles.push({id:"p"+i,name:"Profil "+i,user:"user"+i,pass:"x".repeat(20),url:"https://4based.com/",notes:"n".repeat(40),favorite:false,active:true,incomes:Array.from({length:12},(_,j)=>({id:"i"+i+"-"+j,amount:10+j,date:"2026-0"+(1+j%9)+"-10",note:"Einnahme "+i+"-"+j,createdAt:j}))}); }
      await persist(); const v=await dbGet(); const list=await decrypt(state.key,v.payload); return list.length;
    })()`);
    bugs("Großer Tresor (>100 KB) speicherbar (Base64-Chunking)", big === get("state.profiles.length"), `Profile=${big}`);
  } catch (e) {
    bugs("Großer Tresor (>100 KB) speicherbar (Base64-Chunking)", false, String(e.message).slice(0, 60));
  }

  // -------------------------------------------------- Benchmarks
  if (runBench) {
    const bigCount = get("state.profiles.length");
    const incomeCount = get("state.profiles.reduce((n,p)=>n+(p.incomes||[]).length,0)");
    info("BENCH Datensatz (groß)", bigCount + " Profile / " + incomeCount + " Einnahmen (In-Memory)");
    const bench = async (label, code, reps = 5, w = win, e = get) => {
      try {
        e(code.warm || "1");
        const t0 = performance.now();
        for (let i = 0; i < reps; i++) { const r = e(code.run); if (r && r.then) await r; }
        info("BENCH " + label, ((performance.now() - t0) / reps).toFixed(2) + " ms");
      } catch (err) { info("BENCH " + label, "FEHLER: " + String(err.message).slice(0, 60)); }
    };
    await bench("Statistik-Ansicht rendern", { warm: "setView('stats')", run: "renderApp()" });
    await bench("Dashboard rendern", { warm: "setView('dashboard')", run: "renderApp()" });
    await bench("Suche: 30 Tastatureingaben", { warm: "setView('dashboard')", run: `(()=>{const f=document.getElementById('profileSearch');f.value='user'+(Math.random()*200|0);f.dispatchEvent(new Event('input',{bubbles:true}));})()`, batch: 30 }, 30);
    await bench("Filterwechsel (4x)", { warm: "state.query='';setView('dashboard')", run: `(()=>{setFilter('favorites');setFilter('active');setFilter('4based');setFilter('all');})()` });
    await bench("persist() speichern (großer Tresor)", { run: "persist()" }, 5);
    const size = await win.eval(`(async()=>{const v=await dbGet();return v.payload.data.length})()`).catch(() => 0);
    info("BENCH Payload-Größe (gespeichert)", Math.round(size / 1024) + " KB (base64)");
    win.close();

    // Mittlerer Tresor: Speicherdauer fair vergleichbar (Original schafft diese Größe ebenfalls)
    const m = makeDom(new IDBFactory());
    await m.settle(80);
    await m.setVal("p1", "benchpass123"); await m.setVal("p2", "benchpass123");
    m.get("createVault()"); await m.settle(400);
    const mCount = await m.win.eval(`(async()=>{for(let i=0;i<30;i++){state.profiles.push({id:"p"+i,name:"Profil "+i,user:"user"+i,pass:"geheim"+i,url:"https://4based.com/",notes:"Notiz ".repeat(10),favorite:false,active:true,incomes:Array.from({length:6},(_,j)=>({id:"i"+i+"-"+j,amount:10+j,date:"2026-0"+(1+j%9)+"-10",note:"Einnahme "+i+"-"+j,createdAt:j}))});}await persist();return state.profiles.length})()`);
    const mSize = await m.win.eval(`(async()=>{const v=await dbGet();return v.payload.data.length})()`);
    info("BENCH Datensatz (mittel)", mCount + " Profile / " + (mCount * 6) + " Einnahmen · " + Math.round(mSize / 1024) + " KB");
    let t0 = performance.now();
    for (let i = 0; i < 5; i++) await m.win.eval("persist()");
    info("BENCH persist() mittlerer Tresor", ((performance.now() - t0) / 5).toFixed(2) + " ms");
    t0 = performance.now();
    for (let i = 0; i < 5; i++) await m.win.eval("renderApp()");
    info("BENCH Dashboard rendern (30 Profile)", ((performance.now() - t0) / 5).toFixed(2) + " ms");
    m.win.close();
  }

  info("Seitenfehler (jsdom)", dom.errors.length ? dom.errors.slice(0, 3).join(" | ") : "keine");
  const realFails = results.filter(r => r.pass === false && !r.bugFix);
  const bugFails = results.filter(r => r.pass === false && r.bugFix);
  console.log(`\n=== ${realFails.length ? "FAIL" : "OK"}: ${results.filter(r => r.pass === true).length} bestanden, ${realFails.length} echte Fehler, ${bugFails.length} dokumentierte Original-Bugs offen, Datei: ${file} ===`);
  realFails.forEach(f => console.log("   ✗ " + f.name + (f.extra ? " (" + f.extra + ")" : "")));
  win.close();
}

run().catch(e => { console.error("HARNESS-FEHLER:", e); process.exit(2); });
