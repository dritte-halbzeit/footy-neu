const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const app = express();
// Render nutzt process.env.PORT
const PORT = process.env.PORT || 10000;

// Datenbankverbindung
const dbPath = path.resolve(__dirname, 'schweizer_fussball_grid.db');
const db = new sqlite3.Database(dbPath);

// Middleware
app.use(express.json());
app.use(express.static(__dirname));
app.use('/logos', express.static(path.join(__dirname, 'logos')));

// --- NATION MAPPING ---
const NATION_MAP = {
    "SUI": "Schweiz", "FRA": "Frankreich", "GER": "Deutschland", "ITA": "Italien", 
    "BRA": "Brasilien", "ESP": "Spanien", "POR": "Portugal", "SRB": "Serbien", 
    "CRO": "Kroatien", "AUT": "Österreich", "ALB": "Albanien", "KVX": "Kosovo",
    "NED": "Niederlande", "ENG": "England", "BEL": "Belgien", "ARG": "Argentinien"
};

// --- HILFSFUNKTIONEN ---
async function checkCriteria(tmId, cat) {
    return new Promise((resolve) => {
        let sql = "";
        let params = [tmId];
        let val = cat.value;

        switch (cat.type) {
            case 'team':
                sql = "SELECT 1 FROM player_clubs WHERE tm_id = ? AND club_name LIKE ?";
                params.push('%' + val + '%');
                break;
            case 'nation':
                const fullName = NATION_MAP[val] || val;
                sql = "SELECT 1 FROM player_nations WHERE tm_id = ? AND (nation_code = ? OR nation_code = ? OR nation_code LIKE ?)";
                params.push(val, fullName, '%' + fullName + '%');
                break;
            case 'goals':
                sql = "SELECT 1 FROM players WHERE tm_id = ? AND total_tore >= ?";
                params.push(parseInt(val));
                break;
            case 'champion':
                sql = "SELECT 1 FROM players WHERE tm_id = ? AND meistertitel > 0";
                break;
            case 'topscorer':
                sql = "SELECT 1 FROM players WHERE tm_id = ? AND is_topscorer = 1";
                break;
            case 'cupwinner':
                sql = "SELECT 1 FROM players WHERE tm_id = ? AND is_cupwinner = 1";
                break;
            default: resolve(false); return;
        }
        db.get(sql, params, (err, row) => resolve(!!row));
    });
}

// --- API ENDPUNKTE ---

// Suche
app.get('/api/search', (req, res) => {
    const q = req.query.q;
    db.all("SELECT name FROM players WHERE name LIKE ? ORDER BY total_einsaetze DESC LIMIT 15", [`%${q}%`], (err, rows) => {
        res.json(rows ? rows.map(r => ({ n: r.name })) : []);
    });
});

// Validierung
app.post('/api/verify', async (req, res) => {
    const { playerName, rowCat, colCat, cellId } = req.body;
    db.get("SELECT * FROM players WHERE name = ?", [playerName], async (err, player) => {
        if (!player) return res.json({ correct: false });
        const mRow = await checkCriteria(player.tm_id, rowCat);
        const mCol = await checkCriteria(player.tm_id, colCat);
        if (mRow && mCol) {
            let score = 5.0; 
            if (player.total_einsaetze < 30) score = 9.5;
            else if (player.total_einsaetze < 120) score = 7.0;
            else if (player.total_einsaetze > 350) score = 1.0;
            if (player.tm_id < 60000) score += 0.5; 
            res.json({ correct: true, rarity: Math.min(10, score).toFixed(1) });
        } else res.json({ correct: false });
    });
});

// --- ROUTING FIX (Die Lösung für "Not Found") ---
// Wir definieren die Hauptseite explizit
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Catch-all für alles andere (muss am Ende stehen!)
app.get('/:path*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server läuft auf Port ${PORT}`);
});