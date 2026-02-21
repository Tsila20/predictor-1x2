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
    const s = String(val).trim().replace(",", ".");
    return Number(s);
  }

  function percent(x) {
    return (x * 100).toFixed(1) + "%";
  }

  // -------- Odds -> implied probs (fallback) --------
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

  // -------- CSV / DATA --------
  let DATA = [];
  let DATA_READY = false;

  function parseCSVSimple(text) {
    // NOTE: tsotra (tsy mi-handle quote complex), ampy raha tsotra ny CSV anao
    const lines = text.trim().split(/\r?\n/);
    const headers = lines[0].split(",").map((h) => h.trim());

    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const values = line.split(","); // raha misy virgule ao anaty team name dia mila parser matanjaka kokoa
      const obj = {};
      headers.forEach((h, idx) => (obj[h] = (values[idx] ?? "").trim()));
      rows.push(obj);
    }
    return rows;
  }

  async function loadCSV() {
    const url = "./data/france_virtual_league.csv"; // ✅ path ho an'ny GitHub Pages
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error("CSV tsy voa-load: " + res.status);

    const text = await res.text();
    const rows = parseCSVSimple(text);

    // Convert odds columns ho number
    rows.forEach((r) => {
      r.odd_1 = toNumber(r.odd_1);
      r.odd_x = toNumber(r.odd_x);
      r.odd_2 = toNumber(r.odd_2);
      // result mety hoe "1-0" na "2-1" ao amin'ny CSV
      r.result = (r.result || "").trim();
    });

    return rows.filter((r) => Number.isFinite(r.odd_1) && Number.isFinite(r.odd_x) && Number.isFinite(r.odd_2));
  }

  function findClosestRowsByOdds(o1, ox, o2, k = 25) {
    // mandray rows akaiky indrindra amin'ny odds (distance)
    const scored = DATA.map((r) => {
      const d =
        Math.abs(r.odd_1 - o1) +
        Math.abs(r.odd_x - ox) +
        Math.abs(r.odd_2 - o2);
      return { r, d };
    });

    scored.sort((a, b) => a.d - b.d);
    return scored.slice(0, Math.min(k, scored.length)).map((x) => x.r);
  }

  function outcomeFromScore(scoreStr) {
    // "1-0" => home win, "0-1" => away win, "1-1" => draw
    const m = String(scoreStr).match(/(\d+)\s*-\s*(\d+)/);
    if (!m) return null;
    const h = Number(m[1]);
    const a = Number(m[2]);
    if (h > a) return "1";
    if (h < a) return "2";
    return "X";
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

    // score exact matetika indrindra
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

  // -------- Main --------
  function onPredict() {
    try {
      const modeEl = $("mode");
      const odd1El = $("odd1");
      const oddXEl = $("oddX");
      const odd2El = $("odd2");

      if (!modeEl || !odd1El || !oddXEl || !odd2El) {
        show("❌ Misy ID tsy hita (mode/odd1/oddX/odd2/resultBox). Jereo index.html.");
        return;
      }

      const mode = modeEl.value;

      const o1 = toNumber(odd1El.value);
      const ox = toNumber(oddXEl.value);
      const o2 = toNumber(odd2El.value);

      if (!Number.isFinite(o1) || !Number.isFinite(ox) || !Number.isFinite(o2) || o1 <= 1 || ox <= 1 || o2 <= 1) {
        show("⚠️ Fenoy tsara ny Odds (oh: 2.30 na 2,30) ary tsy tokony ho latsaky ny 1.01.");
        return;
      }

      // ✅ Raha voa-load DATA dia mampiasa dataset
      if (DATA_READY && DATA.length > 0) {
        const nearest = findClosestRowsByOdds(o1, ox, o2, 25);
        const s = statsFromRows(nearest);

        // raha mbola “tsy misy result” ao amin'ireo rows akaiky -> fallback
        const hasAny = s.n > 0 && (s.p1 + s.px + s.p2) > 0;

        if (hasAny) {
          const out = pickOutcome({ p1: s.p1, px: s.px, p2: s.p2 });
          const score = s.bestScore || "-";

          if (mode === "SCORE") {
            show(`🎯 <b>Score Exact (from DATA):</b> <b>${score}</b><br/><small>Rows nalaina: ${s.n}</small>`);
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
      }

      // 🔁 Fallback: implied probs
      const p = impliedProbs(o1, ox, o2);
      const out = pickOutcome(p);
      const score = (function exactScoreFromProbs(p) {
        const out = pickOutcome(p);
        if (out.key === "X") return p.px > 0.38 ? "1 - 1" : "0 - 0";
        if (out.key === "1") return p.p1 >= 0.60 ? "2 - 0" : p.p1 >= 0.52 ? "2 - 1" : "1 - 0";
        return p.p2 >= 0.60 ? "0 - 2" : p.p2 >= 0.52 ? "1 - 2" : "0 - 1";
      })(p);

      if (mode === "SCORE") {
        show(`🎯 <b>Score Exact (fallback):</b> <b>${score}</b>`);
        return;
      }

      show(`
        ✅ <b>Résultat (fallback):</b> <b>${out.label}</b><br/>
        📊 <b>%</b> Home: <b>${percent(p.p1)}</b> | Draw: <b>${percent(p.px)}</b> | Away: <b>${percent(p.p2)}</b><br/>
        🎯 <b>Score Exact (fallback):</b> <b>${score}</b><br/>
        <small>⚠️ DATA tsy mbola voa-load na tsy misy match akaiky.</small>
      `);
    } catch (err) {
      show("❌ Nisy erreur JS: " + (err && err.message ? err.message : err));
    }
  }

  async function boot() {
    const btn = $("predictBtn");
    if (!btn) {
      show("❌ Tsy hita ny bouton predictBtn. Jereo index.html.");
      return;
    }

    // 🔽 load DATA
    try {
      DATA = await loadCSV();
      DATA_READY = true;
      console.log("✅ DATA LOADED:", DATA.length);
    } catch (e) {
      DATA_READY = false;
      console.warn("⚠️ DATA tsy voa-load:", e.message);
      // tsy asiana show eto raha tsy tianao hanelingelina; fallback no mbola mandeha
    }

    btn.addEventListener("click", onPredict);
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
