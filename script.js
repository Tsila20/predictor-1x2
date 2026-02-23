function weightedStatsFromData(o1, ox, o2) {
  const eps = 1e-6;

  const MAX_DISTANCE = 1.0;     // filtre lavitra
  const TOP_CLUSTER = 25;       // maka 25 akaiky indrindra
  const RECENT_WEIGHT = 1.8;    // boost récent
  const MIN_RESULTS = 5;        // minimum validation

  // 1️⃣ Calcule distance rehetra
  const scanned = DATA_MODEL.map(r => {
    const distance =
      Math.abs(r.odd_1 - o1) +
      Math.abs(r.odd_x - ox) +
      Math.abs(r.odd_2 - o2);

    return { ...r, distance };
  })
  .filter(r => r.distance <= MAX_DISTANCE)   // 2️⃣ filtre lavitra
  .sort((a, b) => a.distance - b.distance)
  .slice(0, TOP_CLUSTER);                     // 3️⃣ cluster akaiky

  if (scanned.length === 0) return { ok: false };

  let w1 = 0, wX = 0, w2 = 0;
  const scoreMap = new Map();
  let usedWithResult = 0;

  const latestJ = Math.max(...scanned.map(r => r.journee_num || 0));

  for (const r of scanned) {
    const outcome = outcomeFromScore(r.result);
    if (!outcome) continue;

    usedWithResult++;

    // 4️⃣ Momentum récent
    const recentBoost =
      r.journee_num >= latestJ - 3
        ? RECENT_WEIGHT
        : 1;

    // 5️⃣ Weight final dynamique
    const weight = (1 / (r.distance + eps)) * recentBoost;

    if (outcome === "1") w1 += weight;
    else if (outcome === "X") wX += weight;
    else if (outcome === "2") w2 += weight;

    const sc = r.result.trim();
    scoreMap.set(sc, (scoreMap.get(sc) || 0) + weight);
  }

  const total = w1 + wX + w2;

  if (total === 0 || usedWithResult < MIN_RESULTS) {
    return { ok: false };
  }

  // 6️⃣ Score exact matanjaka indrindra
  let bestScore = "";
  let bestWeight = -1;

  for (const [score, weight] of scoreMap.entries()) {
    if (weight > bestWeight) {
      bestWeight = weight;
      bestScore = score;
    }
  }

  return {
    ok: true,
    p1: w1 / total,
    px: wX / total,
    p2: w2 / total,
    bestScore,
    used: scanned.length,
    usedWithResult
  };
}
