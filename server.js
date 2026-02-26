const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const app = express();
const db = new sqlite3.Database('./schweizer_fussball_grid.db');

const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.static(__dirname));
app.use('/logos', express.static(path.join(__dirname, 'logos')));

// Hilfsfunktion: Prüft Kriterien gegen die DB
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
                // Prüft ob die Nation im Code (z.B. SUI) oder Namen (Schweiz) vorliegt
                sql = "SELECT 1 FROM player_nations WHERE tm_id = ? AND (nation_code = ? OR nation_code LIKE ?)";
                params.push(val, '%' + val + '%');
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

// Hilfsfunktion: Berechnet wie viele Spieler in das Feld passen
function getPoolSize(cat1, cat2) {
    const getSub = (cat) => {
        if (cat.type === 'team') return { s: "SELECT tm_id FROM player_clubs WHERE club_name LIKE ?", p: ['%' + cat.value + '%'] };
        if (cat.type === 'nation') return { s: "SELECT tm_id FROM player_nations WHERE nation_code LIKE ?", p: ['%' + cat.value + '%'] };
        if (cat.type === 'goals') return { s: "SELECT tm_id FROM players WHERE total_tore >= ?", p: [cat.value] };
        if (cat.type === 'champion') return { s: "SELECT tm_id FROM players WHERE meistertitel > 0", p: [] };
        if (cat.type === 'topscorer') return { s: "SELECT tm_id FROM players WHERE is_topscorer = 1", p: [] };
        if (cat.type === 'cupwinner') return { s: "SELECT tm_id FROM players WHERE is_cupwinner = 1", p: [] };
        return { s: "SELECT tm_id FROM players", p: [] };
    };
    const p1 = getSub(cat1); const p2 = getSub(cat2);
    const sql = `SELECT COUNT(DISTINCT tm_id) as count FROM players WHERE tm_id IN (${p1.s}) AND tm_id IN (${p2.s})`;
    return new Promise(resolve => db.get(sql, [...p1.p, ...p2.p], (err, row) => resolve(row ? row.count : 0)));
}

app.get('/api/search', (req, res) => {
    const q = req.query.q;
    db.all("SELECT name FROM players WHERE name LIKE ? ORDER BY total_einsaetze DESC LIMIT 15", [`%${q}%`], (err, rows) => {
        res.json(rows ? rows.map(r => ({ n: r.name })) : []);
    });
});

app.post('/api/verify', async (req, res) => {
    const { playerName, rowCat, colCat } = req.body;
    db.get("SELECT * FROM players WHERE name = ?", [playerName], async (err, player) => {
        if (!player) return res.json({ correct: false });
        const mRow = await checkCriteria(player.tm_id, rowCat);
        const mCol = await checkCriteria(player.tm_id, colCat);
        if (mRow && mCol) {
            const poolSize = await getPoolSize(rowCat, colCat);
            // Je kleiner der Pool, desto seltener der Spieler im Vergleich
            // Wir berechnen die Rarity basierend auf den Einsätzen des Spielers im Verhältnis zum Pool
            let score = 5.0; 
            if (player.total_einsaetze < 20) score = 9.5;
            else if (player.total_einsaetze < 100) score = 7.0;
            else if (player.total_einsaetze > 300) score = 1.5;
            if (player.tm_id < 50000) score += 0.5; // Legenden-Bonus
            res.json({ correct: true, rarity: Math.min(10, score).toFixed(1) });
        } else res.json({ correct: false });
    });
});

app.get(/.*/, (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server aktiv`));