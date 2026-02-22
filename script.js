let allData = [];

async function loadData() {
  const response = await fetch("data/france_virtual_league.csv");
  const text = await response.text();
  const rows = text.split("\n").slice(1);

  allData = rows
    .map(r => r.split(","))
    .filter(r => r.length === 10 && r[9] !== "NA")
    .map(r => ({
      league: r[0],
      journee: parseInt(r[1]),
      home: r[2],
      away: r[3],
      odd1: parseFloat(r[4]),
      oddX: parseFloat(r[5]),
      odd2: parseFloat(r[6]),
      result: r[9]
    }));
}

function normalize(p1, px, p2) {
  const total = p1 + px + p2;
  return [p1 / total, px / total, p2 / total];
}

function predict() {
  const input1 = parseFloat(document.getElementById("odd1").value);
  const inputX = parseFloat(document.getElementById("oddX").value);
  const input2 = parseFloat(document.getElementById("odd2").value);

  if (!input1 || !inputX || !input2) {
    alert("Ampidiro ny odds rehetra");
    return;
  }

  // 1️⃣ Esory journee farany
  const maxJournee = Math.max(...allData.map(d => d.journee));
  const training = allData.filter(d => d.journee < maxJournee);

  // 2️⃣ Implied probability
  let p1 = 1 / input1;
  let px = 1 / inputX;
  let p2 = 1 / input2;
  [p1, px, p2] = normalize(p1, px, p2);

  // 3️⃣ Mitady odds mitovitovy (range intelligent)
  const similar = training.filter(d =>
    Math.abs(d.odd1 - input1) <= 0.30 &&
    Math.abs(d.oddX - inputX) <= 0.40 &&
    Math.abs(d.odd2 - input2) <= 0.40
  );

  let homeWin = 0, draw = 0, awayWin = 0;

  similar.forEach(d => {
    const [h, a] = d.result.split("-").map(Number);
    if (h > a) homeWin++;
    else if (h === a) draw++;
    else awayWin++;
  });

  const total = similar.length || 1;

  const hist1 = homeWin / total;
  const histX = draw / total;
  const hist2 = awayWin / total;

  // 4️⃣ Weighting 60% data + 40% implied
  const final1 = 0.6 * hist1 + 0.4 * p1;
  const finalX = 0.6 * histX + 0.4 * px;
  const final2 = 0.6 * hist2 + 0.4 * p2;

  const results = [
    { type: "1 (Home)", value: final1 },
    { type: "X (Draw)", value: finalX },
    { type: "2 (Away)", value: final2 }
  ];

  results.sort((a, b) => b.value - a.value);

  // Score exact
  let scoreCount = {};
  similar.forEach(d => {
    scoreCount[d.result] = (scoreCount[d.result] || 0) + 1;
  });

  let bestScore = Object.entries(scoreCount)
    .sort((a, b) => b[1] - a[1])[0];

  document.getElementById("output").innerHTML = `
    <p><strong>Résultat (AI V2):</strong> ${results[0].type}</p>
    <p>% Home: ${(final1*100).toFixed(1)}% |
       Draw: ${(finalX*100).toFixed(1)}% |
       Away: ${(final2*100).toFixed(1)}%</p>
    <p><strong>Score Exact (DATA):</strong> ${bestScore ? bestScore[0] : "N/A"}</p>
    <p>Match similaires trouvés: ${similar.length}</p>
  `;
}

loadData();
