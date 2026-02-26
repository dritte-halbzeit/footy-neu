const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

const dbPath = path.resolve(__dirname, 'schweizer_fussball_grid.db');
const db = new sqlite3.Database(dbPath);

// Statische Ordner (Wichtig für die Logos!)
app.use(express.json());
app.use(express.static(__dirname));
app.use('/logos', express.static(path.join(__dirname, 'logos')));

// Hilfsfunktion: Prüft Kriterien (mit Namens-Toleranz für Clubs)
function checkCriteria(tmId, cat) {
    return new Promise((resolve) => {
        let sql = "";
        let params = [tmId];
        switch (cat.type) {
            case 'team':
                sql = "SELECT 1 FROM player_clubs WHERE tm_id = ? AND club_name LIKE ?";
                params.push('%' + cat.value + '%');
                break;
            case 'nation':
                sql = "SELECT 1 FROM player_nations WHERE tm_id = ? AND nation_code = ?";
                params.push(cat.value);
                break;
            case 'goals':
                sql = "SELECT 1 FROM players WHERE tm_id = ? AND total_tore >= ?";
                params.push(cat.value);
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

// Hilfsfunktion für Rarity-Berechnung
function getPool(cat1, cat2) {
    const getSql = (cat) => {
        if (cat.type === 'team') return { s: "SELECT tm_id FROM player_clubs WHERE club_name LIKE ?", p: ['%' + cat.value + '%'] };
        if (cat.type === 'nation') return { s: "SELECT tm_id FROM player_nations WHERE nation_code = ?", p: [cat.value] };
        if (cat.type === 'goals') return { s: "SELECT tm_id FROM players WHERE total_tore >= ?", p: [cat.value] };
        if (cat.type === 'champion') return { s: "SELECT tm_id FROM players WHERE meistertitel > 0", p: [] };
        if (cat.type === 'topscorer') return { s: "SELECT tm_id FROM players WHERE is_topscorer = 1", p: [] };
        if (cat.type === 'cupwinner') return { s: "SELECT tm_id FROM players WHERE is_cupwinner = 1", p: [] };
        return { s: "SELECT tm_id FROM players", p: [] };
    };
    const p1 = getSql(cat1); const p2 = getSql(cat2);
    const sql = `SELECT tm_id, total_einsaetze FROM players WHERE tm_id IN (${p1.s}) AND tm_id IN (${p2.s})`;
    return new Promise(resolve => db.all(sql, [...p1.p, ...p2.p], (err, rows) => resolve(rows || [])));
}

// API Suche
app.get('/api/search', (req, res) => {
    const q = req.query.q;
    const sql = "SELECT name FROM players WHERE name LIKE ? ORDER BY total_einsaetze DESC LIMIT 15";
    db.all(sql, [`%${q}%`], (err, rows) => {
        res.json(rows ? rows.map(r => ({ n: r.name })) : []);
    });
});

// API Validierung
app.post('/api/verify', async (req, res) => {
    const { playerName, rowCat, colCat, cellId } = req.body;
    db.get("SELECT * FROM players WHERE name = ?", [playerName], async (err, player) => {
        if (!player) return res.json({ correct: false });
        
        const mRow = await checkCriteria(player.tm_id, rowCat);
        const mCol = await checkCriteria(player.tm_id, colCat);

        if (mRow && mCol) {
            const pool = await getPool(rowCat, colCat);
            pool.sort((a, b) => b.total_einsaetze - a.total_einsaetze);
            const rank = pool.findIndex(c => c.tm_id === player.tm_id);
            const relPos = pool.length > 1 ? rank / (pool.length - 1) : 1;
            let score = 0.5 + (relPos * 8.5);
            if (player.tm_id < 50000) score += 1.0; 
            res.json({ correct: true, rarity: Math.min(10, score).toFixed(1) });
        } else {
            res.json({ correct: false });
        }
    });
});

app.get(/.*/, (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server läuft auf Port ${PORT}`));