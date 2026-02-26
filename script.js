/* ===========================
   Preductor 1X2 — JS PRO
   - Loads data/raw/journee_XX.csv (range)
   - Rolling backtest with calibration by confidence bins
   - No-bet rule + value filter + ROI simulation
   =========================== */

const RAW_DIR = "data/raw/";

// Journée range (ovay raha ilaina)
const JOURNEE_MIN = 1;
const JOURNEE_MAX = 40;

// Filenames accepted: journee_21.csv OR journee_01.csv
function candidateFilesForJournee(j) {
  const jj = String(j).padStart(2, "0");
  return [`journee_${j}.csv`, `journee_${jj}.csv`];
}

// Betting rules (ovaina rehefa mahita backtest)
const CONF_MIN = 0.40;       // min normalized conf to consider
const EDGE_MIN = 0.03;       // min edge (calibrated_p - 1/oddPick)
const CALIB_MIN_P = 0.36;    // min calibrated probability to place bet
const MIN_TRAIN_SAMPLES = 30;// min samples required before trusting calibration
const BIN_SIZE = 0.02;       // confidence bin width

// UI ids expected in index.html (if missing, script will create minimal blocks)
const UI = {
  btnLoad: "btnLoad",
  leagueSelect: "leagueSelect",
  journeeSelect: "journeeSelect",
  onlyValue: "onlyValue",
  onlyHighConf: "onlyHighConf",
  summary: "summary",
  tableWrap: "tableWrap"
};

let allRows = [];     // all matches loaded
let fileStatus = [];  // load report
let leagues = [];
let journees = [];

/* ---------- Boot ---------- */
ensureUI();

document.getElementById(UI.btnLoad).addEventListener("click", async () => {
  await loadAllRaw();
  fillSelectors();
  renderJourneeView();
});

document.getElementById(UI.leagueSelect).addEventListener("change", () => {
  refreshJourneesForLeague();
  renderJourneeView();
});

document.getElementById(UI.journeeSelect).addEventListener("change", renderJourneeView);
document.getElementById(UI.onlyValue).addEventListener("change", renderJourneeView);
document.getElementById(UI.onlyHighConf).addEventListener("change", renderJourneeView);

// extra button: backtest
document.getElementById("btnBacktest").addEventListener("click", () => {
  if (!allRows.length) {
    setSummary("❌ Charge d'abord les journées.");
    return;
  }
  runBacktestAndRender();
});

/* ---------- Load raw ---------- */
async function loadAllRaw() {
  allRows = [];
  fileStatus = [];
  setSummary("Chargement des fichiers raw...");

  for (let j = JOURNEE_MIN; j <= JOURNEE_MAX; j++) {
    const files = candidateFilesForJournee(j);
    let loaded = false;

    for (const f of files) {
      const url = RAW_DIR + f;
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const csv = await res.text();
        const rows = parseCSV(csv);

        // enforce journee from file name if missing
        rows.forEach(r => { if (!r.journee) r.journee = String(j); });

        allRows.push(...rows);
        fileStatus.push({ file: f, ok: true, msg: `${rows.length} lignes` });
        loaded = true;
        break;
      } catch (e) {
        // try next candidate
      }
    }

    if (!loaded) {
      // not fatal
      fileStatus.push({ file: `journee_${j}.csv`, ok: false, msg: "missing" });
    }
  }

  // sanitize
  allRows = allRows.filter(r => isFinite(r.odd_1) && isFinite(r.odd_x) && isFinite(r.odd_2));

  if (!allRows.length) {
    setSummary("❌ Aucun fichier raw chargé. Vérifie: data/raw/journee_XX.csv");
    return;
  }

  const okCount = fileStatus.filter(x => x.ok).length;
  const missCount = fileStatus.filter(x => !x.ok).length;

  setSummary(
    `✅ Data loaded: ${allRows.length} matches<br>` +
    `📦 Fichiers OK: ${okCount} | Missing: ${missCount}<br>` +
    `⚙️ Rules: CONF_MIN=${pct(CONF_MIN)}, EDGE_MIN=${pct(EDGE_MIN)}, CALIB_MIN_P=${pct(CALIB_MIN_P)}`
  );
}

