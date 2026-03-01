const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 10000;

const dbPath = path.resolve(__dirname, 'schweizer_fussball_grid.db');
const db = new sqlite3.Database(dbPath);

// Tabellen für neue Kategorien sicherstellen
db.run(`CREATE TABLE IF NOT EXISTS player_club_assists (tm_id INTEGER, club_name TEXT, assists INTEGER, PRIMARY KEY(tm_id, club_name))`);
db.run(`CREATE TABLE IF NOT EXISTS player_season_goals (tm_id INTEGER, season_name TEXT, goals INTEGER, PRIMARY KEY(tm_id, season_name))`);

app.use(express.json());
app.use(express.static(__dirname));
app.use('/logos', express.static(path.join(__dirname, 'logos')));

// --- FIXIERTES MAPPING (Wird nicht mehr geändert) ---
const CLUB_MAP = {
    "Basel": "FC Basel 1893", "Thun": "FC Thun", "St. Gallen": "FC St. Gallen 1879",
    "Lugano": "FC Lugano", "Sion": "FC Sion", "Young Boys": "Young Boys",
    "Luzern": "FC Luzern", "Grasshopper": "Grasshopper Club Zürich",
    "Zürich": "FC Zürich", "Winterthur": "FC Winterthur", "Lausanne": "Lausanne-Sport",
    "Servette": "Servette FC", "Aarau": "FC Aarau", "Vaduz": "FC Vaduz"
};

const NATION_MAP = {
    "SUI": "Switzerland", "ALB": "Albania", "GER": "Germany", "FRA": "France",
    "ITA": "Italy", "SRB": "Serbia", "KOS": "Kosovo", "AUT": "Austria", "ESP": "Spain", "BRA": "Brazil",
    "ARG": "Argentina", "JPN": "Japan", "CMR": "Cameroon", "CIV": "Cote d'Ivoire", "POR": "Portugal", "TUR": "Türkiye"
};

const LEAGUE_MAP = {
    "Germany": "Bundesliga", "England": "Premier League",
    "France": "Ligue 1", "Spain": "La Liga", "Italy": "Serie A"
};

// --- GRID GENERATOR (Regeln: keine Clubs 2 Tage hintereinander, Balance, 1–2 andere Kategorien) ---

function extractClubsFromGrid(gridData) {
    const clubs = new Set();
    const items = [...(gridData.rows || []), ...(gridData.cols || [])];
    items.forEach(item => { if (item && item.type === 'team') clubs.add(item.value); });
    return Array.from(clubs);
}

function getClubUsageCounts(last30Grids) {
    const counts = {};
    Object.keys(CLUB_MAP).forEach(c => counts[c] = 0);
    last30Grids.forEach(g => {
        const data = typeof g === 'string' ? JSON.parse(g) : g;
        extractClubsFromGrid(data).forEach(c => { if (counts[c] !== undefined) counts[c]++; });
    });
    return counts;
}

function weightedClubSelection(availableClubs, count, usageCounts) {
    const maxUsage = Math.max(...availableClubs.map(c => usageCounts[c] || 0), 1);
    const weights = availableClubs.map(c => (maxUsage - (usageCounts[c] || 0) + 1));
    const selected = [];
    const pool = [...availableClubs];
    const poolWeights = [...weights];
    for (let i = 0; i < count && pool.length > 0; i++) {
        let r = Math.random() * poolWeights.reduce((a, b) => a + b, 0);
        for (let j = 0; j < pool.length; j++) {
            r -= poolWeights[j];
            if (r <= 0) {
                selected.push(pool[j]);
                pool.splice(j, 1);
                poolWeights.splice(j, 1);
                break;
            }
        }
    }
    return selected;
}

async function generateDailyGridData() {
    const clubs = Object.keys(CLUB_MAP);
    const nations = Object.keys(NATION_MAP);
    const leagues = Object.keys(LEAGUE_MAP);
    const specials = [
        { type: 'champion', value: 'CHAMP', label: 'Meister' },
        { type: 'cupwinner', value: 'CUP', label: 'Cupsieger' },
        { type: 'goals_club_50', value: 'GC50', label: '> 50 Tore für Club' },
        { type: 'assists_club_50', value: 'AC50', label: '> 50 Assists für Club' },
        { type: 'goals_season_10', value: 'GS10', label: '> 10 Tore/Sais.' },
        { type: 'assists_season_10', value: 'AS10', label: '> 10 Assists/Sais.' }
    ];
    const leagueExtras = leagues.map(l => ({ type: 'league', value: l, label: l }));
    const allExtras = [...leagueExtras, ...specials];

    const today = new Date().toISOString().split('T')[0];

    return new Promise((resolve, reject) => {
        db.serialize(() => {
            db.get("SELECT grid_data FROM daily_grids WHERE date < ? ORDER BY date DESC LIMIT 1", [today], (err, prevRow) => {
                const forbiddenClubs = prevRow ? extractClubsFromGrid(JSON.parse(prevRow.grid_data)) : [];

                db.all("SELECT grid_data FROM daily_grids ORDER BY date DESC LIMIT 30", [], (err, rows) => {
                    const last30 = (rows || []).map(r => r.grid_data);
                    const usageCounts = getClubUsageCounts(last30);

                    const availableClubs = clubs.filter(c => !forbiddenClubs.includes(c));
                    if (availableClubs.length < 5) {
                        availableClubs.push(...forbiddenClubs);
                    }

                    const numOther = 1 + Math.floor(Math.random() * 2);
                    const shuffledExtras = [...allExtras].sort(() => 0.5 - Math.random());
                    const other1 = shuffledExtras[0];

                    const numClubsNeeded = numOther === 2 ? 4 : 5;
                    const selectedClubs = weightedClubSelection(availableClubs, numClubsNeeded, usageCounts);

                    const rowClubs = selectedClubs.slice(0, 3);
                    const colClubs = selectedClubs.slice(3);

                    const rows = rowClubs.map(c => ({ type: 'team', value: c, label: c }));
                    const cols = [];

                    if (numOther === 2) {
                        const nat = nations[Math.floor(Math.random() * nations.length)];
                        cols.push({ type: 'nation', value: nat, label: nat });
                        cols.push(other1);
                    } else {
                        cols.push({ type: 'team', value: colClubs[0], label: colClubs[0] });
                        cols.push(other1);
                    }
                    cols.push({ type: 'team', value: colClubs[colClubs.length - 1], label: colClubs[colClubs.length - 1] });

                    resolve({ rows, cols });
                });
            });
        });
    });
}

