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
// Sorgt dafür, dass der Ordner "logos" für den Browser erreichbar ist
app.use('/logos', express.static(path.join(__dirname, 'logos')));

// Die Varianten für die Schweiz in der Datenbank
const SWISS_VARIANTS = ["%SUI%", "%Schweiz%", "%Switzerland%", "%Suisse%"];

function checkCriteria(tmId, cat) {
    return new Promise((resolve) => {
        let sql = "";
        let params = [tmId];

        if (cat.type === 'team') {
            sql = "SELECT 1 FROM player_clubs WHERE tm_id = ? AND club_name LIKE ?";
            params.push('%' + cat.value + '%');
        } else if (cat.type === 'nation') {
            if (cat.value === 'SUI') {
                // Prüft alle Schweizer Namensvarianten
                sql = "SELECT 1 FROM player_nations WHERE tm_id = ? AND (nation_code LIKE ? OR nation_code LIKE ? OR nation_code LIKE ? OR nation_code LIKE ?)";
                params.push(...SWISS_VARIANTS);
            } else {
                sql = "SELECT 1 FROM player_nations WHERE tm_id = ? AND (nation_code = ? OR nation_code LIKE ?)";
                params.push(cat.value, '%' + cat.value + '%');
            }
        } else if (cat.type === 'goals') {
            sql = "SELECT 1 FROM players WHERE tm_id = ? AND total_tore >= ?";
            params.push(parseInt(cat.value));
        } else if (cat.type === 'champion') {
            sql = "SELECT 1 FROM players WHERE tm_id = ? AND meistertitel > 0";
        } else if (cat.type === 'topscorer') {
            sql = "SELECT 1 FROM players WHERE tm_id = ? AND is_topscorer = 1";
        } else if (cat.type === 'cupwinner') {
            sql = "SELECT 1 FROM players WHERE tm_id = ? AND is_cupwinner = 1";
        } else {
            return resolve(false);
        }

        db.get(sql, params, (err, row) => resolve(!!row));
    });
}

app.get('/api/search', (req, res) => {
    const q = req.query.q;
    const sql = "SELECT name FROM players WHERE name LIKE ? ORDER BY total_einsaetze DESC LIMIT 15";
    db.all(sql, [`%${q}%`], (err, rows) => {
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
            // Einfache, funktionierende Logik für die Punkte
            let rarity = 5.0;
            if (player.total_einsaetze < 50) rarity = 9.2;
            if (player.total_einsaetze > 250) rarity = 1.2;
            res.json({ correct: true, rarity: rarity.toFixed(1) });
        } else {
            res.json({ correct: false });
        }
    });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/:path*', (req, res) => {
    const p = path.join(__dirname, req.params.path);
    if (fs.existsSync(p)) res.sendFile(p);
    else res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => console.log(`Server läuft`));