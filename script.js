async function loadData() {
    const response = await fetch("data/france_virtual_league.csv");
    const text = await response.text();
    return parseCSV(text);
}

function parseCSV(data) {
    const rows = data.split("\n").slice(1);
    return rows.map(row => {
        const cols = row.split(",");
        return {
            home: cols[2],
            away: cols[3],
            odd1: parseFloat(cols[4]),
            oddX: parseFloat(cols[5]),
            odd2: parseFloat(cols[6]),
            result: cols[11]
        };
    });
}

function analyze(matches) {
    let stats = { home: 0, draw: 0, away: 0 };

    matches.forEach(match => {
        if (match.result === "1") stats.home++;
        if (match.result === "X") stats.draw++;
        if (match.result === "2") stats.away++;
    });

    let total = matches.length;

    return {
        home: ((stats.home / total) * 100).toFixed(1),
        draw: ((stats.draw / total) * 100).toFixed(1),
        away: ((stats.away / total) * 100).toFixed(1)
    };
}

async function predictFromHistory() {
    const data = await loadData();
    const result = analyze(data);

    document.getElementById("result").innerHTML =
        "Historical Home Win: " + result.home + "%<br>" +
        "Historical Draw: " + result.draw + "%<br>" +
        "Historical Away Win: " + result.away + "%";
}
