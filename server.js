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

// --- NATION MAPPING (Sicherheits-Netz) ---
const NATION_MAP = {
    "SUI": ["Schweiz", "Switzerland", "SUI", "Suisse", "Svizzera"],
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
            // Wir suchen nach allen Varianten aus der NATION_MAP
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

        db.get(sql, params, (err, row) => {
            if (err) console.error("Criteria Error:", err);
            resolve(!!row);
        });
    });
}

// Suche Endpunkt
app.get('/api/search', (req, res) => {
    const q = req.query.q;
    db.all("SELECT name FROM players WHERE name LIKE ? ORDER BY total_einsaetze DESC LIMIT 15", [`%${q}%`], (err, rows) => {
        res.json(rows ? rows.map(r => ({ n: r.name.trim() })) : []);
    });
});

// Validierung Endpunkt
app.post('/api/verify', async (req, res) => {
    const { playerName, rowCat, colCat } = req.body;
    
    db.get("SELECT * FROM players WHERE name = ?", [playerName.trim()], async (err, player) => {
        if (err || !player) {
            console.log(`Spieler nicht gefunden: ${playerName}`);
            return res.json({ correct: false });
        }

        const matchRow = await checkCriteria(player.tm_id, rowCat);
        const matchCol = await checkCriteria(player.tm_id, colCat);

        console.log(`Check ${playerName} (ID: ${player.tm_id}): Row=${matchRow}, Col=${matchCol}`);

        if (matchRow && matchCol) {
            let score = 5.0; 
            if (player.total_einsaetze < 30) score = 9.5;
            else if (player.total_einsaetze < 120) score = 7.0;
            else if (player.total_einsaetze > 350) score = 1.0;
            if (player.tm_id < 60000) score += 0.5; 
            res.json({ correct: true, rarity: Math.min(10, score).toFixed(1) });
        } else {
            res.json({ correct: false });
        }
    });
});

// Statische Dateien servieren
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Catch-all Route für das "Not Found" Problem
app.get('/:path*', (req, res) => {
    const filePath = path.join(__dirname, req.params.path);
    if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
    } else {
        res.sendFile(path.join(__dirname, 'index.html'));
    }
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server aktiv auf Port ${PORT}`));