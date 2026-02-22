(function () {
  // -------- Helpers --------
  function $(id) {
    return document.getElementById(id);
  }

  function show(msg) {
    const box = $("resultBox");
    if (box) box.innerHTML = msg;
  }

  // Support "2,30" sy "2.30"
  function toNumber(val) {
    if (val == null) return NaN;
    const s = String(val).trim().replace(/\s+/g, "").replace(",", ".");
    const n = Number(s);
    return Number.isFinite(n) ? n : NaN;
  }

  function percent(x) {
    return (x * 100).toFixed(1) + "%";
  }

  // -------- Fallback (Odds -> implied probs) --------
  function impliedProbs(o1, ox, o2) {
    const p1 = 1 / o1;
    const px = 1 / ox;
    const p2 = 1 / o2;
    const sum = p1 + px + p2;
    return { p1: p1 / sum, px: px / sum, p2: p2 / sum };
  }

  function pickOutcome(p) {
    if (p.p1 >= p.px && p.p1 >= p.p2) return { key: "1", prob: p.p1, label: "1 (Home)" };
    if (p.px >= p.p1 && p.px >= p.p2) return { key: "X", prob: p.px, label: "X (Draw)" };
    return { key: "2", prob: p.p2, label: "2 (Away)" };
  }

  function exactScoreFromProbs(p) {
    const out = pickOutcome(p);
    if (out.key === "X") return p.px > 0.38 ? "1-1" : "0-0";
    if (out.key === "1") return p.p1 >= 0.60 ? "2-0" : p.p1 >= 0.52 ? "2-1" : "1-0";
    return p.p2 >= 0.60 ? "0-2" : p.p2 >= 0.52 ? "1-2" : "0-1";
  }

  // -------- CSV / DATA --------
  let DATA = [];
  let DATA_READY = false;

  function stripBOM(text) {
    return text.replace(/^\uFEFF/, "");
  }

  // detect delimiter on header line: ; or ,
  function detectDelimiter(headerLine) {
    const semi = headerLine.split(";").length;
    const comma = headerLine.split(",").length;
    return semi > comma ? ";" : ",";
  }

  // parse a CSV line that may contain quotes
  function splitCSVLine(line, delim) {
    const out = [];
    let cur = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];

      if (ch === '"') {
        // handle escaped quotes ""
        if (inQuotes && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }

      if (!inQuotes && ch === delim) {
        out.push(cur.trim());
        cur = "";
        continue;
      }

      cur += ch;
    }
    out.push(cur.trim());
    return out;
  }

  function parseCSVSmart(text) {
    text = stripBOM(text);
    const lines = text.trim().split(/\r?\n/).filter(Boolean);
    if (!lines.length) return [];

    const delim = detectDelimiter(lines[0]);
    const headers = splitCSVLine(lines[0], delim).map((h) => h.trim());

    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const values = splitCSVLine(lines[i], delim);
      if (!values.length) continue;

      const obj = {};
      headers.forEach((h, idx) => (obj[h] = (values[idx] ?? "").trim()));
      rows.push(obj);
    }
    return rows;
  }

  // normalize headers: accept variations
  function pickField(obj, candidates) {
    for (const k of candidates) {
      if (obj[k] != null && String(obj[k]).trim() !== "") return obj[k];
    }
    return "";
  }

  async function loadCSV() {
    const url = "./data/france_virtual_league.csv";
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error("CSV tsy voa-load: " + res.status);

    const text = await res.text();
    const raw = parseCSVSmart(text);

    // map fields safely (raha samy hafa ny header)
    const rows = raw.map((r) => {
      const out = {};

      out.journee = pickField(r, ["journee", "Journee", "Journée", "JOURNEE"]);
      out.home = pickField(r, ["home", "Home", "HOME"]);
      out.away = pickField(r, ["away", "Away", "AWAY"]);

      out.odd_1 = toNumber(pickField(r, ["odd_1", "Odd1", "odd1", "Odd 1", "Odd_1"]));
      out.odd_x = toNumber(pickField(r, ["odd_x", "OddX", "oddx", "Odd X", "Odd_X"]));
      out.odd_2 = toNumber(pickField(r, ["odd_2", "Odd2", "odd2", "Odd 2", "Odd_2"]));

      out.odd_g = toNumber(pickField(r, ["odd_g", "OddG", "oddg", "Odd G", "Odd_G"]));
      out.odd_ng = toNumber(pickField(r, ["odd_ng", "OddNG", "oddng", "Odd NG", "Odd_NG"]));

      out.result = pickField(r, ["result", "Result", "score", "Score", "RESULT"]);

      return out;
    });

    // keep only valid odds rows
    const clean = rows.filter(
      (r) => Number.isFinite(r.odd_1) && Number.isFinite(r.odd_x) && Number.isFinite(r.odd_2)
    );

    return clean;
  }

  function renderTable(rows, limit = 50) {
    const tbody = document.querySelector("#matchesTable tbody");
    if (!tbody) return;

    tbody.innerHTML = "";
    rows.slice(0, limit).forEach((r) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${r.journee || "-"}</td>
        <td>${r.home || "-"}</td>
        <td>${r.away || "-"}</td>
        <td>${Number.isFinite(r.odd_1) ? r.odd_1 : "-"}</td>
        <td>${Number.isFinite(r.odd_x) ? r.odd_x : "-"}</td>
        <td>${Number.isFinite(r.odd_2) ? r.odd_2 : "-"}</td>
        <td>${Number.isFinite(r.odd_g) ? r.odd_g : "-"}</td>
        <td>${Number.isFinite(r.odd_ng) ? r.odd_ng : "-"}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  function outcomeFromScore(scoreStr) {
    const m = String(scoreStr).match(/(\d+)\s*-\s*(\d+)/);
    if (!m) return null;
    const h = Number(m[1]);
    const a = Number(m[2]);
    if (h > a) return "1";
    if (h < a) return "2";
    return "X";
  }

  function findClosestRowsByOdds(o1, ox, o2, k = 25) {
    const scored = DATA.map((r) => {
      const d = Math.abs(r.odd_1 - o1) + Math.abs(r.odd_x - ox) + Math.abs(r.odd_2 - o2);
      return { r, d };
    });
    scored.sort((a, b) => a.d - b.d);
    return scored.slice(0, Math.min(k, scored.length)).map((x) => x.r);
  }

  function statsFromRows(rows) {
    const counts = { "1": 0, "X": 0, "2": 0 };
    const scoreCounts = new Map();

    rows.forEach((r) => {
      const out = outcomeFromScore(r.result);
      if (out) counts[out] += 1;

      const sc = (r.result || "").trim();
      if (sc) scoreCounts.set(sc, (scoreCounts.get(sc) || 0) + 1);
    });

    const n = rows.length || 1;
    const p1 = counts["1"] / n;
    const px = counts["X"] / n;
    const p2 = counts["2"] / n;

    let bestScore = "";
    let bestC = -1;
    for (const [sc, c] of scoreCounts.entries()) {
      if (c > bestC) {
        bestC = c;
        bestScore = sc;
      }
    }

    return { p1, px, p2, bestScore, n };
  }

  // -------- Predict --------
  function onPredict() {
    try {
      const modeEl = $("mode");
      const odd1El = $("odd1");
      const oddXEl = $("oddX");
      const odd2El = $("odd2");

      const mode = modeEl ? modeEl.value : "1x2"; // "1x2" na "exact"

      const o1 = toNumber(odd1El ? odd1El.value : "");
      const ox = toNumber(oddXEl ? oddXEl.value : "");
      const o2 = toNumber(odd2El ? odd2El.value : "");

      if (!Number.isFinite(o1) || !Number.isFinite(ox) || !Number.isFinite(o2) || o1 <= 1 || ox <= 1 || o2 <= 1) {
        show("⚠️ Fenoy tsara ny Odds (oh: 2.30 na 2,30) ary tsy tokony ho latsaky ny 1.01.");
        return;
      }

      // ✅ Dataset mode
      if (DATA_READY && DATA.length > 0) {
        const nearest = findClosestRowsByOdds(o1, ox, o2, 25);
        const s = statsFromRows(nearest);

        const out = pickOutcome({ p1: s.p1, px: s.px, p2: s.p2 });
        const score = s.bestScore || exactScoreFromProbs(impliedProbs(o1, ox, o2));

        if (mode === "exact") {
          show(`🎯 <b>Score Exact (from DATA):</b> <b>${score}</b><br/><small>Rows nalaina akaiky odds: ${s.n}</small>`);
          return;
        }

        show(`
          ✅ <b>Résultat (from DATA):</b> <b>${out.label}</b><br/>
          📊 <b>%</b> Home: <b>${percent(s.p1)}</b> | Draw: <b>${percent(s.px)}</b> | Away: <b>${percent(s.p2)}</b><br/>
          🎯 <b>Score Exact (from DATA):</b> <b>${score}</b><br/>
          <small>Rows nalaina akaiky odds: ${s.n}</small>
        `);
        return;
      }

      // 🔁 Fallback
      const p = impliedProbs(o1, ox, o2);
      const out = pickOutcome(p);
      const score = exactScoreFromProbs(p);

      if (mode === "exact") {
        show(`🎯 <b>Score Exact (fallback):</b> <b>${score}</b><br/><small>⚠️ DATA tsy voa-load.</small>`);
        return;
      }

      show(`
        ✅ <b>Résultat (fallback):</b> <b>${out.label}</b><br/>
        📊 <b>%</b> Home: <b>${percent(p.p1)}</b> | Draw: <b>${percent(p.px)}</b> | Away: <b>${percent(p.p2)}</b><br/>
        🎯 <b>Score Exact (fallback):</b> <b>${score}</b><br/>
        <small>⚠️ DATA tsy voa-load.</small>
      `);
    } catch (err) {
      show("❌ Nisy erreur JS: " + (err && err.message ? err.message : err));
    }
  }

  // -------- Boot --------
  async function boot() {
    const btn = $("predictBtn");

    try {
      DATA = await loadCSV();
      DATA_READY = true;
      console.log("✅ DATA LOADED:", DATA.length);
      renderTable(DATA, 50);

      // raha tianao: message kely fa voa-load
      // show(`✅ DATA voa-load: ${DATA.length} rows`);
    } catch (e) {
      DATA_READY = false;
      console.warn("⚠️ DATA tsy voa-load:", e.message);
      show("⚠️ DATA tsy voa-load: " + e.message);
    }

    if (btn) btn.addEventListener("click", onPredict);
    else console.warn("⚠️ predictBtn tsy hita ao amin'ny HTML");
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
