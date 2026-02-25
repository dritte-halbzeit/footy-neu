const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const port = 3000;
const db = new sqlite3.Database('./schweizer_fussball_grid.db');

app.use(express.json());
app.use(express.static(__dirname)); // Liefert deine HTML-Datei aus

// --- HILFSFUNKTION: Prüft Kategorien gegen die DB ---
function checkPlayerMatches(playerID, cat) {
    return new Promise((resolve) => {
        let query = "";
        let params = [playerID];

        switch (cat.type) {
            case 'team':
                query = "SELECT 1 FROM player_clubs WHERE tm_id = ? AND club_name = ?";
                params.push(cat.value);
                break;
            case 'nation':
                query = "SELECT 1 FROM player_nations WHERE tm_id = ? AND nation_code = ?";
                params.push(cat.value);
                break;
            case 'goals':
                query = "SELECT 1 FROM players WHERE tm_id = ? AND total_tore > ?";
                params.push(cat.value);
                break;
            case 'champion':
                query = "SELECT 1 FROM players WHERE tm_id = ? AND meistertitel > 0";
                break;
            case 'topscorer':
                query = "SELECT 1 FROM players WHERE tm_id = ? AND is_topscorer = 1";
                break;
            case 'cupwinner':
                query = "SELECT 1 FROM players WHERE tm_id = ? AND is_cupwinner = 1";
                break;
            case 'league':
                query = "SELECT 1 FROM player_leagues WHERE tm_id = ? AND league_code = ?";
                params.push(cat.value);
                break;
            default:
                return resolve(false);
        }

        db.get(query, params, (err, row) => {
            resolve(!!row);
        });
    });
}

// --- API 1: Suche ---
app.get('/api/search', (req, res) => {
    const q = req.query.q;
    if (!q || q.length < 2) return res.json([]);
    
    const sql = "SELECT name FROM players WHERE name LIKE ? ORDER BY total_einsaetze DESC LIMIT 15";
    db.all(sql, [`%${q}%`], (err, rows) => {
        res.json(rows.map(r => ({ n: r.name })));
    });
});

// --- API 2: Validierung & Rarity ---
app.post('/api/verify', async (req, res) => {
    const { playerName, rowCat, colCat } = req.body;

    // 1. Spieler-ID und Stats holen
    db.get("SELECT tm_id, total_einsaetze FROM players WHERE name = ?", [playerName], async (err, player) => {
        if (!player) return res.json({ correct: false });

        // 2. Prüfen, ob er beide Kriterien erfüllt
        const matchRow = await checkPlayerMatches(player.tm_id, rowCat);
        const matchCol = await checkPlayerMatches(player.tm_id, colCat);

        if (matchRow && matchCol) {
            // 3. Rarity berechnen
            // Wir schauen, wie viele Spieler diese Kombi erfüllen
            // (Vereinfacht: Je mehr Einsätze der gewählte Spieler hat, desto weniger Punkte)
            // Hier nutzen wir eine Skala von 0.5 bis 10
            let rarity = 10.0;
            if (player.total_einsaetze > 300) rarity = 1.0;
            else if (player.total_einsaetze > 150) rarity = 3.0;
            else if (player.total_einsaetze > 50) rarity = 6.0;

            res.json({ correct: true, rarity: rarity });
        } else {
            res.json({ correct: false });
        }
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server läuft auf Port ${PORT}`);
});