// Match-9 Odds Signal Engine (1X2 + BTTS G/NG)
// - no team-name logic
// - signal from odds structure
// - batch output 9 matches

const N = 9;

const rowsEl = document.getElementById("rows");
const outEl = document.getElementById("out");
const metaEl = document.getElementById("meta");

const btnPredict = document.getElementById("predictAll");
const btnReset = document.getElementById("resetAll");
const btnExample = document.getElementById("fillExample");

// ---------- helpers ----------
function parseOdd(s) {
  if (s == null) return NaN;
  const t = String(s).trim().replace(/\s+/g, "");
  if (!t) return NaN;
  // accept comma or dot
  const normalized = t.replace(",", ".");
  const v = Number(normalized);
  return Number.isFinite(v) ? v : NaN;
}

function inv(x){ return 1 / x; }

function normProbs(invArr){
  const sum = invArr.reduce((a,b)=>a+b,0);
  if (!(sum > 0)) return { probs: invArr.map(()=>NaN), sum: NaN };
  return { probs: invArr.map(v=>v/sum), sum };
}

function pct(x){ return (x*100).toFixed(1) + "%"; }
function clamp(x, a, b){ return Math.max(a, Math.min(b, x)); }

function outcomeLabel(k){
  if (k === "1") return "1 (Home Win)";
  if (k === "X") return "X (Draw)";
  return "2 (Away Win)";
}

function favLabel(topP){
  if (topP >= 0.55) return "HEAVY_FAV";
  if (topP >= 0.46) return "SOLID_FAV";
  if (topP >= 0.40) return "SLIGHT_FAV";
  return "BALANCED";
}

function pillClassByStrength(x){
  if (x >= 0.60) return "good";
  if (x >= 0.53) return "warn";
  return "bad";
}

// ---------- core engine ----------
function analyzeMatch(input){
  const o1 = input.o1, oX = input.oX, o2 = input.o2;
  const oYes = input.oYes, oNo = input.oNo;

  // validate
  const odds = [o1,oX,o2,oYes,oNo];
  const ok = odds.every(v => Number.isFinite(v) && v > 1.00001);
  if (!ok) {
    return { ok:false, error:"Odds tsy feno na misy tsy mety (tokony > 1.00 daholo).", input };
  }

  // 1X2 implied + normalized
  const inv1x2 = [inv(o1), inv(oX), inv(o2)];
  const sumRaw1x2 = inv1x2.reduce((a,b)=>a+b,0);
  const overround1x2 = sumRaw1x2 - 1; // bookmaker margin approx
  const { probs: p1x2 } = normProbs(inv1x2);
  const P1 = p1x2[0], PX = p1x2[1], P2 = p1x2[2];

  // rank / favorite
  const arr = [
    { k:"1", p:P1, odd:o1 },
    { k:"X", p:PX, odd:oX },
    { k:"2", p:P2, odd:o2 },
  ].sort((a,b)=>b.p-a.p);

  const top = arr[0];
  const second = arr[1];
  const strength = top.p - second.p; // separation
  const fav = favLabel(top.p);

  // BTTS implied + normalized (Yes/No)
  const invBTTS = [inv(oYes), inv(oNo)];
  const sumRawBTTS = invBTTS.reduce((a,b)=>a+b,0);
  const overroundBTTS = sumRawBTTS - 1;
  const { probs: pBTTS } = normProbs(invBTTS);
  const PYes = pBTTS[0], PNo = pBTTS[1];
  const bttsPick = (PYes >= PNo) ? "YES" : "NO";
  const bttsStrength = Math.abs(PYes - PNo);

  // ---- Signals (from odds structure) ----
  const signals = [];

  // open/closed game
  const openGame = (PYes >= 0.55) || (PYes >= 0.50 && top.p <= 0.52);
  const closedGame = (PNo >= 0.58) || (PNo >= 0.52 && top.p >= 0.55);

  if (openGame) signals.push("OPEN_GAME");
  if (closedGame) signals.push("CLOSED_GAME");

  // BTTS intensity
  if (bttsPick === "YES") {
    signals.push(PYes >= 0.60 ? "BTTS_STRONG" : (PYes >= 0.53 ? "BTTS_SOFT" : "BTTS_WEAK"));
  } else {
    signals.push(PNo >= 0.60 ? "NO_BTS_STRONG" : (PNo >= 0.53 ? "NO_BTS_SOFT" : "NO_BTS_WEAK"));
  }

  // draw trap: draw prob high + low separation
  if (PX >= 0.30 && strength <= 0.07) signals.push("DRAW_TRAP");

  // coinflip / balanced
  if (top.p < 0.40) signals.push("COINFLIP");

  // value/risk signal from overround
  if (overround1x2 <= 0.055) signals.push("LOW_MARGIN");
  if (overround1x2 >= 0.085) signals.push("HIGH_MARGIN");

  // ---- Pick + confidence ----
  // base confidence from top prob, penalize overround, reward separation, adjust with BTTS clarity
  let conf = top.p;
  conf += clamp(strength * 0.45, 0, 0.06);
  conf += clamp(bttsStrength * 0.18, 0, 0.04);
  conf -= clamp(overround1x2 * 0.45, 0, 0.06);
  conf = clamp(conf, 0.33, 0.78);

  const pick = top.k;

  // suggestion bet (simple)
  let suggestion = "";
  if (pick === "X") {
    suggestion = "Safidy X matetika risika: azonao jerena 1X na X2 raha misy antony.";
  } else {
    // if favorite not super strong -> recommend DC
    if (conf < 0.52) {
      suggestion = pick === "1"
        ? "Raha te-hisafidy safe kokoa: 1X (Double Chance)."
        : "Raha te-hisafidy safe kokoa: X2 (Double Chance).";
    } else {
      suggestion = "Azonao atao straight na DC araka ny risk-nao.";
    }
  }

  return {
    ok:true,
    input,
    pick,
    confidence: conf,
    probs1x2: { P1, PX, P2, overround1x2 },
    btts: { PYes, PNo, bttsPick, overroundBTTS },
    fav,
    strength,
    signals,
    suggestion
  };
}

