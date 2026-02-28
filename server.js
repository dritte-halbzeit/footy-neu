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

db.serialize(() => {
    db.run("CREATE TABLE IF NOT EXISTS daily_grids (date TEXT PRIMARY KEY, grid_data TEXT)");
});

const CLUB_POOL = ["Basel", "Young Boys", "Zürich", "St. Gallen", "Luzern", "Servette", "Sion", "Grasshopper", "Lugano", "Winterthur", "Lausanne", "Aarau", "Thun"];

async function checkCriteria(tmId, cat) {
    return new Promise((resolve) => {
        let sql = "";
        let params = [tmId];
        switch (cat.type) {
            case 'team':
                // Sucht flexibler nach dem Clubnamen
                sql = "SELECT 1 FROM player_clubs WHERE tm_id = ? AND LOWER(club_name) LIKE LOWER(?)";
                params.push('%' + cat.value + '%');
                break;
            case 'nation':
                // Sucht nach SUI, Schweiz oder Switzerland
                if (cat.value === 'SUI') {
                    sql = "SELECT 1 FROM player_nations WHERE tm_id = ? AND (nation_code IN ('SUI', 'CH') OR nation_name LIKE '%Schweiz%' OR nation_name LIKE '%Switzerland%')";
                } else {
                    sql = "SELECT 1 FROM player_nations WHERE tm_id = ? AND (nation_code = ? OR nation_name LIKE ?)";
                    params.push(cat.value, '%' + cat.value + '%');
                }
                break;
            case 'league':
                sql = "SELECT 1 FROM player_leagues WHERE tm_id = ? AND LOWER(league_name) LIKE LOWER(?)";
                params.push('%' + cat.value + '%');
                break;
            case 'goals_50':
                sql = "SELECT 1 FROM players WHERE tm_id = ? AND total_tore >= 50";
                break;
            case 'assists_10':
                sql = "SELECT 1 FROM players WHERE tm_id = ? AND total_assists >= 10";
                break;
            case 'champion':
                sql = "SELECT 1 FROM players WHERE tm_id = ? AND meistertitel > 0";
                break;
            default: return resolve(false);
        }
        db.get(sql, params, (err, row) => resolve(!!row));
    });
}

app.get('/api/daily-grid', (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    db.get("SELECT grid_data FROM daily_grids WHERE date = ?", [today], (err, row) => {
        if (row) return res.json(JSON.parse(row.grid_data));
        
        const shuffled = [...CLUB_POOL].sort(() => 0.5 - Math.random());
        const newGrid = { 
            rows: shuffled.slice(0, 3).map(c => ({type:'team', value:c, label:c})),
            cols: [
                {type:'team', value: shuffled[3], label: shuffled[3]},
                {type:'nation', value: 'SUI', label: 'Schweiz'},
                {type:'league', value: 'Germany', label: 'Bundesliga'}
            ],
            date: today // Datum mitsenden
        };
        db.run("INSERT INTO daily_grids (date, grid_data) VALUES (?, ?)", [today, JSON.stringify(newGrid)]);
        res.json(newGrid);
    });
});

app.get('/api/search', (req, res) => {
    const q = req.query.q;
    // Sucht jetzt auch Namen ohne Akzente (Calla vs Callà) falls die DB das unterstützt
    db.all("SELECT name FROM players WHERE name LIKE ? OR name LIKE ? ORDER BY total_einsaetze DESC LIMIT 15", [`%${q}%`, `%${q.replace(/à/g, 'a')}%`], (err, rows) => {
        res.json(rows ? rows.map(r => ({ n: r.name.trim() })) : []);
    });
});

app.post('/api/verify', async (req, res) => {
    const { playerName, rowCat, colCat } = req.body;
    // Wir suchen den Spieler, trimmen aber Leerzeichen
    db.get("SELECT tm_id, total_einsaetze FROM players WHERE LOWER(name) = LOWER(?)", [playerName.trim()], async (err, player) => {
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
app.listen(PORT, '0.0.0.0', () => console.log(`Server läuft`));