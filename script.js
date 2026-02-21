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

  function impliedProbs(o1, ox, o2) {
    const p1 = 1 / o1;
    const px = 1 / ox;
    const p2 = 1 / o2;
    const sum = p1 + px + p2;
    return {
      p1: p1 / sum,
      px: px / sum,
      p2: p2 / sum,
    };
  }

  function pickOutcome(p) {
    if (p.p1 >= p.px && p.p1 >= p.p2) return { key: "1", prob: p.p1, label: "1 (Home)" };
    if (p.px >= p.p1 && p.px >= p.p2) return { key: "X", prob: p.px, label: "X (Draw)" };
    return { key: "2", prob: p.p2, label: "2 (Away)" };
  }

  // "Score exact" tsotra (heuristique)
  function exactScoreFromProbs(p) {
    const out = pickOutcome(p);

    // Draw
    if (out.key === "X") {
      if (p.px > 0.38) return "1 - 1";
      return "0 - 0";
    }

    // Home win
    if (out.key === "1") {
      if (p.p1 >= 0.60) return "2 - 0";
      if (p.p1 >= 0.52) return "2 - 1";
      return "1 - 0";
    }

    // Away win
    if (out.key === "2") {
      if (p.p2 >= 0.60) return "0 - 2";
      if (p.p2 >= 0.52) return "1 - 2";
      return "0 - 1";
    }
  }

  function percent(x) {
    return (x * 100).toFixed(1) + "%";
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

      const p = impliedProbs(o1, ox, o2);
      const out = pickOutcome(p);
      const score = exactScoreFromProbs(p);

      if (mode === "SCORE") {
        show(`🎯 <b>Score Exact (estimation):</b> <b>${score}</b>`);
        return;
      }

      // Default 1X2
      show(`
        ✅ <b>Résultat:</b> <b>${out.label}</b><br/>
        📊 <b>%</b> Home: <b>${percent(p.p1)}</b> | Draw: <b>${percent(p.px)}</b> | Away: <b>${percent(p.p2)}</b><br/>
        🎯 <b>Score Exact (estimation):</b> <b>${score}</b>
      `);
    } catch (err) {
      show("❌ Nisy erreur JS: " + (err && err.message ? err.message : err));
    }
  }

  function boot() {
    const btn = $("predictBtn");
    if (!btn) {
      show("❌ Tsy hita ny bouton predictBtn. Jereo index.html.");
      return;
    }
    btn.addEventListener("click", onPredict);
    // Debug: manamarina fa tafapetraka ilay click
    // show("✅ Ready: fenoy ny odds dia tsindrio Predict.");
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
