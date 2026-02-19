// ========= Helpers =========
function toOdd(x) {
  if (x === null || x === undefined) return null;
  const s = String(x).trim();
  if (!s) return null;
  const v = parseFloat(s.replace(",", "."));
  return Number.isFinite(v) && v > 1 ? v : null;
}

function impliedProb(odd) {
  return odd ? 1 / odd : null;
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function pct(x) {
  return (x * 100).toFixed(1) + "%";
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

function pickFavorite(oHome, oAway) {
  if (oHome < oAway) return { side: "1", odd: oHome };
  if (oAway < oHome) return { side: "2", odd: oAway };
  return { side: "EQUAL", odd: oHome };
}

// ========= Core Engine =========
function compute1X2Probs(o1, oX, o2) {
  const p1 = impliedProb(o1);
  const pX = impliedProb(oX);
  const p2 = impliedProb(o2);
  const sum = p1 + pX + p2;

  // Overround (book margin)
  const overround = sum; // > 1

  // Normalize probabilities so they sum to 1 (fair-ish)
  const n1 = p1 / sum;
  const nX = pX / sum;
  const n2 = p2 / sum;

  return { n1, nX, n2, overround };
}

function bttsSignal(yesOdd, noOdd) {
  const pYes = impliedProb(yesOdd);
  const pNo = impliedProb(noOdd);
  if (!pYes || !pNo) return { label: "UNKNOWN", edge: 0 };

  // Lower odd => higher implied chance
  if (yesOdd <= 1.60) return { label: "BTTS_YES_LIKELY", edge: 0.15 };
  if (noOdd  <= 1.60) return { label: "BTTS_NO_LIKELY",  edge: 0.15 };

  // balanced check
  const gap = Math.abs(yesOdd - noOdd);
  if (gap <= 0.20) return { label: "BTTS_BALANCED", edge: 0.05 };

  return { label: "BTTS_SOFT", edge: 0.08 };
}

function favoriteStrength(favOdd) {
  if (favOdd <= 1.45) return "STRONG_FAV";
  if (favOdd <= 1.70) return "FAV";
  if (favOdd <= 2.10) return "SLIGHT_FAV";
  return "OPEN";
}

// "Draw-trap": raha Draw prob avo + Favorite tsy "strong"
function drawTrap(nX, favType) {
  if (nX >= 0.30 && (favType === "FAV" || favType === "SLIGHT_FAV")) return true;
  if (nX >= 0.33 && favType !== "STRONG_FAV") return true;
  return false;
}

// Main decision (simple but pro signal-based)
function predictFromOdds(o1, oX, o2, yesOdd, noOdd) {
  const probs = compute1X2Probs(o1, oX, o2);
  const fav = pickFavorite(o1, o2);
  const favType = favoriteStrength(fav.odd);
  const trap = drawTrap(probs.nX, favType);

  const btts = bttsSignal(yesOdd, noOdd);

  // Confidence base = best normalized prob
  const bestProb = Math.max(probs.n1, probs.nX, probs.n2);

  // Pick logic:
  // - strong fav => 1 or 2
  // - draw-trap => X / avoid
  // - otherwise pick max probability (1/X/2)
  let pick = "NO_BET";
  let tags = [];
  let suggestions = [];

  // Book margin sanity
  const marginPct = (probs.overround - 1);
  if (marginPct > 0.12) tags.push({ t: "HIGH_MARGIN", cls: "warn" });

  // BTTS tags
  if (btts.label === "BTTS_YES_LIKELY") tags.push({ t: "BTTS_YES", cls: "good" });
  if (btts.label === "BTTS_NO_LIKELY") tags.push({ t: "BTTS_NO", cls: "good" });
  if (btts.label === "BTTS_BALANCED") tags.push({ t: "BTTS_BALANCED", cls: "warn" });
  if (btts.label === "BTTS_SOFT") tags.push({ t: "BTTS_SOFT", cls: "warn" });

  // Trap tag
  if (trap) tags.push({ t: "DRAW_TRAP", cls: "bad" });

  // Favorite tag
  if (favType === "STRONG_FAV") tags.push({ t: "STRONG_FAV", cls: "good" });
  else if (favType === "FAV") tags.push({ t: "FAV", cls: "warn" });
  else tags.push({ t: "OPEN_GAME", cls: "warn" });

  // Decide pick
  if (favType === "STRONG_FAV" && !trap) {
    pick = (fav.side === "1") ? "PICK: 1 (Home Win)" : "PICK: 2 (Away Win)";
    suggestions.push("Raha te-hilamina: safidy 'DC' (1X na X2) mifanaraka amin’ilay favorite.");
    suggestions.push("Azonao ampiana BTTS raha mifanaraka amin’ny signal (G/NG).");
  } else if (trap) {
    // draw trap: push draw/avoid
    pick = "PICK: X (Draw) / AVOID";
    suggestions.push("Soso-kevitra: 'X' na 'DC' miaro nul (1X na X2 arakaraka ny match).");
    suggestions.push("Aza miditra 1 na 2 “straight” raha tsy manana info fanampiny.");
  } else {
    // choose highest prob
    if (bestProb === probs.n1) pick = "PICK: 1 (Home Win)";
    else if (bestProb === probs.n2) pick = "PICK: 2 (Away Win)";
    else pick = "PICK: X (Draw)";
    suggestions.push("Raha tsy matanjaka loatra ny pick: aleo DC na market safe.");
  }

  // Confidence adjustment using signals
  let conf = bestProb;

  // Strong fav boosts confidence a bit
  if (favType === "STRONG_FAV") conf += 0.06;
  if (favType === "FAV") conf += 0.03;

  // Trap reduces
  if (trap) conf -= 0.08;

  // BTTS slight adjust
  conf += (btts.edge || 0) * 0.25;

  // High margin reduces slightly
  if (marginPct > 0.12) conf -= 0.03;

  conf = clamp01(conf);

  return {
    pick,
    confidence: conf,
    tags,
    suggestions,
    probs,
    fav: { side: fav.side, odd: fav.odd, type: favType },
    btts
  };
}

// ========= UI Wiring =========
const els = {
  oddHome: document.getElementById("oddHome"),
  oddDraw: document.getElementById("oddDraw"),
  oddAway: document.getElementById("oddAway"),
  oddYes: document.getElementById("oddYes"),
  oddNo: document.getElementById("oddNo"),
  note: document.getElementById("note"),

  btnPredict: document.getElementById("btnPredict"),
  btnReset: document.getElementById("btnReset"),

  alert: document.getElementById("alert"),
  result: document.getElementById("result"),

  pick: document.getElementById("pick"),
  confidence: document.getElementById("confidence"),
  badges: document.getElementById("badges"),

  p1: document.getElementById("p1"),
  px: document.getElementById("px"),
  p2: document.getElementById("p2"),
  margin: document.getElementById("margin"),
  fav: document.getElementById("fav"),
  btts: document.getElementById("btts"),

  suggestions: document.getElementById("suggestions"),
  noteOut: document.getElementById("noteOut"),
};

function showError(msg) {
  els.alert.textContent = msg;
  els.alert.classList.remove("hidden");
  els.result.classList.add("hidden");
}

function clearError() {
  els.alert.classList.add("hidden");
  els.alert.textContent = "";
}

function renderBadges(tags) {
  els.badges.innerHTML = "";
  tags.forEach(({t, cls}) => {
    const s = document.createElement("span");
    s.className = `badge ${cls || ""}`.trim();
    s.textContent = t;
    els.badges.appendChild(s);
  });
}

function renderSuggestions(list) {
  els.suggestions.innerHTML = "";
  (list || []).forEach(item => {
    const li = document.createElement("li");
    li.textContent = item;
    els.suggestions.appendChild(li);
  });
}

function onPredict() {
  clearError();

  const o1 = toOdd(els.oddHome.value);
  const oX = toOdd(els.oddDraw.value);
  const o2 = toOdd(els.oddAway.value);
  const yes = toOdd(els.oddYes.value);
  const no  = toOdd(els.oddNo.value);

  if (!o1 || !oX || !o2) {
    return showError("Ampidiro tsara ny odds 1X2 (1, X, 2) — tokony > 1 daholo.");
  }
  // BTTS optional, fa raha feno iray dia tokony feno roa
  if ((yes && !no) || (!yes && no)) {
    return showError("Raha mampiditra G/NG dia fenoy izy roa: Oui sy Non.");
  }

  const out = predictFromOdds(o1, oX, o2, yes, no);

  // Render main
  els.pick.textContent = out.pick;
  els.confidence.textContent = `Confidence: ${(out.confidence * 100).toFixed(0)}%`;

  renderBadges(out.tags);

  // Probs
  els.p1.textContent = pct(out.probs.n1);
  els.px.textContent = pct(out.probs.nX);
  els.p2.textContent = pct(out.probs.n2);

  const marginPct = (out.probs.overround - 1) * 100;
  els.margin.textContent = marginPct.toFixed(1) + "%";

  els.fav.textContent =
    (out.fav.side === "1" ? "Home" : out.fav.side === "2" ? "Away" : "Equal")
    + ` (odd ${round2(out.fav.odd)}) — ${out.fav.type}`;

  els.btts.textContent = yes && no ? out.btts.label : "NOT PROVIDED";

  renderSuggestions(out.suggestions);

  const note = (els.note.value || "").trim();
  els.noteOut.textContent = note ? `Note: ${note}` : "";

  els.result.classList.remove("hidden");
}

function onReset() {
  clearError();
  els.result.classList.add("hidden");
  ["oddHome","oddDraw","oddAway","oddYes","oddNo","note"].forEach(k => (els[k].value = ""));
}

els.btnPredict.addEventListener("click", onPredict);
els.btnReset.addEventListener("click", onReset);

// Enter key triggers predict
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter") onPredict();
});
