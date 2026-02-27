/* Preductor 1X2 — PRO UI (Manual match)
   - Works with comma odds "2,48"
   - Predict shows Pick + Confidence + Normalized prob
   - Ticket + Stake + Payout + History (localStorage)
*/

const $ = (id) => document.getElementById(id);

const STORAGE = {
  balance: "pred_balance",
  history: "pred_history"
};

let state = {
  league: "French League",
  pick: null,
  pickOdd: null,
  conf: null,
  prob: null
};

boot();

function boot(){
  // hard guard: if script not loaded, you will never see this.
  console.log("✅ script.js loaded");

  // league tabs
  document.querySelectorAll("#leagueSeg .seg-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#leagueSeg .seg-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      state.league = btn.dataset.league;
      $("leaguePill").textContent = state.league;
      syncSlip();
    });
  });

  // input changes
  $("home").addEventListener("input", syncSlip);
  $("away").addEventListener("input", syncSlip);

  // click boxes = select pick quickly (bet261 style)
  $("box1").addEventListener("click", (e)=>{ if (e.target.tagName !== "INPUT") selectPick("1"); });
  $("boxX").addEventListener("click", (e)=>{ if (e.target.tagName !== "INPUT") selectPick("X"); });
  $("box2").addEventListener("click", (e)=>{ if (e.target.tagName !== "INPUT") selectPick("2"); });

  // buttons
  $("btnPredict").addEventListener("click", () => predict(false));
  $("btnAutoPick").addEventListener("click", () => predict(true));
  $("btnReset").addEventListener("click", resetAll);

  // stake chips
  $("stake").addEventListener("input", updatePayout);
  document.querySelectorAll(".chip").forEach(c=>{
    c.addEventListener("click", ()=>{
      $("stake").value = c.dataset.stake;
      updatePayout();
    });
  });

  // save / clear
  $("btnSave").addEventListener("click", saveHistory);
  $("btnClearHistory").addEventListener("click", clearHistory);

  // balance persist
  const b = localStorage.getItem(STORAGE.balance);
  if (b !== null) $("balance").value = b;
  $("balance").addEventListener("input", () => localStorage.setItem(STORAGE.balance, $("balance").value));

  // raw button (placeholder)
  $("btnLoadRaw").addEventListener("click", ()=>{
    alert("Raw mode mbola tsy ampidirina eto. Ity page ity dia manual match (bet261 style).");
  });

  renderHistory();
  renderPredEmpty();
  syncSlip();
  updatePayout();
}

/* ---------------- core predict ---------------- */

function predict(autoPick){
  const o1 = toNum($("odd1").value);
  const ox = toNum($("oddx").value);
  const o2 = toNum($("odd2").value);

  // validate odds
  if (!isFinite(o1) || !isFinite(ox) || !isFinite(o2) || o1 <= 1 || ox <= 1 || o2 <= 1){
    showPred("—", "Odds tsy mety. Ataovy > 1.00 (oh: 2,48)", null, null);
    setTicketStatus(false);
    return;
  }

  // normalized implied probabilities
  const p = impliedProbs(o1, ox, o2);
  const best = argmax({ "1": p.p1, "X": p.px, "2": p.p2 });

  // pick logic
  if (autoPick || !state.pick){
    selectPick(best);
  } else {
    // update pickOdd if user had picked earlier
    state.pickOdd = (state.pick === "1") ? o1 : (state.pick === "X" ? ox : o2);
    $("slipOdd").textContent = fmt(state.pickOdd);
  }

  // compute confidence for chosen pick
  const chosenProb = (state.pick === "1") ? p.p1 : (state.pick === "X" ? p.px : p.p2);
  state.conf = Math.max(p.p1, p.px, p.p2); // market strongest side
  state.prob = chosenProb;

  const msg = `Pick: ${state.pick} • Prob(norm): ${(state.prob*100).toFixed(1)}%`;
  showPred(state.pick, msg, state.conf, state.prob);

  // serious rule: require minimum confidence
  const ok = state.prob >= 0.40;  // you can adjust later
  setTicketStatus(ok);

  syncSlip();
  updatePayout();
}

function selectPick(pick){
  state.pick = pick;

  const o1 = toNum($("odd1").value);
  const ox = toNum($("oddx").value);
  const o2 = toNum($("odd2").value);

  state.pickOdd = pick === "1" ? o1 : (pick === "X" ? ox : o2);

  $("slipPick").textContent = pick;
  $("slipOdd").textContent = isFinite(state.pickOdd) ? fmt(state.pickOdd) : "—";

  // small UI highlight (optional)
  highlightPickBox(pick);

  syncSlip();
  updatePayout();
}

function highlightPickBox(pick){
  // reset backgrounds
  ["box1","boxX","box2"].forEach(id=>{
    $(id).style.borderColor = "rgba(31,42,68,0.9)";
  });
  if (pick === "1") $("box1").style.borderColor = "rgba(34,197,94,0.75)";
  if (pick === "X") $("boxX").style.borderColor = "rgba(34,197,94,0.75)";
  if (pick === "2") $("box2").style.borderColor = "rgba(34,197,94,0.75)";
}

/* ---------------- ticket helpers ---------------- */