app.get('/api/daily-grid', async (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    db.get("SELECT grid_data FROM daily_grids WHERE date = ?", [today], async (err, row) => {
        if (row) return res.json(JSON.parse(row.grid_data));
        try {
            const gridData = await generateDailyGridData();
            const newGrid = { ...gridData, date: today };
            db.run("INSERT INTO daily_grids (date, grid_data) VALUES (?, ?)", [today, JSON.stringify(newGrid)]);
            res.json(newGrid);
        } catch (e) {
            res.status(500).json({ error: 'Grid generation failed' });
        }
    });
});

// Verifizierung: goals_club_50 und assists_club_50 nur mit spezifischem Verein, kein Fallback auf "irgendein Verein"
async function checkCriteria(tmId, cat) {
    return new Promise((resolve) => {
        let sql = ""; let params = [tmId];
        switch (cat.type) {
            case 'team': sql = "SELECT 1 FROM player_clubs WHERE tm_id = ? AND (club_name LIKE ? OR club_name LIKE ?) LIMIT 1"; params.push(`%${CLUB_MAP[cat.value]}%`); params.push(`%${cat.value}%`); break;
            case 'nation': sql = "SELECT 1 FROM player_nations WHERE tm_id = ? AND nation_code = ? LIMIT 1"; params.push(NATION_MAP[cat.value]); break;
            case 'league': sql = "SELECT 1 FROM player_leagues WHERE tm_id = ? AND (league_code LIKE ? OR league_code LIKE ?) LIMIT 1"; params.push(`%${LEAGUE_MAP[cat.value]}%`); params.push(`%${LEAGUE_MAP[cat.value].replace(' ', '')}%`); break;
            case 'goals_season_10': sql = "SELECT 1 FROM player_season_goals WHERE tm_id = ? AND goals >= 10 LIMIT 1"; break;
            case 'assists_season_10': sql = "SELECT 1 FROM player_season_assists WHERE tm_id = ? AND assists >= 10 LIMIT 1"; break;
            case 'champion': sql = "SELECT 1 FROM players WHERE tm_id = ? AND meistertitel > 0 LIMIT 1"; break;
            case 'cupwinner': sql = "SELECT 1 FROM players WHERE tm_id = ? AND is_cupwinner = 1 LIMIT 1"; break;
            // goals_club_50 und assists_club_50 werden NICHT hier behandelt - nur in evaluateCategory mit Verein
            default: return resolve(false);
        }
        db.get(sql, params, (err, row) => resolve(!!row));
    });
}

app.get('/api/search', (req, res) => {
    const q = req.query.q;
    db.all("SELECT name FROM players WHERE name LIKE ? ORDER BY total_einsaetze DESC LIMIT 15", [`%${q}%`], (err, rows) => {
        res.json(rows ? rows.map(r => ({ n: r.name.trim() })) : []);
    });
});

app.post('/api/verify', async (req, res) => {
    const { playerName, rowCat, colCat } = req.body;
    db.get("SELECT tm_id, total_einsaetze FROM players WHERE LOWER(name) = LOWER(?)", [playerName.trim()], async (err, player) => {
        if (!player) return res.json({ correct: false });

        // goals_club_50 und assists_club_50: NUR gültig mit spezifischem Verein – kein Fallback auf "irgendein Verein"
        const evaluateCategory = async (cat, otherCat) => {
            if (cat.type === 'goals_club_50' || cat.type === 'assists_club_50') {
                if (!otherCat || otherCat.type !== 'team') return false; // Nur mit Verein gefragt
                const table = cat.type === 'goals_club_50' ? 'player_club_goals' : 'player_club_assists';
                const col = cat.type === 'goals_club_50' ? 'goals' : 'assists';
                const minVal = 50;
                return new Promise(resolve => {
                    db.get(`SELECT 1 FROM ${table} WHERE tm_id = ? AND (club_name LIKE ? OR club_name LIKE ?) AND ${col} >= ? LIMIT 1`,
                        [player.tm_id, `%${CLUB_MAP[otherCat.value]}%`, `%${otherCat.value}%`, minVal], (e, r) => resolve(!!r));
                });
            }
            return await checkCriteria(player.tm_id, cat);
        };

        const mRow = await evaluateCategory(rowCat, colCat);
        const mCol = await evaluateCategory(colCat, rowCat);

        if (mRow && mCol) {
            let rarity = Math.max(0.5, (500 / (player.total_einsaetze + 1))).toFixed(1);
            res.json({ correct: true, rarity });
        } else res.json({ correct: false });
    });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.listen(PORT, '0.0.0.0', () => console.log(`Server läuft`));