// Batch-level tags based on relative ranks (top BTTS yes, lowest BTTS yes, highest draw etc.)
function applyBatchContext(results){
  const ok = results.filter(r => r.ok);
  if (ok.length < 2) return results;

  const byYes = [...ok].sort((a,b)=>b.btts.PYes - a.btts.PYes);
  const byNo  = [...ok].sort((a,b)=>b.btts.PNo  - a.btts.PNo );
  const byDraw= [...ok].sort((a,b)=>b.probs1x2.PX - a.probs1x2.PX);

  // tag the extremes
  byYes[0].signals.push("TOP_BTTS_YES");
  byYes[byYes.length-1].signals.push("LOW_BTTS_YES");

  byNo[0].signals.push("TOP_BTTS_NO");
  byDraw[0].signals.push("TOP_DRAW");

  // small cleanup: unique signals
  results.forEach(r=>{
    if (!r.ok) return;
    r.signals = [...new Set(r.signals)];
  });

  return results;
}

// ---------- UI ----------
function makeRow(i){
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td class="small muted"><b>${i+1}</b></td>
    <td><input class="inp" data-k="note" placeholder="oh: Match ${i+1} / Ligue 1 / etc"></td>
    <td><input class="inp" data-k="o1" placeholder="oh: 1,45"></td>
    <td><input class="inp" data-k="oX" placeholder="oh: 4,21"></td>
    <td><input class="inp" data-k="o2" placeholder="oh: 7,54"></td>
    <td><input class="inp" data-k="oYes" placeholder="oh: 2,06"></td>
    <td><input class="inp" data-k="oNo" placeholder="oh: 1,74"></td>
  `;
  tr.dataset.idx = String(i);
  return tr;
}

function readRows(){
  const trs = [...rowsEl.querySelectorAll("tr")];
  return trs.map(tr=>{
    const idx = Number(tr.dataset.idx);
    const inputs = [...tr.querySelectorAll("input")];
    const obj = { idx, note:"", o1:NaN, oX:NaN, o2:NaN, oYes:NaN, oNo:NaN };

    for (const inp of inputs){
      const k = inp.dataset.k;
      if (k === "note") obj.note = inp.value.trim();
      else obj[k] = parseOdd(inp.value);
    }
    return obj;
  });
}

function resetRows(){
  const inputs = [...rowsEl.querySelectorAll("input")];
  inputs.forEach(x=> x.value = "");
  outEl.innerHTML = "";
  metaEl.textContent = "";
}

function fillExample(){
  // Example based on your screenshots style (manova raha ilainao)
  const ex = [
    {o1:"3,64", oX:"3,50", o2:"2,00", oYes:"1,69", oNo:"2,13", note:"Ex 1"},
    {o1:"1,45", oX:"4,21", o2:"7,54", oYes:"2,06", oNo:"1,74", note:"Ex 2"},
    {o1:"1,87", oX:"3,88", o2:"1,86", oYes:"1,54", oNo:"2,43", note:"Ex 3"},
    {o1:"2,09", oX:"2,89", o2:"4,24", oYes:"2,27", oNo:"1,62", note:"Ex 4"},
    {o1:"1,06", oX:"2,65", o2:"1,19", oYes:"2,06", oNo:"1,74", note:"Ex 5"},
    {o1:"3,06", oX:"3,76", o2:"2,14", oYes:"1,50", oNo:"2,55", note:"Ex 6"},
    {o1:"2,71", oX:"3,36", o2:"2,55", oYes:"1,67", oNo:"2,17", note:"Ex 7"},
    {o1:"1,55", oX:"4,03", o2:"5,99", oYes:"1,57", oNo:"2,36", note:"Ex 8"},
    {o1:"1,36", oX:"5,13", o2:"7,65", oYes:"1,76", oNo:"2,04", note:"Ex 9"},
  ];

  const trs = [...rowsEl.querySelectorAll("tr")];
  trs.forEach((tr,i)=>{
    const d = ex[i] || {};
    tr.querySelector('input[data-k="note"]').value = d.note || `Match ${i+1}`;
    tr.querySelector('input[data-k="o1"]').value = d.o1 || "";
    tr.querySelector('input[data-k="oX"]').value = d.oX || "";
    tr.querySelector('input[data-k="o2"]').value = d.o2 || "";
    tr.querySelector('input[data-k="oYes"]').value = d.oYes || "";
    tr.querySelector('input[data-k="oNo"]').value = d.oNo || "";
  });
}

function render(results){
  outEl.innerHTML = "";

  const okCount = results.filter(r=>r.ok).length;
  metaEl.textContent = `Matches valid: ${okCount}/${N}`;

  results.forEach(r=>{
    const card = document.createElement("div");
    card.className = "result";

    if (!r.ok){
      card.innerHTML = `
        <h3>#${r.input.idx+1} — <span class="muted">${escapeHtml(r.input.note || "Tsy misy fanampiny")}</span></h3>
        <div class="kv">
          <span class="muted">Status</span>
          <b class="pill bad">ERROR</b>
        </div>
        <div class="muted small">${escapeHtml(r.error)}</div>
      `;
      outEl.appendChild(card);
      return;
    }

    const confPct = Math.round(r.confidence * 100);
    const bttsMain = (r.btts.bttsPick === "YES") ? r.btts.PYes : r.btts.PNo;

    const pills = [
      { t:r.fav, cls: "pill " + (r.fav.includes("HEAVY") ? "good" : (r.fav.includes("BALANCED") ? "warn":"")) },
      { t:(r.btts.bttsPick === "YES" ? "BTTS_YES" : "BTTS_NO"), cls: "pill " + pillClassByStrength(bttsMain) }
    ];

    // add signals pills
    const sigPills = r.signals.map(s=>{
      const cls =
        s.includes("TOP_") ? "pill good" :
        s.includes("HIGH_MARGIN") ? "pill warn" :
        s.includes("DRAW_TRAP") ? "pill warn" :
        s.includes("WEAK") ? "pill bad" :
        "pill";
      return { t:s, cls };
    });

    card.innerHTML = `
      <h3>#${r.input.idx+1} — <span class="muted">${escapeHtml(r.input.note || "Match")}</span></h3>

      <div class="kv">
        <span class="muted">PICK</span>
        <b>${outcomeLabel(r.pick)}</b>
      </div>

      <div class="kv">
        <span class="muted">Confidence</span>
        <b>${confPct}%</b>
      </div>

      <div class="pill-row">
        ${pills.concat(sigPills).map(p=>`<span class="${p.cls}">${escapeHtml(p.t)}</span>`).join("")}
      </div>

      <div class="probgrid">
        <div class="prob">
          <div class="label">Probabilité (1X2 normalized)</div>
          <div class="val">P(1) ${pct(r.probs1x2.P1)} • P(X) ${pct(r.probs1x2.PX)} • P(2) ${pct(r.probs1x2.P2)}</div>
        </div>
        <div class="prob">
          <div class="label">BTTS (G/NG normalized)</div>
          <div class="val">Oui ${pct(r.btts.PYes)} • Non ${pct(r.btts.PNo)}</div>
        </div>
        <div class="prob">
          <div class="label">Book Margin (Overround)</div>
          <div class="val">1X2 ${(r.probs1x2.overround1x2*100).toFixed(1)}% • BTTS ${(r.btts.overroundBTTS*100).toFixed(1)}%</div>
        </div>
        <div class="prob">
          <div class="label">Suggestion</div>
          <div class="val" style="font-size:14px; font-weight:700; line-height:1.35">
            ${escapeHtml(r.suggestion)}
          </div>
        </div>
      </div>
    `;

    outEl.appendChild(card);
  });
}

function escapeHtml(str){
  return String(str)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

// ---------- init ----------
function init(){
  rowsEl.innerHTML = "";
  for (let i=0;i<N;i++) rowsEl.appendChild(makeRow(i));

  btnReset.addEventListener("click", resetRows);
  btnExample.addEventListener("click", ()=>{
    fillExample();
    outEl.innerHTML = "";
    metaEl.textContent = "Example filled. Tsindrio Predict.";
  });

  btnPredict.addEventListener("click", ()=>{
    const inputs = readRows();
    let results = inputs.map(analyzeMatch);
    results = applyBatchContext(results);
    render(results);
  });
}

init();
