const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 10000;

const dbPath = path.resolve(__dirname, 'schweizer_fussball_grid.db');
const db = new sqlite3.Database(dbPath);

app.use(express.json());
app.use(express.static(__dirname));
app.use('/logos', express.static(path.join(__dirname, 'logos')));

// --- FIXIERTES MAPPING (Wird nicht mehr geändert) ---
const CLUB_MAP = {
    "Basel": "FC Basel 1893", "Thun": "FC Thun", "St. Gallen": "FC St. Gallen 1879",
    "Lugano": "FC Lugano", "Sion": "FC Sion", "Young Boys": "Young Boys",
    "Luzern": "FC Luzern", "Grasshopper": "Grasshopper Club Zürich",
    "Zürich": "FC Zürich", "Winterthur": "FC Winterthur", "Lausanne": "Lausanne-Sport",
    "Servette": "Servette FC", "Aarau": "FC Aarau", "Vaduz": "FC Vaduz"
};

const NATION_MAP = {
    "SUI": "Switzerland", "ALB": "Albania", "GER": "Germany", "FRA": "France",
    "ITA": "Italy", "SRB": "Serbia", "KOS": "Kosovo", "AUT": "Austria", "ESP": "Spain", "BRA": "Brazil"
};

const LEAGUE_MAP = {
    "Germany": "Bundesliga", "England": "Premier League",
    "France": "Ligue 1", "Spain": "La Liga", "Italy": "Serie A"
};

// --- OPTIMIERTER GENERATOR (Logik-Update) ---
function generateDailyGridData() {
    const clubs = Object.keys(CLUB_MAP);
    const nations = Object.keys(NATION_MAP);
    const leagues = Object.keys(LEAGUE_MAP);
    const specials = [
        { type: 'champion', value: 'CHAMP', label: 'Meister' },
        { type: 'cupwinner', value: 'CUP', label: 'Cupsieger' },
        { type: 'goals_50', value: 'G50', label: '> 50 Tore' },
        { type: 'goals_season_10', value: 'GS10', label: '> 10 Tore/Sais.' }
    ];

    let rowSelection = [];
    let colSelection = [];

    // 1. Eine Nation auswählen (Chance 70%)
    let selectedNation = null;
    if (Math.random() > 0.3) {
        selectedNation = nations[Math.floor(Math.random() * nations.length)];
    }

    // 2. Pools mischen
    const shuffledClubs = clubs.sort(() => 0.5 - Math.random());
    const shuffledExtras = [...leagues.map(l => ({ type: 'league', value: l, label: l })), ...specials].sort(() => 0.5 - Math.random());

    // 3. Reihen füllen (Immer Clubs für hohe Lösbarkeit)
    rowSelection = shuffledClubs.slice(0, 3).map(c => ({ type: 'team', value: c, label: c }));

    // 4. Spalten füllen (Mix aus Nation, Liga/Special und Club)
    // Spalte 1: Die Nation (falls gewählt) oder ein Club
    if (selectedNation) {
        colSelection.push({ type: 'nation', value: selectedNation, label: selectedNation });
    } else {
        colSelection.push({ type: 'team', value: shuffledClubs[3], label: shuffledClubs[3] });
    }

    // Spalte 2: Ein Extra (Liga oder Special)
    colSelection.push(shuffledExtras[0]);

    // Spalte 3: Ein weiterer Club (darf nicht in den Reihen sein!)
    colSelection.push({ type: 'team', value: shuffledClubs[4], label: shuffledClubs[4] });

    return { rows: rowSelection, cols: colSelection };
}

app.get('/api/daily-grid', (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    db.get("SELECT grid_data FROM daily_grids WHERE date = ?", [today], (err, row) => {
        if (row) return res.json(JSON.parse(row.grid_data));
        const newGrid = { ...generateDailyGridData(), date: today };
        db.run("INSERT INTO daily_grids (date, grid_data) VALUES (?, ?)", [today, JSON.stringify(newGrid)]);
        res.json(newGrid);
    });
});

// Verifizierung & Suche bleiben unangetastet (Callà-Fix etc. ist enthalten)
async function checkCriteria(tmId, cat) {
    return new Promise((resolve) => {
        let sql = ""; let params = [tmId];
        switch (cat.type) {
            case 'team': sql = "SELECT 1 FROM player_clubs WHERE tm_id = ? AND (club_name LIKE ? OR club_name LIKE ?) LIMIT 1"; params.push(`%${CLUB_MAP[cat.value]}%`); params.push(`%${cat.value}%`); break;
            case 'nation': sql = "SELECT 1 FROM player_nations WHERE tm_id = ? AND nation_code = ? LIMIT 1"; params.push(NATION_MAP[cat.value]); break;
            case 'league': sql = "SELECT 1 FROM player_leagues WHERE tm_id = ? AND (league_code LIKE ? OR league_code LIKE ?) LIMIT 1"; params.push(`%${LEAGUE_MAP[cat.value]}%`); params.push(`%${LEAGUE_MAP[cat.value].replace(' ', '')}%`); break;
            case 'goals_50': sql = "SELECT 1 FROM players WHERE tm_id = ? AND total_tore >= 50 LIMIT 1"; break;
            case 'goals_season_10': sql = "SELECT 1 FROM players WHERE tm_id = ? AND max_goals_season >= 10 LIMIT 1"; break;
            case 'champion': sql = "SELECT 1 FROM players WHERE tm_id = ? AND meistertitel > 0 LIMIT 1"; break;
            case 'cupwinner': sql = "SELECT 1 FROM players WHERE tm_id = ? AND is_cupwinner = 1 LIMIT 1"; break;
            default: return resolve(false);
        }
        db.get(sql, params, (err, row) => resolve(!!row));
    });
}

app.get('/api/search', (req, res) => {
    const q = req.query.q;
    db.all("SELECT name FROM players WHERE name LIKE ? ORDER BY total_einsaetze DESC LIMIT 15", [`%${q}%`], (err, rows) => {
        res.json(rows ? rows.map(r => ({ n: r.name.trim() })) : []);
    });
});

app.post('/api/verify', async (req, res) => {
    const { playerName, rowCat, colCat } = req.body;
    db.get("SELECT tm_id, total_einsaetze FROM players WHERE LOWER(name) = LOWER(?)", [playerName.trim()], async (err, player) => {
        if (!player) return res.json({ correct: false });
        const mRow = await checkCriteria(player.tm_id, rowCat);
        const mCol = await checkCriteria(player.tm_id, colCat);
        if (mRow && mCol) {
            let rarity = Math.max(0.5, (500 / (player.total_einsaetze + 1))).toFixed(1);
            res.json({ correct: true, rarity });
        } else res.json({ correct: false });
    });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.listen(PORT, '0.0.0.0', () => console.log(`Server läuft`));
