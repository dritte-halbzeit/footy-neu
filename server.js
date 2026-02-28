const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const moment = require('moment'); // WICHTIG: npm install moment

const app = express();
const PORT = process.env.PORT || 10000;

const dbPath = path.resolve(__dirname, 'schweizer_fussball_grid.db');
const db = new sqlite3.Database(dbPath);

app.use(express.json());
app.use(express.static(__dirname));
app.use('/logos', express.static(path.join(__dirname, 'logos')));

// Tabellen initialisieren
db.serialize(() => {
    db.run("CREATE TABLE IF NOT EXISTS daily_grids (date TEXT PRIMARY KEY, grid_data TEXT)");
});

// Konfiguration der Pools für den Generator
const CLUB_POOL = ["Basel", "Young Boys", "Zürich", "St. Gallen", "Luzern", "Servette", "Sion", "Grasshopper", "Lugano", "Winterthur", "Lausanne", "Aarau", "Thun"];
const NATION_POOL = ["SUI", "FRA", "GER", "ITA", "BRA", "SRB", "KOS", "AUT", "ESP"];
const LEAGUE_POOL = [
    { value: 'England', label: 'Premier League' },
    { value: 'Germany', label: 'Bundesliga' },
    { value: 'Italy', label: 'Serie A' },
    { value: 'France', label: 'Ligue 1' },
    { value: 'Spain', label: 'La Liga' }
];

async function checkCriteria(tmId, cat) {
    return new Promise((resolve) => {
        let sql = "";
        let params = [tmId];

        switch (cat.type) {
            case 'team':
                sql = "SELECT 1 FROM player_clubs WHERE tm_id = ? AND club_name LIKE ?";
                params.push('%' + cat.value + '%');
                break;
            case 'nation':
                sql = "SELECT 1 FROM player_nations WHERE tm_id = ? AND (nation_code = ? OR nation_code LIKE ?)";
                params.push(cat.value, '%' + cat.value + '%');
                break;
            case 'league':
                sql = "SELECT 1 FROM player_leagues WHERE tm_id = ? AND league_name LIKE ?";
                params.push('%' + cat.value + '%');
                break;
            case 'goals_50':
                sql = "SELECT 1 FROM players WHERE tm_id = ? AND total_tore >= 50";
                break;
            case 'assists_10':
                sql = "SELECT 1 FROM players WHERE tm_id = ? AND total_assists >= 10";
                break;
            case 'assists_50':
                sql = "SELECT 1 FROM players WHERE tm_id = ? AND total_assists >= 50";
                break;
            case 'champion':
                sql = "SELECT 1 FROM players WHERE tm_id = ? AND meistertitel > 0";
                break;
            case 'cupwinner':
                sql = "SELECT 1 FROM players WHERE tm_id = ? AND is_cupwinner = 1";
                break;
            default: return resolve(false);
        }
        db.get(sql, params, (err, row) => resolve(!!row));
    });
}

app.get('/api/daily-grid', (req, res) => {
    const today = moment().format('YYYY-MM-DD');
    db.get("SELECT grid_data FROM daily_grids WHERE date = ?", [today], (err, row) => {
        if (row) {
            return res.json(JSON.parse(row.grid_data));
        } else {
            // Neues Grid generieren
            const rows = CLUB_POOL.sort(() => 0.5 - Math.random()).slice(0, 3).map(c => ({type:'team', value:c, label:c}));
            
            // Mix für Spalten: 1 Club, 1 Nation, 1 Special
            const col1 = {type:'team', value: CLUB_POOL.sort(() => 0.5 - Math.random())[4], label: CLUB_POOL[4]};
            const col2 = {type:'nation', value: 'SUI', label: 'Schweiz'};
            const col3 = {type:'league', value: 'Germany', label: 'Bundesliga'}; // Beispielhaft
            
            const newGrid = { rows, cols: [col1, col2, col3] };
            db.run("INSERT INTO daily_grids (date, grid_data) VALUES (?, ?)", [today, JSON.stringify(newGrid)]);
            res.json(newGrid);
        }
    });
});

app.get('/api/search', (req, res) => {
    const q = req.query.q;
    db.all("SELECT name FROM players WHERE name LIKE ? ORDER BY total_einsaetze DESC LIMIT 15", [`%${q}%`], (err, rows) => {
        res.json(rows ? rows.map(r => ({ n: r.name.trim() })) : []);
    });
});

app.post('/api/verify', async (req, res) => {
    const { playerName, rowCat, colCat } = req.body;
    db.get("SELECT tm_id, total_einsaetze FROM players WHERE name = ?", [playerName.trim()], async (err, player) => {
        if (!player) return res.json({ correct: false });
        const mRow = await checkCriteria(player.tm_id, rowCat);
        const mCol = await checkCriteria(player.tm_id, colCat);
        if (mRow && mCol) {
            let rarity = Math.max(0.5, (500 / (player.total_einsaetze + 1))).toFixed(1);
            res.json({ correct: true, rarity });
        } else {
            res.json({ correct: false });
        }
    });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.listen(PORT, '0.0.0.0', () => console.log(`Server läuft auf Port ${PORT}`));