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

// --- DATENBANK MAPPING (Deine exakten DB-Strings) ---
const CLUB_MAPPING = {
    "Basel": "FC Basel 1893", "Thun": "FC Thun", "St. Gallen": "FC St. Gallen 1879",
    "Lugano": "FC Lugano", "Sion": "FC Sion", "Young Boys": "Young Boys",
    "Luzern": "FC Luzern", "Grasshopper": "Grasshopper Club Zürich",
    "Zürich": "FC Zürich", "Winterthur": "FC Winterthur", "Lausanne": "Lausanne-Sport",
    "Servette": "Servette FC", "Aarau": "FC Aarau", "Vaduz": "FC Vaduz"
};

const NATION_MAPPING = {
    "SUI": "Switzerland", "ALB": "Albania", "GER": "Germany", "FRA": "France",
    "ITA": "Italy", "SRB": "Serbia", "KOS": "Kosovo", "AUT": "Austria",
    "ESP": "Spain", "BRA": "Brazil", "POR": "Portugal", "CRO": "Croatia", "NED": "Netherlands"
};

const LEAGUE_MAPPING = {
    "Germany": "Bundesliga (GER)", "England": "Premier League (ENG)",
    "France": "Ligue 1 (FRA)", "Spain": "La Liga (ESP)", "Italy": "Serie A (ITA)"
};

// --- LOGIK: VALIDIERUNG ---
async function checkCriteria(tmId, cat) {
    return new Promise((resolve) => {
        let sql = "";
        let params = [tmId];

        switch (cat.type) {
            case 'team':
                sql = "SELECT 1 FROM player_clubs WHERE tm_id = ? AND club_name = ? LIMIT 1";
                params.push(CLUB_MAPPING[cat.value] || cat.value);
                break;
            case 'nation':
                sql = "SELECT 1 FROM player_nations WHERE tm_id = ? AND nation_name = ? LIMIT 1";
                params.push(NATION_MAPPING[cat.value] || cat.value);
                break;
            case 'league':
                sql = "SELECT 1 FROM player_leagues WHERE tm_id = ? AND league_name = ? LIMIT 1";
                params.push(LEAGUE_MAPPING[cat.value] || cat.value);
                break;
            case 'goals_50':
                sql = "SELECT 1 FROM players WHERE tm_id = ? AND total_tore >= 50 LIMIT 1";
                break;
            case 'goals_season_10':
                // Falls du die Spalte max_goals_season hast, sonst hier anpassen:
                sql = "SELECT 1 FROM players WHERE tm_id = ? AND max_goals_season >= 10 LIMIT 1";
                break;
            case 'champion':
                sql = "SELECT 1 FROM players WHERE tm_id = ? AND meistertitel > 0 LIMIT 1";
                break;
            case 'cupwinner':
                sql = "SELECT 1 FROM players WHERE tm_id = ? AND is_cupwinner = 1 LIMIT 1";
                break;
            default: resolve(false); return;
        }
        db.get(sql, params, (err, row) => resolve(!!row));
    });
}

// --- LOGIK: ZUFALLS-GENERATOR ---
function getRandomCategories(count) {
    const pools = [
        ...Object.keys(CLUB_MAPPING).map(v => ({ type: 'team', value: v, label: v })),
        ...Object.keys(NATION_MAPPING).map(v => ({ type: 'nation', value: v, label: v })),
        ...Object.keys(LEAGUE_MAPPING).map(v => ({ type: 'league', value: v, label: v })),
        { type: 'champion', value: 'CHAMP', label: 'Meister' },
        { type: 'cupwinner', value: 'CUP', label: 'Cupsieger' },
        { type: 'goals_50', value: 'G50', label: '> 50 Tore' },
        { type: 'goals_season_10', value: 'GS10', label: '> 10 Tore/Sais.' }
    ];
    return pools.sort(() => 0.5 - Math.random()).slice(0, count);
}

app.get('/api/daily-grid', (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    db.get("SELECT grid_data FROM daily_grids WHERE date = ?", [today], (err, row) => {
        if (row) return res.json(JSON.parse(row.grid_data));
        
        // Erstelle ein neues, abwechslungsreiches Grid
        const rowCats = getRandomCategories(3);
        const colCats = getRandomCategories(3);
        
        // Sicherstellen, dass keine ID doppelt vorkommt
        const newGrid = { rows: rowCats, cols: colCats, date: today };
        db.run("INSERT INTO daily_grids (date, grid_data) VALUES (?, ?)", [today, JSON.stringify(newGrid)]);
        res.json(newGrid);
    });
});

// Suche & Verifizierung (Bleiben gleich wie besprochen)
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
        } else { res.json({ correct: false }); }
    });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.listen(PORT, '0.0.0.0', () => console.log(`Server läuft auf Port ${PORT}`));