/* ---------- UI ---------- */
function fillSelectors() {
  leagues = uniq(allRows.map(r => r.league)).sort();
  fillSelect(UI.leagueSelect, leagues);

  refreshJourneesForLeague();
}

function refreshJourneesForLeague() {
  const league = getVal(UI.leagueSelect);
  const rowsL = allRows.filter(r => r.league === league);
  journees = uniq(rowsL.map(r => r.journee)).sort((a,b)=>Number(a)-Number(b));
  fillSelect(UI.journeeSelect, journees);
}

function renderJourneeView() {
  if (!allRows.length) {
    document.getElementById(UI.tableWrap).innerHTML =
      `<p>➡️ Clique <b>Charger Journées (raw)</b>.</p>`;
    return;
  }

  const league = getVal(UI.leagueSelect);
  const journee = getVal(UI.journeeSelect);

  const onlyValue = document.getElementById(UI.onlyValue).checked;
  const onlyHigh = document.getElementById(UI.onlyHighConf).checked;

  const rows = allRows.filter(r => r.league === league && String(r.journee) === String(journee));
  if (!rows.length) {
    document.getElementById(UI.tableWrap).innerHTML = "<p>Aucun match.</p>";
    return;
  }

  // Build calibration from ALL previous jours in same league (rolling idea)
  const train = allRows
    .filter(r => r.league === league && Number(r.journee) < Number(journee))
    .filter(r => isResult(r.result));

  const calib = buildCalibration(train);

  let enriched = rows.map(r => scoreMatch(r, calib));

  if (onlyHigh) enriched = enriched.filter(r => r.conf >= CONF_MIN);
  if (onlyValue) enriched = enriched.filter(r => r.isBet);

  const labeled = enriched.filter(r => isResult(r.result));
  const acc = labeled.length ? (labeled.filter(r => r.pick === r.result).length / labeled.length) : null;

  const bets = enriched.filter(r => r.isBet);
  const roi = computeROI(bets);

  const html = `
    <h3>${esc(league)} — Journée ${esc(String(journee))}</h3>

    <p>
      Train samples (prev jours): <b>${train.length}</b> |
      Calibration: <b>${calib.ready ? "READY" : "LOW DATA"}</b> |
      Accuracy (if results): <b>${acc === null ? "n/a" : pct(acc)}</b> |
      Bets: <b>${bets.length}</b> |
      ROI: <b>${roi.roi === null ? "n/a" : pct(roi.roi)}</b>
    </p>

    <table>
      <thead>
        <tr>
          <th>Match</th>
          <th>1</th><th>X</th><th>2</th>
          <th>Pick</th>
          <th>Conf</th>
          <th>Calib P</th>
          <th>Edge</th>
          <th>BET?</th>
          <th>Result</th>
          <th>P/L</th>
        </tr>
      </thead>
      <tbody>
        ${enriched.map(r => `
          <tr>
            <td>${esc(r.home)} vs ${esc(r.away)}</td>
            <td>${fmt(r.odd_1)}</td>
            <td>${fmt(r.odd_x)}</td>
            <td>${fmt(r.odd_2)}</td>
            <td><span class="badge ${r.badge}">${r.pick}</span></td>
            <td>${pct(r.conf)}</td>
            <td>${pct(r.calibP)}</td>
            <td>${pct(r.edge)}</td>
            <td><span class="badge ${r.isBet ? "ok" : "no"}">${r.isBet ? "BET" : "NO"}</span></td>
            <td>${r.result || ""}</td>
            <td>${r.pl === null ? "" : r.pl.toFixed(2)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;

  document.getElementById(UI.tableWrap).innerHTML = html;
}

function runBacktestAndRender() {
  // Rolling backtest per league: for each journee, calibrate on prev days then score and place bets
  const byLeague = groupBy(allRows, r => r.league);
  const report = [];

  for (const league of Object.keys(byLeague).sort()) {
    const rowsL = byLeague[league].slice().sort((a,b)=>Number(a.journee)-Number(b.journee));

    const jours = uniq(rowsL.map(r => r.journee)).sort((a,b)=>Number(a)-Number(b));
    let bank = 0;
    let peak = 0;
    let maxDD = 0;

    let betsN = 0;
    let winsN = 0;

    for (const j of jours) {
      const train = rowsL.filter(r => Number(r.journee) < Number(j) && isResult(r.result));
      const calib = buildCalibration(train);

      const test = rowsL.filter(r => String(r.journee) === String(j));
      const scored = test.map(r => scoreMatch(r, calib));
      const bets = scored.filter(r => r.isBet);

      // settle bets where result exists
      for (const b of bets) {
        if (!isResult(b.result)) continue;
        betsN += 1;
        if (b.pick === b.result) winsN += 1;
        bank += b.pl;
        peak = Math.max(peak, bank);
        maxDD = Math.max(maxDD, peak - bank);
      }
    }

    const roi = betsN ? (bank / betsN) : null;
    const acc = betsN ? (winsN / betsN) : null;

    report.push({
      league,
      bets: betsN,
      winrate: acc,
      profit: bank,
      roi,
      maxDD
    });
  }

  const html = `
    <h3>📈 Backtest (Rolling) — Résumé</h3>
    <p>Règles: bet si conf>=${pct(CONF_MIN)}, calibP>=${pct(CALIB_MIN_P)}, edge>=${pct(EDGE_MIN)} (1 unité/bet)</p>

    <table>
      <thead>
        <tr>
          <th>League</th>
          <th>Bets</th>
          <th>Winrate</th>
          <th>Profit</th>
          <th>ROI/bet</th>
          <th>Max Drawdown</th>
        </tr>
      </thead>
      <tbody>
        ${report.map(r => `
          <tr>
            <td>${esc(r.league)}</td>
            <td>${r.bets}</td>
            <td>${r.winrate === null ? "n/a" : pct(r.winrate)}</td>
            <td>${r.profit.toFixed(2)}</td>
            <td>${r.roi === null ? "n/a" : pct(r.roi)}</td>
            <td>${r.maxDD.toFixed(2)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>

    <p class="badge warn">Tip: raha bets be nefa ROI ratsy → ahenjana ny EDGE_MIN na CALIB_MIN_P (NO BET betsaka kokoa).</p>
  `;

  // append on top of tableWrap
  document.getElementById(UI.tableWrap).innerHTML = html + document.getElementById(UI.tableWrap).innerHTML;
}

/* ---------- Core scoring ---------- */
function scoreMatch(r, calib) {
  // base probs from odds (normalized)
  const p = impliedProbs(r.odd_1, r.odd_x, r.odd_2);
  const pick = argmax({ "1": p.p1, "X": p.px, "2": p.p2 });
  const conf = Math.max(p.p1, p.px, p.p2);
  const oddPick = pick === "1" ? r.odd_1 : (pick === "X" ? r.odd_x : r.odd_2);

  // calibrated probability from historical bins (if enough data, else fallback to conf)
  const calibP = calib.ready ? calib.predict(conf) : conf;

  const impliedPick = 1 / oddPick;          // bookmaker implied (not normalized)
  const edge = calibP - impliedPick;        // value proxy

  const isBet =
    (conf >= CONF_MIN) &&
    (calibP >= CALIB_MIN_P) &&
    (edge >= EDGE_MIN) &&
    (oddPick >= 1.20); // avoid tiny odds

  // P/L if result exists (stake 1)
  let pl = null;
  if (isBet && isResult(r.result)) {
    pl = (pick === r.result) ? (oddPick - 1) : -1;
  }

  const badge = conf >= 0.46 ? "ok" : (conf >= 0.40 ? "warn" : "no");

  return { ...r, pick, conf, calibP, edge, isBet, pl, badge };
}

/* ---------- Calibration by confidence bins ---------- */
function buildCalibration(trainRows) {
  // We want mapping: conf bin -> empirical winrate of "pick==result"
  // Train rows already have odds + result
  if (trainRows.length < MIN_TRAIN_SAMPLES) {
    return { ready: false, predict: (c) => c };
  }

  const bins = new Map(); // key -> {n, wins}
  for (const r of trainRows) {
    const p = impliedProbs(r.odd_1, r.odd_x, r.odd_2);
    const pick = argmax({ "1": p.p1, "X": p.px, "2": p.p2 });
    const conf = Math.max(p.p1, p.px, p.p2);

    const key = binKey(conf);
    if (!bins.has(key)) bins.set(key, { n: 0, wins: 0 });
    const b = bins.get(key);
    b.n += 1;
    if (pick === r.result) b.wins += 1;
  }

  // Smoothing + interpolation
  const keys = Array.from(bins.keys()).map(Number).sort((a,b)=>a-b);

  function predict(conf) {
    const k = binKey(conf);
    const kk = Number(k);

    // exact bin
    if (bins.has(k)) {
      const b = bins.get(k);
      return smoothRate(b.wins, b.n);
    }

    // interpolate between nearest bins
    let left = null, right = null;
    for (const x of keys) {
      if (x <= kk) left = x;
      if (x >= kk) { right = x; break; }
    }
    if (left === null && right === null) return conf;
    if (left === null) {
      const b = bins.get(String(right));
      return smoothRate(b.wins, b.n);
    }
    if (right === null) {
      const b = bins.get(String(left));
      return smoothRate(b.wins, b.n);
    }
    if (left === right) {
      const b = bins.get(String(left));
      return smoothRate(b.wins, b.n);
    }

    const bL = bins.get(String(left));
    const bR = bins.get(String(right));
    const pL = smoothRate(bL.wins, bL.n);
    const pR = smoothRate(bR.wins, bR.n);

    const t = (kk - left) / (right - left);
    return pL + t * (pR - pL);
  }

  return { ready: true, predict };
}

function binKey(conf) {
  const k = Math.floor(conf / BIN_SIZE) * BIN_SIZE;
  return k.toFixed(2);
}

// Laplace smoothing
function smoothRate(w, n) {
  return (w + 1) / (n + 2);
}

/* ---------- ROI ---------- */
function computeROI(bets) {
  // include only settled bets
  const settled = bets.filter(b => b.pl !== null);
  if (!settled.length) return { roi: null, profit: 0, n: 0 };
  const profit = settled.reduce((s,b)=>s+b.pl, 0);
  const roi = profit / settled.length;
  return { roi, profit, n: settled.length };
}

/* ---------- CSV ---------- */
function parseCSV(csv) {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map(h => h.trim());

  const out = [];
  for (let i=1; i<lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = line.split(",");

    const obj = {};
    headers.forEach((h, idx) => obj[h] = (cols[idx] ?? "").trim());

    // normalize expected fields
    obj.league = obj.league || obj.League || "";
    obj.journee = obj.journee || obj.j || "";
    obj.home = obj.home || obj.Home || "";
    obj.away = obj.away || obj.Away || "";
    obj.result = (obj.result || obj.Result || "").toUpperCase();

    obj.odd_1 = toNum(obj.odd_1 ?? obj.odd1 ?? obj["1"]);
    obj.odd_x = toNum(obj.odd_x ?? obj.oddx ?? obj["X"]);
    obj.odd_2 = toNum(obj.odd_2 ?? obj.odd2 ?? obj["2"]);

    if (!obj.league || !obj.home || !obj.away) continue;
    if (!isFinite(obj.odd_1) || !isFinite(obj.odd_x) || !isFinite(obj.odd_2)) continue;

    // sanitize result
    if (obj.result === "D") obj.result = "X";
    if (!isResult(obj.result)) obj.result = ""; // allow missing

    out.push(obj);
  }
  return out;
}

/* ---------- Math ---------- */
function impliedProbs(o1, ox, o2) {
  const p1 = 1/o1, px = 1/ox, p2 = 1/o2;
  const s = p1 + px + p2;
  return { p1: p1/s, px: px/s, p2: p2/s };
}

function argmax(map) {
  let bestK = null, bestV = -Infinity;
  for (const k in map) {
    if (map[k] > bestV) { bestV = map[k]; bestK = k; }
  }
  return bestK;
}

/* ---------- Helpers ---------- */
function isResult(r) { return r === "1" || r === "X" || r === "2"; }

function uniq(arr) { return [...new Set(arr.filter(Boolean))]; }

function groupBy(arr, keyFn) {
  const m = {};
  for (const x of arr) {
    const k = keyFn(x);
    if (!m[k]) m[k] = [];
    m[k].push(x);
  }
  return m;
}

function fillSelect(id, arr) {
  const sel = document.getElementById(id);
  sel.innerHTML = arr.map(v => `<option value="${esc(String(v))}">${esc(String(v))}</option>`).join("");
}

function getVal(id) {
  const el = document.getElementById(id);
  return el ? el.value : "";
}

function setSummary(html) {
  document.getElementById(UI.summary).innerHTML = `<p>${html}</p>`;
}

function toNum(s) {
  if (s === null || s === undefined) return NaN;
  const v = String(s).replace(",", ".").trim();
  const n = Number(v);
  return n;
}

function fmt(n) {
  if (!isFinite(n)) return "";
  return Number(n).toFixed(2);
}

function pct(x) {
  if (x === null || x === undefined || !isFinite(x)) return "n/a";
  return (x * 100).toFixed(1) + "%";
}

function esc(str) {
  return String(str).replace(/[&<>"']/g, m => ({
    "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"
  }[m]));
}

/* ---------- Ensure UI exists ---------- */
function ensureUI() {
  // If you already have these in index.html, this does nothing.
  const container = document.querySelector(".container") || document.body;

  if (!document.getElementById(UI.btnLoad)) {
    const btn = document.createElement("button");
    btn.id = UI.btnLoad;
    btn.textContent = "Charger Journées (raw)";
    container.prepend(btn);
  }

  if (!document.getElementById("btnBacktest")) {
    const btn = document.createElement("button");
    btn.id = "btnBacktest";
    btn.textContent = "Backtest (Rolling)";
    btn.style.marginLeft = "10px";
    const controls = document.querySelector(".controls") || container;
    controls.appendChild(btn);
  }

  if (!document.getElementById(UI.leagueSelect)) {
    const sel = document.createElement("select");
    sel.id = UI.leagueSelect;
    container.appendChild(sel);
  }
  if (!document.getElementById(UI.journeeSelect)) {
    const sel = document.createElement("select");
    sel.id = UI.journeeSelect;
    container.appendChild(sel);
  }

  if (!document.getElementById(UI.onlyValue)) {
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.id = UI.onlyValue;
    container.appendChild(cb);
  }
  if (!document.getElementById(UI.onlyHighConf)) {
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.id = UI.onlyHighConf;
    container.appendChild(cb);
  }

  if (!document.getElementById(UI.summary)) {
    const div = document.createElement("div");
    div.id = UI.summary;
    div.className = "card";
    container.appendChild(div);
  }
  if (!document.getElementById(UI.tableWrap)) {
    const div = document.createElement("div");
    div.id = UI.tableWrap;
    div.className = "card";
    container.appendChild(div);
  }
}
