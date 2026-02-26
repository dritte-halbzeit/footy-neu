const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const app = express();
const db = new sqlite3.Database('./schweizer_fussball_grid.db');

const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(__dirname));

// Hilfsfunktion für die Kriterienprüfung
function checkCriteria(tmId, cat) {
    return new Promise((resolve) => {
        let sql = "";
        let params = [tmId];
        switch (cat.type) {
            case 'team':
                sql = "SELECT 1 FROM player_clubs WHERE tm_id = ? AND club_name = ?";
                params.push(cat.value);
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
            case 'league':
                sql = "SELECT 1 FROM player_leagues WHERE tm_id = ? AND league_code = ?";
                params.push(cat.value);
                break;
            default: resolve(false); return;
        }
        db.get(sql, params, (err, row) => resolve(!!row));
    });
}

// Hilfsfunktion für Rarity-Kandidaten
function getAllValidCandidates(cat1, cat2) {
    return new Promise((resolve) => {
        const getSql = (cat) => {
            switch (cat.type) {
                case 'team': return { s: "SELECT tm_id FROM player_clubs WHERE club_name = ?", p: [cat.value] };
                case 'nation': return { s: "SELECT tm_id FROM player_nations WHERE nation_code = ?", p: [cat.value] };
                case 'goals': return { s: "SELECT tm_id FROM players WHERE total_tore >= ?", p: [cat.value] };
                case 'champion': return { s: "SELECT tm_id FROM players WHERE meistertitel > 0", p: [] };
                case 'topscorer': return { s: "SELECT tm_id FROM players WHERE is_topscorer = 1", p: [] };
                case 'cupwinner': return { s: "SELECT tm_id FROM players WHERE is_cupwinner = 1", p: [] };
                case 'league': return { s: "SELECT tm_id FROM player_leagues WHERE league_code = ?", p: [cat.value] };
                default: return { s: "SELECT tm_id FROM players", p: [] };
            }
        };
        const p1 = getSql(cat1);
        const p2 = getSql(cat2);
        const sql = `SELECT tm_id, total_einsaetze FROM players WHERE tm_id IN (${p1.s}) AND tm_id IN (${p2.s})`;
        db.all(sql, [...p1.p, ...p2.p], (err, rows) => resolve(rows || []));
    });
}

// API: Suche
app.get('/api/search', (req, res) => {
    const q = req.query.q;
    if (!q || q.length < 2) return res.json([]);
    const sql = "SELECT name FROM players WHERE name LIKE ? ORDER BY total_einsaetze DESC LIMIT 15";
    db.all(sql, [`%${q}%`], (err, rows) => {
        if (err) res.json([]);
        else res.json(rows.map(r => ({ n: r.name }))); // "n" für Name
    });
});

// API: Verify
app.post('/api/verify', async (req, res) => {
    const { playerName, rowCat, colCat, cellId } = req.body;
    db.get("SELECT * FROM players WHERE name = ?", [playerName], async (err, player) => {
        if (!player) return res.json({ correct: false });
        const mRow = await checkCriteria(player.tm_id, rowCat);
        const mCol = await checkCriteria(player.tm_id, colCat);
        if (mRow && mCol) {
            const candidates = await getAllValidCandidates(rowCat, colCat);
            candidates.sort((a, b) => b.total_einsaetze - a.total_einsaetze);
            const playerRank = candidates.findIndex(c => c.tm_id === player.tm_id);
            const relativePos = candidates.length > 1 ? playerRank / (candidates.length - 1) : 1;
            let score = 0.5 + (relativePos * 8.5);
            if (player.tm_id < 50000) score += 1.0;
            res.json({ correct: true, rarity: Math.min(10, score).toFixed(1) });
        } else res.json({ correct: false });
    });
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server läuft auf Port ${PORT}`));