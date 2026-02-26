// ---------- CONFIG ----------
const RAW_DIR = "data/raw/";
const JOURNEE_FILES = [
  // Ataovy eto daholo izay efa anananao / hampidirinao
  "journee_01.csv",
  "journee_21.csv",
  "journee_22.csv",
  "journee_23.csv",
  "journee_24.csv",
  "journee_25.csv",
  "journee_26.csv",
  "journee_27.csv",
  "journee_28.csv",
  "journee_29.csv",
  "journee_30.csv",
  "journee_31.csv",
  "journee_32.csv"
];

// thresholds (azontsika ovaina rehefa manana backtest)
const HIGH_CONF = 0.46; // 46%
const VALUE_EDGE = 0.03; // 3% edge

// ---------- STATE ----------
let allRows = [];
let leagues = [];
let journees = [];

document.getElementById("btnLoad").addEventListener("click", loadAllJournees);
document.getElementById("leagueSelect").addEventListener("change", refreshJournees);
document.getElementById("journeeSelect").addEventListener("change", renderTable);
document.getElementById("onlyValue").addEventListener("change", renderTable);
document.getElementById("onlyHighConf").addEventListener("change", renderTable);

async function loadAllJournees(){
  allRows = [];
  setSummary("Chargement raw/journee_XX.csv ...");

  const loaded = [];
  const failed = [];

  for(const f of JOURNEE_FILES){
    const url = RAW_DIR + f;
    try{
      const res = await fetch(url, { cache: "no-store" });
      if(!res.ok) throw new Error(String(res.status));
      const csv = await res.text();
      const rows = parseCSV(csv);

      // auto-set journee from filename if missing
      const j = extractJourneeFromFilename(f);
      rows.forEach(r => {
        if(!r.journee) r.journee = j;
      });

      allRows.push(...rows);
      loaded.push(f);
    }catch(e){
      failed.push(`${f} (${e.message})`);
    }
  }

  if(allRows.length === 0){
    setSummary("❌ Tsy nisy data azo. Jereo hoe marina ve ny anaran'ny fichiers sy path data/raw/");
    document.getElementById("tableWrap").innerHTML = "";
    return;
  }

  leagues = uniq(allRows.map(r => r.league)).sort();
  fillSelect("leagueSelect", leagues);

  refreshJournees();

  const msg = `✅ Loaded: ${loaded.length} fichiers, ${allRows.length} lignes` +
              (failed.length ? `<br>⚠️ Failed: ${failed.join(", ")}` : "");
  document.getElementById("summary").innerHTML = `<p>${msg}</p>`;
}

function refreshJournees(){
  const league = getVal("leagueSelect");
  const rowsL = allRows.filter(r => r.league === league);
  journees = uniq(rowsL.map(r => r.journee)).sort((a,b)=>Number(a)-Number(b));
  fillSelect("journeeSelect", journees);
  renderTable();
}

function renderTable(){
  const league = getVal("leagueSelect");
  const journee = getVal("journeeSelect");
  const onlyValue = document.getElementById("onlyValue").checked;
  const onlyHigh = document.getElementById("onlyHighConf").checked;

  let rows = allRows.filter(r => r.league === league && String(r.journee) === String(journee));
  if(rows.length === 0){
    document.getElementById("tableWrap").innerHTML = "<p>Aucun match.</p>";
    return;
  }

  // compute model (implied probs + value)
  let enriched = rows.map(r => computePick(r));

  if(onlyHigh) enriched = enriched.filter(r => r.conf >= HIGH_CONF);
  if(onlyValue) enriched = enriched.filter(r => r.isValue);

  const acc = computeHitRate(enriched);

  const html = `
    <h3>${escapeHtml(league)} — Journée ${escapeHtml(String(journee))}</h3>

    <p>
      Pick = max prob (odds → prob normalisée). 
      <span class="badge ${acc.badge}">Accuracy: ${acc.acc}%</span>
      <span class="badge ${onlyValue ? "ok" : "no"}">Value only: ${onlyValue ? "ON" : "OFF"}</span>
      <span class="badge ${onlyHigh ? "ok" : "no"}">High conf: ${onlyHigh ? "ON" : "OFF"}</span>
    </p>

    <table>
      <thead>
        <tr>
          <th>Match</th>
          <th>1</th><th>X</th><th>2</th>
          <th>Pick</th>
          <th>Confiance</th>
          <th>Edge</th>
          <th>Value</th>
          <th>Résultat</th>
        </tr>
      </thead>
      <tbody>
        ${enriched.map(r => `
          <tr>
            <td>${escapeHtml(r.home)} vs ${escapeHtml(r.away)}</td>
            <td>${fmt(r.odd_1)}</td>
            <td>${fmt(r.odd_x)}</td>
            <td>${fmt(r.odd_2)}</td>
            <td><span class="badge ${r.badge}">${r.pick}</span></td>
            <td>${(r.conf*100).toFixed(1)}%</td>
            <td>${(r.edge*100).toFixed(1)}%</td>
            <td><span class="badge ${r.isValue ? "ok" : "no"}">${r.isValue ? "YES" : "NO"}</span></td>
            <td>${r.result || ""}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;

  document.getElementById("tableWrap").innerHTML = html;
}

