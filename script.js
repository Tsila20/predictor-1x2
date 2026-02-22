(function () {
  // -------- Helpers --------
  function $(id) {
    return document.getElementById(id);
  }

  function show(msg) {
    const box = $("resultBox");
    if (box) box.innerHTML = msg;
  }

  function toNumber(val) {
    if (val == null) return NaN;
    const s = String(val).trim().replace(/\s+/g, "").replace(",", ".");
    if (!s || s.toUpperCase() === "NA") return NaN;
    const n = Number(s);
    return Number.isFinite(n) ? n : NaN;
  }

  function percent(x) {
    return (x * 100).toFixed(1) + "%";
  }

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
  let DATA_ALL = [];    // ho an'ny table (rows rehetra)
  let DATA_MODEL = [];  // ho an'ny AI (rows misy odds 1X2 feno)
  let DATA_READY = false;

  function stripBOM(text) {
    return text.replace(/^\uFEFF/, "");
  }

  function detectDelimiter(headerLine) {
    const semi = headerLine.split(";").length;
    const comma = headerLine.split(",").length;
    return semi > comma ? ";" : ",";
  }

  function splitCSVLine(line, delim) {
    const out = [];
    let cur = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];

      if (ch === '"') {
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

  function pickField(obj, candidates) {
    for (const k of candidates) {
      if (obj[k] != null && String(obj[k]).trim() !== "") return obj[k];
    }
    return "";
  }

  function journeeToNumber(j) {
    const m = String(j || "").match(/\d+/);
    return m ? Number(m[0]) : NaN;
  }

  async function loadCSV() {
    // ✅ cache-busting + no-store
    const url = "./data/france_virtual_league.csv?v=" + Date.now();
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error("CSV tsy voa-load: " + res.status);

    const text = await res.text();
    const raw = parseCSVSmart(text);

    const rows = raw.map((r) => {
      const out = {};

      out.league = pickField(r, ["league", "League", "LEAGUE"]);
      out.journee = pickField(r, ["journee", "Journee", "Journée", "JOURNEE"]);
      out.journee_num = journeeToNumber(out.journee);

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

    // ✅ rows rehetra ho an'ny table
    const all = rows;

    // ✅ rows feno odds 1X2 ho an'ny AI/predict
    const model = rows.filter(
      (r) => Number.isFinite(r.odd_1) && Number.isFinite(r.odd_x) && Number.isFinite(r.odd_2)
    );

    // ✅ sort: journee lehibe aloha (mba hiseho 36->33 etc)
    all.sort((a, b) => (b.journee_num ?? -1) - (a.journee_num ?? -1));
    model.sort((a, b) => (b.journee_num ?? -1) - (a.journee_num ?? -1));

    return { all, model };
  }

  function renderTable(rows, limit = 500) {
    const tbody = document.querySelector("#matchesTable tbody");
    if (!tbody) return;

    tbody.innerHTML = "";
    rows.slice(0, limit).forEach((r) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${Number.isFinite(r.journee_num) ? r.journee_num : (r.journee || "-")}</td>
        <td>${r.home || "-"}</td>
        <td>${r.away || "-"}</td>
        <td>${Number.isFinite(r.odd_1) ? r.odd_1 : "NA"}</td>
        <td>${Number.isFinite(r.odd_x) ? r.odd_x : "NA"}</td>
        <td>${Number.isFinite(r.odd_2) ? r.odd_2 : "NA"}</td>
        <td>${Number.isFinite(r.odd_g) ? r.odd_g : "NA"}</td>
        <td>${Number.isFinite(r.odd_ng) ? r.odd_ng : "NA"}</td>
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

  // ✅ Weighted stats uses DATA_MODEL (only valid odds rows)
  function weightedStatsFromData(o1, ox, o2) {
    const eps = 1e-6;

    let w1 = 0, wX = 0, w2 = 0;
    const scoreCounts = new Map();

    let jMin = Infinity, jMax = -Infinity;
    let used = 0;

    for (const r of DATA_MODEL) {
      const d = Math.abs(r.odd_1 - o1) + Math.abs(r.odd_x - ox) + Math.abs(r.odd_2 - o2);
      const w = 1 / (d + eps);

      const out = outcomeFromScore(r.result);
      if (out) {
        if (out === "1") w1 += w;
        else if (out === "X") wX += w;
        else if (out === "2") w2 += w;
      }

      const sc = (r.result || "").trim();
      if (sc) scoreCounts.set(sc, (scoreCounts.get(sc) || 0) + w);

      if (Number.isFinite(r.journee_num)) {
        jMin = Math.min(jMin, r.journee_num);
        jMax = Math.max(jMax, r.journee_num);
      }

      used++;
    }

    const denom = (w1 + wX + w2) || 1;
    const p1 = w1 / denom;
    const px = wX / denom;
    const p2 = w2 / denom;

    let bestScore = "";
    let bestW = -1;
    for (const [sc, ww] of scoreCounts.entries()) {
      if (ww > bestW) {
        bestW = ww;
        bestScore = sc;
      }
    }

    return {
      p1, px, p2,
      bestScore,
      used,
      jMin: Number.isFinite(jMin) ? jMin : null,
      jMax: Number.isFinite(jMax) ? jMax : null,
    };
  }

  // -------- Predict --------
  function onPredict() {
    try {
      const modeEl = $("mode");
      const odd1El = $("odd1");
      const oddXEl = $("oddX");
      const odd2El = $("odd2");

      const mode = modeEl ? modeEl.value : "1x2";

      const o1 = toNumber(odd1El ? odd1El.value : "");
      const ox = toNumber(oddXEl ? oddXEl.value : "");
      const o2 = toNumber(odd2El ? odd2El.value : "");

      if (!Number.isFinite(o1) || !Number.isFinite(ox) || !Number.isFinite(o2) || o1 <= 1 || ox <= 1 || o2 <= 1) {
        show("⚠️ Fenoy tsara ny Odds (oh: 2.30 na 2,30) ary tsy tokony ho latsaky ny 1.01.");
        return;
      }

      if (DATA_READY && DATA_MODEL.length > 0) {
        const s = weightedStatsFromData(o1, ox, o2);

        const out = pickOutcome({ p1: s.p1, px: s.px, p2: s.p2 });
        const score = s.bestScore || exactScoreFromProbs(impliedProbs(o1, ox, o2));

        const journeeInfo =
          (s.jMin != null && s.jMax != null)
            ? `<small>Journée nampiasaina: ${s.jMin} → ${s.jMax}</small><br/>`
            : "";

        if (mode === "exact") {
          show(
            `🎯 <b>Score Exact (from DATA):</b> <b>${score}</b><br/>` +
            `${journeeInfo}` +
            `<small>Rows nampiasaina (DATA): ${s.used}</small>`
          );
          return;
        }

        show(`
          ✅ <b>Résultat (from DATA):</b> <b>${out.label}</b><br/>
          📊 <b>%</b> Home: <b>${percent(s.p1)}</b> | Draw: <b>${percent(s.px)}</b> | Away: <b>${percent(s.p2)}</b><br/>
          🎯 <b>Score Exact (from DATA):</b> <b>${score}</b><br/>
          ${journeeInfo}
          <small>Rows nampiasaina (DATA): ${s.used}</small>
        `);
        return;
      }

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
      const loaded = await loadCSV();
      DATA_ALL = loaded.all;
      DATA_MODEL = loaded.model;
      DATA_READY = true;

      console.log("✅ DATA ALL:", DATA_ALL.length);
      console.log("✅ DATA MODEL:", DATA_MODEL.length);

      // ✅ table mampiseho ALL (anisan'izany NA)
      renderTable(DATA_ALL, 500);
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
