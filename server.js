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
    const { playerName, rowCat, colCat, cellId } = req.body;
    const today = new Date().toISOString().split('T')[0];

    db.get("SELECT * FROM players WHERE name = ?", [playerName], async (err, player) => {
        if (!player) return res.json({ correct: false });

        const matchRow = await checkCriteria(player.tm_id, rowCat);
        const matchCol = await checkCriteria(player.tm_id, colCat);

        if (matchRow && matchCol) {
            // --- 1. HINTERGRUND LOGGING (wie gewünscht) ---
            db.run(`INSERT INTO user_guesses (grid_date, cell_id, player_name, count) 
                    VALUES (?, ?, ?, 1) 
                    ON CONFLICT(grid_date, cell_id, player_name) 
                    DO UPDATE SET count = count + 1`, 
                    [today, cellId, playerName]);

            // --- 2. RELATIVE RARITY (Pool-Ranking) ---
            // Wir holen alle validen Kandidaten für dieses Feld
            const candidates = await getAllValidCandidates(rowCat, colCat);
            
            // Wir sortieren die Kandidaten nach Einsätzen (Viel -> Wenig)
            // Wer viele Einsätze hat, steht oben (Rang 0)
            candidates.sort((a, b) => b.total_einsaetze - a.total_einsaetze);
            
            const totalInPool = candidates.length;
            const playerRank = candidates.findIndex(c => c.tm_id === player.tm_id);
            
            // Prozentuale Position im Feld (0 = bekanntester, 1 = unbekanntester)
            const relativePosition = totalInPool > 1 ? playerRank / (totalInPool - 1) : 1;
            
            // Basis-Score: 0.5 (bekannt) bis 9.0 (selten)
            let score = 0.5 + (relativePosition * 8.5);

            // --- 3. HISTORIE-BONUS ---
            // tm_id unter 50.000 sind meist Spieler, die vor 2010/2012 aktiv waren
            if (player.tm_id < 50000) {
                score += 1.0; 
            }
            
            // Deckelung auf maximal 10.0
            score = Math.min(10.0, Math.round(score * 10) / 10);

            res.json({ 
                correct: true, 
                rarity: score.toFixed(1),
                debug: { poolSize: totalInPool, rank: playerRank } 
            });
        } else {
            res.json({ correct: false });
        }
    });
});

// Hilfsfunktion: Holt alle Spieler-Objekte, die in ein Feld passen
function getAllValidCandidates(cat1, cat2) {
    return new Promise((resolve) => {
        const part1 = getSubQuery(cat1);
        const part2 = getSubQuery(cat2);

        const sql = `
            SELECT tm_id, total_einsaetze FROM players 
            WHERE tm_id IN (${part1.sql}) 
            AND tm_id IN (${part2.sql})
        `;
        const params = [...part1.params, ...part2.params];

        db.all(sql, params, (err, rows) => {
            resolve(rows || []);
        });
    });
}