// ---------- MODEL ----------
function computePick(r){
  const p = impliedProbs(r.odd_1, r.odd_x, r.odd_2);
  const pick = argmax({ "1": p.p1, "X": p.px, "2": p.p2 });
  const conf = Math.max(p.p1, p.px, p.p2);

  // "edge": simple heuristic — compare pick prob vs implied prob of the same market after removing margin
  // Here we don't have "true" prob, so edge is 0. But we can define value as "conf above average" or using custom rule.
  // We'll set: edge = conf - (1 / odd_pick)  (with normalization, it's small but usable)
  const oddPick = pick === "1" ? r.odd_1 : (pick === "X" ? r.odd_x : r.odd_2);
  const rawImplied = 1 / oddPick;
  const edge = conf - rawImplied;

  const isValue = edge >= VALUE_EDGE; // adjustable
  const badge = conf >= HIGH_CONF ? "ok" : (conf >= 0.40 ? "warn" : "no");

  return { ...r, pick, conf, edge, isValue, badge };
}

// ---------- CSV + HELPERS ----------
function parseCSV(csv){
  const lines = csv.trim().split(/\r?\n/);
  if(lines.length < 2) return [];
  const headers = lines[0].split(",").map(h => h.trim());

  const out = [];
  for(let i=1;i<lines.length;i++){
    const line = lines[i].trim();
    if(!line) continue;
    const cols = line.split(",");
    const obj = {};
    headers.forEach((h,idx)=> obj[h] = (cols[idx] ?? "").trim());

    obj.odd_1 = toNum(obj.odd_1);
    obj.odd_x = toNum(obj.odd_x);
    obj.odd_2 = toNum(obj.odd_2);

    if(!obj.league || !obj.home || !obj.away) continue;
    if(!isFinite(obj.odd_1) || !isFinite(obj.odd_x) || !isFinite(obj.odd_2)) continue;

    out.push(obj);
  }
  return out;
}

function impliedProbs(o1, ox, o2){
  const p1 = 1/o1, px = 1/ox, p2 = 1/o2;
  const s = p1+px+p2;
  return { p1: p1/s, px: px/s, p2: p2/s };
}

function computeHitRate(rows){
  const labeled = rows.filter(r => r.result === "1" || r.result === "X" || r.result === "2");
  if(labeled.length < 5) return { acc: "n/a", badge:"no" };
  const hits = labeled.filter(r => r.pick === r.result).length;
  const acc = (hits / labeled.length * 100).toFixed(1);
  const badge = acc >= 45 ? "ok" : (acc >= 38 ? "warn" : "no");
  return { acc, badge };
}

function extractJourneeFromFilename(name){
  // journee_21.csv -> 21
  const m = name.match(/journee[_-](\d+)/i);
  return m ? m[1] : "";
}

function uniq(arr){ return [...new Set(arr.filter(Boolean))]; }
function fillSelect(id, arr){
  const sel = document.getElementById(id);
  sel.innerHTML = arr.map(v => `<option value="${escapeHtml(String(v))}">${escapeHtml(String(v))}</option>`).join("");
}
function getVal(id){ return document.getElementById(id).value; }
function setSummary(msg){
  document.getElementById("summary").innerHTML = `<p>${escapeHtml(msg)}</p>`;
}
function toNum(s){
  if(s === null || s === undefined) return NaN;
  const v = String(s).replace(",", ".").trim();
  return Number(v);
}
function fmt(n){
  if(!isFinite(n)) return "";
  return Number(n).toFixed(2);
}
function argmax(map){
  let bestK = null, bestV = -Infinity;
  for(const k in map){
    if(map[k] > bestV){ bestV = map[k]; bestK = k; }
  }
  return bestK;
}
function escapeHtml(str){
  return str.replace(/[&<>"']/g, m => ({
    "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"
  }[m]));
}
