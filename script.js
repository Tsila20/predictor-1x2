(function () {
  // -------- Helpers --------
  const $ = (id) => document.getElementById(id);

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

  // -------- CSV parser --------
  let DATA_ALL = [];
  let DATA_MODEL = [];
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
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

    if (!lines.length) return [];

    // ✅ remove duplicated header lines anywhere
    const headerLine = lines[0];
    const delim = detectDelimiter(headerLine);
    const headers = splitCSVLine(headerLine, delim).map(h => h.trim());

    const headerJoined = headers.join(delim).toLowerCase();

    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const lineLower = lines[i].toLowerCase();
      // skip any repeated headers
      if (lineLower.replace(/\s+/g, "") === headerJoined.replace(/\s+/g, "")) continue;

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

  function journeeToNumber(j) {
    const m = String(j || "").match(/\d+/);
    return m ? Number(m[0]) : NaN;
  }

  async function loadCSV() {
    // ✅ cache busting
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

    const all = rows;

    const model = rows.filter(
      (r) => Number.isFinite(r.odd_1) && Number.isFinite(r.odd_x) && Number.isFinite(r.odd_2)
    );

    // sort desc by journee
    all.sort((a, b) => (b.journee_num ?? -1) - (a.journee_num ?? -1));
    model.sort((a, b) => (b.journee_num ?? -1) - (a.journee_num ?? -1));

    return { all, model };
  }

  function renderTable(rows, limit = 500) {
    const table = document.querySelector("#matchesTable tbody");
    if (!table) {
      console.warn("⚠️ matchesTable tbody tsy hita ao HTML");
      return;
    }

    table.innerHTML = "";
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
      table.appendChild(tr);
    });
  }

  function outcomeFromScore(scoreStr) {
    const m = String(scoreStr || "").match(/(\d+)\s*-\s*(\d+)/);
    if (!m) return null;
    const h = Number(m[1]), a = Number(m[2]);
    if (h > a) return "1";
    if (h < a) return "2";
    return "X";
  }

  // ✅ Weighted stats (only if results exist)
  function weightedStatsFromData(o1, ox, o2) {
    const eps = 1e-6;

    let w1 = 0, wX = 0, w2 = 0;
    const scoreCounts = new Map();

    let jMin = Infinity, jMax = -Infinity;
    let used = 0;
    let usedWithResult = 0;

    for (const r of DATA_MODEL) {
      const d = Math.abs(r.odd_1 - o1) + Math.abs(r.odd_x - ox) + Math.abs(r.odd_2 - o2);
      const w = 1 / (d + eps);

      used++;

      const out = outcomeFromScore(r.result);
      if (out) {
        usedWithResult++;
        if (out === "1") w1 += w;
        else if (out === "X") wX += w;
        else if (out === "2") w2 += w;

        scoreCounts.set(r.result.trim(), (scoreCounts.get(r.result.trim()) || 0) + w);
      }

      if (Number.isFinite(r.journee_num)) {
        jMin = Math.min(jMin, r.journee_num);
        jMax = Math.max(jMax, r.journee_num);
      }
    }

    const denom = (w1 + wX + w2);

    let bestScore = "";
    let bestW = -1;
    for (const [sc, ww] of scoreCounts.entries()) {
      if (ww > bestW) { bestW = ww; bestScore = sc; }
    }

    return {
      ok: denom > 0 && usedWithResult > 10, // ✅ mila result ampy vao tena manankery
      p1: denom > 0 ? w1 / denom : 0,
      px: denom > 0 ? wX / denom : 0,
      p2: denom > 0 ? w2 / denom : 0,
      bestScore,
      used,
      usedWithResult,
      jMin: Number.isFinite(jMin) ? jMin : null,
      jMax: Number.isFinite(jMax) ? jMax : null,
    };
  }

  function onPredict() {
    try {
      const mode = $("mode") ? $("mode").value : "1x2";

      const o1 = toNumber($("odd1") ? $("odd1").value : "");
      const ox = toNumber($("oddX") ? $("oddX").value : "");
      const o2 = toNumber($("odd2") ? $("odd2").value : "");

      if (!Number.isFinite(o1) || !Number.isFinite(ox) || !Number.isFinite(o2) || o1 <= 1 || ox <= 1 || o2 <= 1) {
        show("⚠️ Fenoy tsara ny Odds (oh: 2.30 na 2,30) ary tsy tokony ho latsaky ny 1.01.");
        return;
      }

      // ✅ Dataset mode
      if (DATA_READY && DATA_MODEL.length > 0) {
        const s = weightedStatsFromData(o1, ox, o2);

        const journeeInfo =
          (s.jMin != null && s.jMax != null)
            ? `<small>Journée ao anaty CSV: ${s.jMin} → ${s.jMax}</small><br/>`
            : "";

        // Raha tsy ampy result dia fallback impliedProbs fa mbola manome info
        if (!s.ok) {
          const p = impliedProbs(o1, ox, o2);
          const out = pickOutcome(p);
          const score = exactScoreFromProbs(p);

          show(`
            ✅ <b>Résultat (fallback implied):</b> <b>${out.label}</b><br/>
            📊 <b>%</b> Home: <b>${percent(p.p1)}</b> | Draw: <b>${percent(p.px)}</b> | Away: <b>${percent(p.p2)}</b><br/>
            🎯 <b>Score Exact (fallback):</b> <b>${score}</b><br/>
            ${journeeInfo}
            <small>Rows total: ${s.used} | Rows misy result: ${s.usedWithResult} (tsy ampy)</small>
          `);
          return;
        }

        const out = pickOutcome({ p1: s.p1, px: s.px, p2: s.p2 });
        const score = s.bestScore || exactScoreFromProbs(impliedProbs(o1, ox, o2));

        if (mode === "exact") {
          show(
            `🎯 <b>Score Exact (from DATA):</b> <b>${score}</b><br/>` +
            `${journeeInfo}` +
            `<small>Rows: ${s.used} | Rows misy result: ${s.usedWithResult}</small>`
          );
          return;
        }

        show(`
          ✅ <b>Résultat (from DATA):</b> <b>${out.label}</b><br/>
          📊 <b>%</b> Home: <b>${percent(s.p1)}</b> | Draw: <b>${percent(s.px)}</b> | Away: <b>${percent(s.p2)}</b><br/>
          🎯 <b>Score Exact (from DATA):</b> <b>${score}</b><br/>
          ${journeeInfo}
          <small>Rows: ${s.used} | Rows misy result: ${s.usedWithResult}</small>
        `);
        return;
      }

      // fallback totally
      const p = impliedProbs(o1, ox, o2);
      const out = pickOutcome(p);
      const score = exactScoreFromProbs(p);

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

  async function boot() {
    try {
      const loaded = await loadCSV();
      DATA_ALL = loaded.all;
      DATA_MODEL = loaded.model;
      DATA_READY = true;

      console.log("✅ DATA_ALL:", DATA_ALL.length);
      console.log("✅ DATA_MODEL:", DATA_MODEL.length);

      // ✅ render all rows so 33-36 show
      renderTable(DATA_ALL, 500);

      // ✅ show quick info on page
      if ($("resultBox")) {
        const jMin = Math.min(...DATA_ALL.map(r => r.journee_num).filter(Number.isFinite));
        const jMax = Math.max(...DATA_ALL.map(r => r.journee_num).filter(Number.isFinite));
        show(`✅ DATA OK. Journée ao: <b>${jMin} → ${jMax}</b> | Rows: <b>${DATA_ALL.length}</b>`);
      }
    } catch (e) {
      DATA_READY = false;
      console.warn("⚠️ DATA tsy voa-load:", e.message);
      show("⚠️ DATA tsy voa-load: " + e.message);
    }

    const btn = $("predictBtn");
    if (btn) btn.addEventListener("click", onPredict);
    else console.warn("⚠️ predictBtn tsy hita ao HTML");
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
