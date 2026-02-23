(function () {
  // =========================
  //  Legendary Data Scanner
  // =========================
  const APP_VERSION = "2026-02-23_LEGENDARY_v1";

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

  // ✅ RANGE JOURNÉE
  const J_MIN = 19;
  const J_MAX = 41;

  // ✅ Legendary scanner params
  const K_NEIGHBORS = 35;      // aka "scanner depth"
  const SIGMA = 0.55;          // smaller = stricter similarity
  const RECENCY_BONUS = 0.22;  // boosts recent journées
  const MIN_RESULTS_FOR_DATA = 8;

  // -------- CSV parser (smart) --------
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

  async function loadCSV() {
    const url = "./data/france_virtual_league.csv?v=" + Date.now(); // cache bust
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

    const inRange = (r) =>
      Number.isFinite(r.journee_num) && r.journee_num >= J_MIN && r.journee_num <= J_MAX;

    const all = rows.filter(inRange);
    const model = all.filter((r) =>
      Number.isFinite(r.odd_1) && Number.isFinite(r.odd_x) && Number.isFinite(r.odd_2)
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
        <td>${Number.isFinite(r.odd_1) ? r.odd_1 : "NA"}</td>
        <td>${Number.isFinite(r.odd_x) ? r.odd_x : "NA"}</td>
        <td>${Number.isFinite(r.odd_2) ? r.odd_2 : "NA"}</td>
        <td>${Number.isFinite(r.odd_g) ? r.odd_g : "NA"}</td>
        <td>${Number.isFinite(r.odd_ng) ? r.odd_ng : "NA"}</td>
      `;
      table.appendChild(tr);
    });
  }

  // =========================
  // Legendary Scanner Core
  // =========================

  // distance normalized by odds scale
  function distOdds(r, o1, ox, o2) {
    // Normalize differences to reduce bias when odds big/small
    const d1 = Math.abs(r.odd_1 - o1) / Math.max(1, o1);
    const dx = Math.abs(r.odd_x - ox) / Math.max(1, ox);
    const d2 = Math.abs(r.odd_2 - o2) / Math.max(1, o2);
    return d1 + dx + d2;
  }

  function weightFromDist(d) {
    // gaussian-like
    const x = d / SIGMA;
    return Math.exp(-(x * x));
  }

  function recencyWeight(j) {
    if (!Number.isFinite(j)) return 1;
    // map j in [J_MIN,J_MAX] to [0,1]
    const t = (j - J_MIN) / Math.max(1, (J_MAX - J_MIN));
    return 1 + RECENCY_BONUS * t; // recent gets boost
  }

  function topKNeighbors(o1, ox, o2, k = K_NEIGHBORS) {
    const scored = DATA_MODEL.map((r) => {
      const d = distOdds(r, o1, ox, o2);
      const w = weightFromDist(d) * recencyWeight(r.journee_num);
      return { r, d, w };
    });

    scored.sort((a, b) => b.w - a.w);
    return scored.slice(0, Math.min(k, scored.length));
  }

  function legendaryStats(o1, ox, o2) {
    const neigh = topKNeighbors(o1, ox, o2, K_NEIGHBORS);

    let w1 = 0, wX = 0, w2 = 0;
    let used = neigh.length;
    let usedWithResult = 0;

    const scoreCounts = new Map();
    let topW = neigh.length ? neigh[0].w : 0;

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

    // bestScore from neighbors with results
    let bestScore = "";
    let bestW = -1;
    for (const [sc, ww] of scoreCounts.entries()) {
      if (ww > bestW) { bestW = ww; bestScore = sc; }
    }

    // confidence metric: (top weight dominance + result availability)
    const availability = used > 0 ? usedWithResult / used : 0;
    const dominance = used > 0 ? clamp(topW / (neigh.reduce((s, x) => s + x.w, 0) + 1e-9) * 6, 0, 1) : 0;
    const confidence = clamp(0.55 * availability + 0.45 * dominance, 0, 1);

    return {
      neigh,
      used,
      usedWithResult,
      ok: (usedWithResult >= MIN_RESULTS_FOR_DATA) && denom > 0,
      p1: denom > 0 ? w1 / denom : NaN,
      px: denom > 0 ? wX / denom : NaN,
      p2: denom > 0 ? w2 / denom : NaN,
      bestScore: bestScore || "",
      confidence
    };
  }

  function confidenceLabel(c) {
    if (c >= 0.75) return "🔥 LÉGENDAIRE";
    if (c >= 0.55) return "✅ Tsara";
    if (c >= 0.35) return "⚠️ Antonony";
    return "🧊 Malemy";
  }

  function tinyNeighborsHTML(neigh) {
    const top = neigh.slice(0, 5);
    return `
      <details style="margin-top:8px">
        <summary>🔎 Top 5 matches mitovitovy indrindra</summary>
        <div style="font-size:12px; line-height:1.35; margin-top:6px">
          ${top.map((n) => {
            const r = n.r;
            return `
              <div style="margin-bottom:6px">
                <b>J${esc(r.journee_num)}</b> ${esc(r.home)} vs ${esc(r.away)} |
                ${Number.isFinite(r.odd_1) ? r.odd_1 : "NA"} /
                ${Number.isFinite(r.odd_x) ? r.odd_x : "NA"} /
                ${Number.isFinite(r.odd_2) ? r.odd_2 : "NA"}
                ${r.result && String(r.result).toUpperCase() !== "NA" ? ` → <b>${esc(r.result)}</b>` : " → NA"}
              </div>
            `;
          }).join("")}
        </div>
      </details>
    `;
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

      const journeeInfo = `<small>Range ampiasaina: ${J_MIN} → ${J_MAX}</small><br/>`;

      // If dataset ready, use Legendary Scanner
      if (DATA_READY && DATA_MODEL.length > 0) {
        const s = legendaryStats(o1, ox, o2);

        // fallback: implied probs but still show scanner debug
        if (!s.ok) {
          const p = impliedProbs(o1, ox, o2);
          const out = pickOutcome(p);
          const score = exactScoreFromProbs(p);

          show(`
            ✅ <b>Résultat (fallback implied):</b> <b>${out.label}</b><br/>
            📊 <b>%</b> Home: <b>${percent(p.p1)}</b> | Draw: <b>${percent(p.px)}</b> | Away: <b>${percent(p.p2)}</b><br/>
            🎯 <b>Score Exact (fallback):</b> <b>${esc(score)}</b><br/>
            ${journeeInfo}
            <small>
              Scanner: rows model=${DATA_MODEL.length} | neighbors=${s.used} | misy result=${s.usedWithResult} (tsy ampy) |
              confidence: <b>${confidenceLabel(s.confidence)}</b> (${percent(s.confidence)})
            </small>
            ${tinyNeighborsHTML(s.neigh)}
          `);
          return;
        }

        const out = pickOutcome({ p1: s.p1, px: s.px, p2: s.p2 });
        const score = s.bestScore || exactScoreFromProbs(impliedProbs(o1, ox, o2));

        if (mode === "exact") {
          show(`
            🎯 <b>Score Exact (from DATA Scanner):</b> <b>${esc(score)}</b><br/>
            ${journeeInfo}
            <small>
              Scanner: neighbors=${s.used} | misy result=${s.usedWithResult} |
              confidence: <b>${confidenceLabel(s.confidence)}</b> (${percent(s.confidence)})
            </small>
            ${tinyNeighborsHTML(s.neigh)}
          `);
          return;
        }

        show(`
          ✅ <b>Résultat (Legendary DATA Scanner):</b> <b>${out.label}</b><br/>
          📊 <b>%</b> Home: <b>${percent(s.p1)}</b> | Draw: <b>${percent(s.px)}</b> | Away: <b>${percent(s.p2)}</b><br/>
          🎯 <b>Score Exact (from Neighbors):</b> <b>${esc(score)}</b><br/>
          🧠 <b>Confidence:</b> <b>${confidenceLabel(s.confidence)}</b> (${percent(s.confidence)})<br/>
          ${journeeInfo}
          <small>neighbors=${s.used} | misy result=${s.usedWithResult} | model rows=${DATA_MODEL.length}</small>
          ${tinyNeighborsHTML(s.neigh)}
        `);
        return;
      }

      // totally fallback if no data
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

      console.log("✅ DATA_ALL (range):", DATA_ALL.length);
      console.log("✅ DATA_MODEL (range):", DATA_MODEL.length);

      renderTable(DATA_ALL, 500);

      if ($("resultBox")) {
        const nums = DATA_ALL.map((r) => r.journee_num).filter(Number.isFinite);
        const jMin = nums.length ? Math.min(...nums) : null;
        const jMax = nums.length ? Math.max(...nums) : null;

        show(
          `✅ <b>DATA OK</b>. Range: <b>${J_MIN} → ${J_MAX}</b>` +
          (jMin != null && jMax != null ? ` | Journée ao: <b>${jMin} → ${jMax}</b>` : "") +
          ` | Rows: <b>${DATA_ALL.length}</b>` +
          `<br/><small>Scanner: K=${K_NEIGHBORS}, sigma=${SIGMA}, recency=${RECENCY_BONUS} | v=${APP_VERSION}</small>`
        );
      }
    } catch (e) {
      DATA_READY = false;
      console.warn("⚠️ DATA tsy voa-load:", e.message);
      show("⚠️ DATA tsy voa-load: " + esc(e.message));
    }

    // Bind Predict button (anti-submit / anti-refresh)
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
