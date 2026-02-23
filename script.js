(function () {
  // =========================
  //  Legendary Data Scanner v2
  //  - removes ANY row containing NA
  //  - trains only on rows with odds + result
  //  - anti-leak: excludes exact same odds row
  // =========================
  const APP_VERSION = "2026-02-23_LEGENDARY_v2";

  // -------- Helpers --------
  const $ = (id) => document.getElementById(id);

  function show(html) {
    const box = $("resultBox");
    if (box) box.innerHTML = html;
  }

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function toNumber(val) {
    if (val == null) return NaN;
    const s = String(val).trim().replace(/\s+/g, "").replace(",", ".");
    if (!s || s.toUpperCase() === "NA") return NaN;
    const n = Number(s);
    return Number.isFinite(n) ? n : NaN;
  }

  function percent(x) {
    if (!Number.isFinite(x)) return "NA";
    return (x * 100).toFixed(1) + "%";
  }

  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }

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

  function outcomeFromScore(scoreStr) {
    const s = String(scoreStr || "").trim();
    if (!s || s.toUpperCase() === "NA") return null;
    const m = s.match(/(\d+)\s*-\s*(\d+)/);
    if (!m) return null;
    const h = Number(m[1]), a = Number(m[2]);
    if (h > a) return "1";
    if (h < a) return "2";
    return "X";
  }

  function journeeToNumber(j) {
    const m = String(j || "").match(/\d+/);
    return m ? Number(m[0]) : NaN;
  }

  // ✅ TRAIN RANGE (madio: J19 → J40)
  const J_MIN = 19;
  const J_MAX = 40;

  // ✅ Scanner params
  const K_NEIGHBORS = 35;
  const SIGMA = 0.55;
  const RECENCY_BONUS = 0.22;
  const MIN_RESULTS_FOR_DATA = 8;

  // -------- CSV parser --------
  let DATA_ALL = [];
  let DATA_MODEL = [];
  let DATA_READY = false;

  function stripBOM(text) { return text.replace(/^\uFEFF/, ""); }

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
        if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = !inQuotes;
        continue;
      }
      if (!inQuotes && ch === delim) { out.push(cur.trim()); cur = ""; continue; }
      cur += ch;
    }
    out.push(cur.trim());
    return out;
  }

  function parseCSVSmart(text) {
    text = stripBOM(text);
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return [];

    const headerLine = lines[0];
    const delim = detectDelimiter(headerLine);
    const headers = splitCSVLine(headerLine, delim).map((h) => h.trim());

    const headerJoined = headers.join(delim).toLowerCase().replace(/\s+/g, "");
    const rows = [];

    for (let i = 1; i < lines.length; i++) {
      const lineLower = lines[i].toLowerCase().replace(/\s+/g, "");
      if (lineLower === headerJoined) continue;

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
      const v = obj[k];
      if (v != null && String(v).trim() !== "") return v;
    }
    return "";
  }

  function hasNAAnywhere(rowObj) {
    // remove any row that contains NA in any important fields
    const fields = [
      rowObj.odd_1, rowObj.odd_x, rowObj.odd_2,
      rowObj.odd_g, rowObj.odd_ng,
      rowObj.result
    ];
    for (const f of fields) {
      const s = String(f ?? "").trim().toUpperCase();
      if (s === "NA" || s === "") return true;
    }
    return false;
  }

  async function loadCSV() {
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

      out.odd_1 = pickField(r, ["odd_1", "Odd1", "odd1", "Odd 1", "Odd_1"]);
      out.odd_x = pickField(r, ["odd_x", "OddX", "oddx", "Odd X", "Odd_X"]);
      out.odd_2 = pickField(r, ["odd_2", "Odd2", "odd2", "Odd 2", "Odd_2"]);

      out.odd_g = pickField(r, ["odd_g", "OddG", "oddg", "Odd G", "Odd_G"]);
      out.odd_ng = pickField(r, ["odd_ng", "OddNG", "oddng", "Odd NG", "Odd_NG"]);

      out.result = pickField(r, ["result", "Result", "score", "Score", "RESULT"]);

      // numeric versions (after NA filtering we can parse)
      out.odd_1_num = toNumber(out.odd_1);
      out.odd_x_num = toNumber(out.odd_x);
      out.odd_2_num = toNumber(out.odd_2);
      out.odd_g_num = toNumber(out.odd_g);
      out.odd_ng_num = toNumber(out.odd_ng);

      return out;
    });

    const inRange = (r) =>
      Number.isFinite(r.journee_num) && r.journee_num >= J_MIN && r.journee_num <= J_MAX;

    // ✅ Keep only rows in range and NO NA anywhere (odds + gg/ng + result)
    const clean = rows.filter((r) => inRange(r) && !hasNAAnywhere(r));

    // All for display (clean only)
    const all = clean.slice();

    // Model for scanner: must have 1X2 odds numeric + valid result
    const model = clean.filter(
      (r) =>
        Number.isFinite(r.odd_1_num) &&
        Number.isFinite(r.odd_x_num) &&
        Number.isFinite(r.odd_2_num) &&
        outcomeFromScore(r.result) != null
    );

    all.sort((a, b) => (b.journee_num ?? -1) - (a.journee_num ?? -1));
    model.sort((a, b) => (b.journee_num ?? -1) - (a.journee_num ?? -1));

    return { all, model };
  }

  function renderTable(rows, limit = 500) {
    const table = document.querySelector("#matchesTable tbody");
    if (!table) return;
    table.innerHTML = "";
    rows.slice(0, limit).forEach((r) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${Number.isFinite(r.journee_num) ? r.journee_num : (esc(r.journee) || "-")}</td>
        <td>${esc(r.home) || "-"}</td>
        <td>${esc(r.away) || "-"}</td>
        <td>${Number.isFinite(r.odd_1_num) ? r.odd_1_num : "NA"}</td>
        <td>${Number.isFinite(r.odd_x_num) ? r.odd_x_num : "NA"}</td>
        <td>${Number.isFinite(r.odd_2_num) ? r.odd_2_num : "NA"}</td>
        <td>${Number.isFinite(r.odd_g_num) ? r.odd_g_num : "NA"}</td>
        <td>${Number.isFinite(r.odd_ng_num) ? r.odd_ng_num : "NA"}</td>
        <td>${esc(r.result) || "-"}</td>
      `;
      table.appendChild(tr);
    });
  }

  // =========================
  // Scanner Core
  // =========================
  function distOdds(r, o1, ox, o2) {
    const d1 = Math.abs(r.odd_1_num - o1) / Math.max(1, o1);
    const dx = Math.abs(r.odd_x_num - ox) / Math.max(1, ox);
    const d2 = Math.abs(r.odd_2_num - o2) / Math.max(1, o2);
    return d1 + dx + d2;
  }

  function weightFromDist(d) {
    const x = d / SIGMA;
    return Math.exp(-(x * x));
  }

  function recencyWeight(j) {
    if (!Number.isFinite(j)) return 1;
    const t = (j - J_MIN) / Math.max(1, (J_MAX - J_MIN));
    return 1 + RECENCY_BONUS * t;
  }

  function topKNeighbors(o1, ox, o2, k = K_NEIGHBORS) {
    // ✅ Anti-leak: exclude row with exact same odds
    const scored = DATA_MODEL
      .filter(r =>
        !(Math.abs(r.odd_1_num - o1) < 1e-9 &&
          Math.abs(r.odd_x_num - ox) < 1e-9 &&
          Math.abs(r.odd_2_num - o2) < 1e-9)
      )
      .map((r) => {
        const d = distOdds(r, o1, ox, o2);
        const w = weightFromDist(d) * recencyWeight(r.journee_num);
        return { r, d, w };
      });

    scored.sort((a, b) => b.w - a.w);
    return scored.slice(0, Math.min(k, scored.length));
  }

  function confidenceLabel(c) {
    if (c >= 0.75) return "🔥 LÉGENDAIRE";
    if (c >= 0.55) return "✅ Tsara";
    if (c >= 0.35) return "⚠️ Antonony";
    return "🧊 Malemy";
  }

  function tinyNeighborsHTML(neigh) {
    const top = neigh.slice(0, 5);
    if (!top.length) return "";
    return `
      <details style="margin-top:8px">
        <summary>🔎 Top 5 matches mitovitovy indrindra</summary>
        <div style="font-size:12px; line-height:1.35; margin-top:6px">
          ${top.map((n) => {
            const r = n.r;
            return `
              <div style="margin-bottom:6px">
                <b>J${esc(r.journee_num)}</b> ${esc(r.home)} vs ${esc(r.away)} |
                ${r.odd_1_num} / ${r.odd_x_num} / ${r.odd_2_num}
                → <b>${esc(r.result)}</b>
              </div>
            `;
          }).join("")}
        </div>
      </details>
    `;
  }

  function legendaryStats(o1, ox, o2) {
    const neigh = topKNeighbors(o1, ox, o2, K_NEIGHBORS);

    let w1 = 0, wX = 0, w2 = 0;
    let used = neigh.length;
    let usedWithResult = 0;

    const scoreCounts = new Map();
    const totalW = neigh.reduce((s, x) => s + x.w, 0) + 1e-12;
    const topW = neigh.length ? neigh[0].w : 0;

    for (const n of neigh) {
      const out = outcomeFromScore(n.r.result);
      if (!out) continue;
      usedWithResult++;

      if (out === "1") w1 += n.w;
      else if (out === "X") wX += n.w;
      else if (out === "2") w2 += n.w;

      const key = String(n.r.result).trim();
      scoreCounts.set(key, (scoreCounts.get(key) || 0) + n.w);
    }

    const denom = w1 + wX + w2;

    let bestScore = "";
    let bestW = -1;
    for (const [sc, ww] of scoreCounts.entries()) {
      if (ww > bestW) { bestW = ww; bestScore = sc; }
    }

    const availability = used > 0 ? usedWithResult / used : 0;
    const dominance = clamp((topW / totalW) * 6, 0, 1);
    const confidence = clamp(0.55 * availability + 0.45 * dominance, 0, 1);

    return {
      neigh,
      used,
      usedWithResult,
      ok: (usedWithResult >= MIN_RESULTS_FOR_DATA) && denom > 0,
      p1: denom > 0 ? w1 / denom : NaN,
      px: denom > 0 ? wX / denom : NaN,
      p2: denom > 0 ? w2 / denom : NaN,
      bestScore,
      confidence
    };
  }

  // =========================
  // Predict handler
  // =========================
  function onPredict(e) {
    try {
      if (e && e.preventDefault) e.preventDefault();

      const mode = $("mode") ? $("mode").value : "1x2";
      const o1 = toNumber($("odd1") ? $("odd1").value : "");
      const ox = toNumber($("oddX") ? $("oddX").value : "");
      const o2 = toNumber($("odd2") ? $("odd2").value : "");

      if (!Number.isFinite(o1) || !Number.isFinite(ox) || !Number.isFinite(o2) || o1 <= 1 || ox <= 1 || o2 <= 1) {
        show("⚠️ Fenoy tsara ny Odds (oh: 2.30 na 2,30) ary tsy tokony ho latsaky ny 1.01.");
        return;
      }

      const rangeInfo = `<small>Train range: ${J_MIN} → ${J_MAX} (NA esorina)</small><br/>`;

      if (DATA_READY && DATA_MODEL.length > 0) {
        const s = legendaryStats(o1, ox, o2);

        // fallback implied if not enough neighbor-results
        if (!s.ok) {
          const p = impliedProbs(o1, ox, o2);
          const out = pickOutcome(p);
          const score = exactScoreFromProbs(p);

          show(`
            ✅ <b>Résultat (fallback implied):</b> <b>${out.label}</b><br/>
            📊 <b>%</b> Home: <b>${percent(p.p1)}</b> | Draw: <b>${percent(p.px)}</b> | Away: <b>${percent(p.p2)}</b><br/>
            🎯 <b>Score Exact (fallback):</b> <b>${esc(score)}</b><br/>
            🧠 <b>Confidence:</b> <b>${confidenceLabel(s.confidence)}</b> (${percent(s.confidence)})<br/>
            ${rangeInfo}
            <small>neighbors=${s.used} | usedWithResult=${s.usedWithResult} (tsy ampy)</small>
            ${tinyNeighborsHTML(s.neigh)}
          `);
          return;
        }

        const out = pickOutcome({ p1: s.p1, px: s.px, p2: s.p2 });
        const score = s.bestScore || exactScoreFromProbs(impliedProbs(o1, ox, o2));

        if (mode === "exact") {
          show(`
            🎯 <b>Score Exact (from DATA Scanner):</b> <b>${esc(score)}</b><br/>
            🧠 <b>Confidence:</b> <b>${confidenceLabel(s.confidence)}</b> (${percent(s.confidence)})<br/>
            ${rangeInfo}
            <small>neighbors=${s.used} | usedWithResult=${s.usedWithResult} | modelRows=${DATA_MODEL.length}</small>
            ${tinyNeighborsHTML(s.neigh)}
          `);
          return;
        }

        show(`
          ✅ <b>Résultat (Legendary DATA Scanner):</b> <b>${out.label}</b><br/>
          📊 <b>%</b> Home: <b>${percent(s.p1)}</b> | Draw: <b>${percent(s.px)}</b> | Away: <b>${percent(s.p2)}</b><br/>
          🎯 <b>Score Exact (from Neighbors):</b> <b>${esc(score)}</b><br/>
          🧠 <b>Confidence:</b> <b>${confidenceLabel(s.confidence)}</b> (${percent(s.confidence)})<br/>
          ${rangeInfo}
          <small>neighbors=${s.used} | usedWithResult=${s.usedWithResult} | modelRows=${DATA_MODEL.length}</small>
          ${tinyNeighborsHTML(s.neigh)}
        `);
        return;
      }

      // total fallback
      const p = impliedProbs(o1, ox, o2);
      const out = pickOutcome(p);
      const score = exactScoreFromProbs(p);

      show(`
        ✅ <b>Résultat (fallback):</b> <b>${out.label}</b><br/>
        📊 <b>%</b> Home: <b>${percent(p.p1)}</b> | Draw: <b>${percent(p.px)}</b> | Away: <b>${percent(p.p2)}</b><br/>
        🎯 <b>Score Exact (fallback):</b> <b>${esc(score)}</b><br/>
        <small>⚠️ DATA tsy voa-load.</small>
      `);

    } catch (err) {
      show("❌ Nisy erreur JS: " + (err && err.message ? esc(err.message) : esc(err)));
      console.error(err);
    }
  }

  // =========================
  // Boot
  // =========================
  async function boot() {
    console.log("✅ APP_VERSION:", APP_VERSION);

    try {
      const loaded = await loadCSV();
      DATA_ALL = loaded.all;
      DATA_MODEL = loaded.model;
      DATA_READY = true;

      console.log("✅ DATA_ALL(clean):", DATA_ALL.length);
      console.log("✅ DATA_MODEL(train):", DATA_MODEL.length);

      renderTable(DATA_ALL, 500);

      show(
        `✅ <b>DATA OK (clean)</b> | Train: <b>${J_MIN} → ${J_MAX}</b>` +
        ` | Rows(clean): <b>${DATA_ALL.length}</b>` +
        ` | Rows(model): <b>${DATA_MODEL.length}</b>` +
        `<br/><small>v=${APP_VERSION} | K=${K_NEIGHBORS} | sigma=${SIGMA} | recency=${RECENCY_BONUS}</small>`
      );
    } catch (e) {
      DATA_READY = false;
      console.warn("⚠️ DATA tsy voa-load:", e.message);
      show("⚠️ DATA tsy voa-load: " + esc(e.message));
    }

    // Bind predict button
    const btn = $("predictBtn");
    if (btn) {
      try { btn.type = "button"; } catch (_) {}
      btn.addEventListener("click", (e) => onPredict(e));
    } else {
      console.warn("⚠️ predictBtn tsy hita ao HTML");
    }
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