function setTicketStatus(ok){
  const el = $("ticketStatus");
  if (ok){
    el.textContent = "READY";
    el.className = "pill";
  } else {
    el.textContent = "NO BET";
    el.className = "pill pill-warn";
  }
}

function syncSlip(){
  const home = ($("home").value || "").trim() || "Équipe 1";
  const away = ($("away").value || "").trim() || "Équipe 2";
  $("slipMatch").textContent = `${state.league} • ${home} vs ${away}`;

  if (!state.pick){
    $("slipPick").textContent = "—";
    $("slipOdd").textContent = "—";
  }
}

function updatePayout(){
  const stake = toNum($("stake").value);
  const odd = state.pickOdd;

  if (!isFinite(stake) || stake <= 0 || !isFinite(odd) || odd <= 1){
    $("payout").textContent = "—";
    return;
  }
  const gain = stake * odd;
  $("payout").textContent = `${Math.round(gain)} MGA`;
}

/* ---------------- history ---------------- */

function saveHistory(){
  const home = ($("home").value || "").trim();
  const away = ($("away").value || "").trim();
  if (!home || !away){
    alert("Ampidiro ny anaran'équipe (home/away).");
    return;
  }
  if (!state.pick || !isFinite(state.pickOdd)){
    alert("Misafidiana pick (1/X/2) aloha, na Auto-pick.");
    return;
  }

  const item = {
    t: new Date().toISOString(),
    league: state.league,
    home, away,
    odd1: toNum($("odd1").value),
    oddx: toNum($("oddx").value),
    odd2: toNum($("odd2").value),
    pick: state.pick,
    pickOdd: state.pickOdd,
    prob: state.prob,
    conf: state.conf,
    stake: toNum($("stake").value) || 0
  };

  const arr = JSON.parse(localStorage.getItem(STORAGE.history) || "[]");
  arr.unshift(item);
  localStorage.setItem(STORAGE.history, JSON.stringify(arr.slice(0, 80)));
  renderHistory();
}

function clearHistory(){
  localStorage.removeItem(STORAGE.history);
  renderHistory();
}

function renderHistory(){
  const wrap = $("history");
  const arr = JSON.parse(localStorage.getItem(STORAGE.history) || "[]");

  if (!arr.length){
    wrap.innerHTML = `<div class="hist-item">
      <div class="hist-match">Aucun historique</div>
      <div class="hist-meta">Enregistre un ticket pour le voir ici.</div>
    </div>`;
    return;
  }

  wrap.innerHTML = arr.map(x=>{
    const date = new Date(x.t);
    const when = `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
    const pr = (x.prob==null) ? "—" : `${(x.prob*100).toFixed(1)}%`;
    const stake = x.stake ? `${Math.round(x.stake)} MGA` : "—";
    return `
      <div class="hist-item">
        <div class="hist-top">
          <div class="hist-match">${esc(x.home)} vs ${esc(x.away)}</div>
          <div class="pill">${esc(x.pick)} @ ${fmt(x.pickOdd)}</div>
        </div>
        <div class="hist-meta">
          ${esc(x.league)} • ${when}<br/>
          Prob: <b>${pr}</b> • Mise: <b>${stake}</b>
        </div>
      </div>
    `;
  }).join("");
}

/* ---------------- reset & pred UI ---------------- */

function resetAll(){
  // keep league as is
  $("home").value = "Toulouse";
  $("away").value = "Metz";
  $("odd1").value = "2,48";
  $("oddx").value = "3,58";
  $("odd2").value = "1,85";
  $("stake").value = "0";

  state.pick = null;
  state.pickOdd = null;
  state.conf = null;
  state.prob = null;

  ["box1","boxX","box2"].forEach(id=>{
    $(id).style.borderColor = "rgba(31,42,68,0.9)";
  });

  renderPredEmpty();
  setTicketStatus(false);
  syncSlip();
  updatePayout();
}

function renderPredEmpty(){
  showPred("—", "Entrez les odds, puis Predict.", null, null);
}

function showPred(main, sub, conf, prob){
  $("predMain").textContent = main;
  $("predSub").textContent = sub;
  $("conf").textContent = conf==null ? "—" : `${(conf*100).toFixed(1)}%`;
  $("prob").textContent = prob==null ? "—" : `${(prob*100).toFixed(1)}%`;
}

/* ---------------- math ---------------- */

function impliedProbs(o1, ox, o2){
  const p1 = 1/o1, px = 1/ox, p2 = 1/o2;
  const s = p1 + px + p2;
  return { p1: p1/s, px: px/s, p2: p2/s };
}

function argmax(map){
  let bestK = null;
  let bestV = -Infinity;
  for (const k in map){
    if (map[k] > bestV){
      bestV = map[k];
      bestK = k;
    }
  }
  return bestK;
}

/* ---------------- utils ---------------- */

function toNum(s){
  // supports "2,48" and "2.48"
  const v = String(s ?? "").replace(/\s+/g,"").replace(",", ".").trim();
  const n = Number(v);
  return n;
}

function fmt(n){
  if (!isFinite(n)) return "—";
  return Number(n).toFixed(2);
}

function esc(str){
  return String(str).replace(/[&<>"']/g, m => ({
    "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"
  }[m]));
}
