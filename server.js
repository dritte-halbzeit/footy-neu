const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 10000;

// Datenbankverbindung
const dbPath = path.resolve(__dirname, 'schweizer_fussball_grid.db');
const db = new sqlite3.Database(dbPath);

app.use(express.json());
app.use(express.static(__dirname));
app.use('/logos', express.static(path.join(__dirname, 'logos')));

// Mapping für Nationalitäten (Frontend SUI -> DB Schweiz)
const NATION_MAP = {
    "SUI": ["Schweiz", "Switzerland", "SUI", "Suisse"],
    "FRA": ["Frankreich", "France", "FRA"],
    "GER": ["Deutschland", "Germany", "GER"],
    "ITA": ["Italien", "Italy", "ITA"],
    "BRA": ["Brasilien", "Brazil", "BRA"],
    "ESP": ["Spanien", "Spain", "ESP"],
    "POR": ["Portugal", "POR"],
    "SRB": ["Serbien", "Serbia", "SRB"],
    "CRO": ["Kroatien", "Croatia", "CRO"],
    "AUT": ["Österreich", "Austria", "AUT"]
};

// Hilfsfunktion: Kriterien gegen DB prüfen
function checkCriteria(tmId, cat) {
    return new Promise((resolve) => {
        let sql = "";
        let params = [tmId];

        if (cat.type === 'team') {
            sql = "SELECT 1 FROM player_clubs WHERE tm_id = ? AND club_name LIKE ?";
            params.push('%' + cat.value + '%');
        } else if (cat.type === 'nation') {
            const variants = NATION_MAP[cat.value] || [cat.value];
            const placeholders = variants.map(() => "nation_code LIKE ?").join(" OR ");
            sql = `SELECT 1 FROM player_nations WHERE tm_id = ? AND (${placeholders})`;
            variants.forEach(v => params.push('%' + v + '%'));
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

// API: Suche
app.get('/api/search', (req, res) => {
    const q = req.query.q;
    db.all("SELECT name FROM players WHERE name LIKE ? ORDER BY total_einsaetze DESC LIMIT 15", [`%${q}%`], (err, rows) => {
        res.json(rows ? rows.map(r => ({ n: r.name.trim() })) : []);
    });
});

// API: Validierung
app.post('/api/verify', async (req, res) => {
    const { playerName, rowCat, colCat } = req.body;
    db.get("SELECT tm_id, total_einsaetze FROM players WHERE name = ?", [playerName], async (err, player) => {
        if (!player) return res.json({ correct: false });
        const mRow = await checkCriteria(player.tm_id, rowCat);
        const mCol = await checkCriteria(player.tm_id, colCat);
        if (mRow && mCol) {
            let rarity = 5.0;
            if (player.total_einsaetze < 50) rarity = 9.2;
            if (player.total_einsaetze > 250) rarity = 1.2;
            res.json({ correct: true, rarity: rarity.toFixed(1) });
        } else {
            res.json({ correct: false });
        }
    });
});

// Hauptseite ausliefern
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/:path*', (req, res) => {
    const p = path.join(__dirname, req.params.path);
    if (fs.existsSync(p)) res.sendFile(p);
    else res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server läuft`));