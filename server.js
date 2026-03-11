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
db.run(`CREATE TABLE IF NOT EXISTS player_club_appearances (tm_id INTEGER, club_name TEXT, appearances INTEGER, PRIMARY KEY(tm_id, club_name))`);
db.run(`CREATE TABLE IF NOT EXISTS player_club_yellow_cards (tm_id INTEGER, club_name TEXT, yellow_cards INTEGER, PRIMARY KEY(tm_id, club_name))`);
db.run(`CREATE TABLE IF NOT EXISTS player_club_red_cards (tm_id INTEGER, club_name TEXT, red_cards INTEGER, PRIMARY KEY(tm_id, club_name))`);
db.run(`CREATE TABLE IF NOT EXISTS player_season_goals (tm_id INTEGER, season_name TEXT, goals INTEGER, PRIMARY KEY(tm_id, season_name))`);
db.run(`CREATE TABLE IF NOT EXISTS daily_grids (
  date TEXT PRIMARY KEY,
  grid_data TEXT
)`);
db.run(`CREATE TABLE IF NOT EXISTS daily_scores (
  date TEXT NOT NULL,
  player_id TEXT NOT NULL,
  display_name TEXT DEFAULT 'Anonym',
  score REAL NOT NULL,
  correct_count INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (date, player_id)
)`);

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
    "ARG": "Argentina", "CMR": "Cameroon", "CIV": "Cote d'Ivoire", "POR": "Portugal", "TUR": "Türkiye"
};

const LEAGUE_MAP = {
    "Germany": "Bundesliga", "England": "Premier League",
    "France": "Ligue 1", "Spain": "La Liga", "Italy": "Serie A"
};

function getLeagueSearchTerms(cat) {
    const terms = new Set();
    if (!cat) return [];
    const value = String(cat.value || '').trim();
    const label = String(cat.label || '').trim();
    if (value) {
        terms.add(value);
        if (LEAGUE_MAP[value]) terms.add(LEAGUE_MAP[value]);
    }
    if (label) {
        terms.add(label);
        if (LEAGUE_MAP[label]) terms.add(LEAGUE_MAP[label]);
    }
    const expanded = new Set();
    for (const t of terms) {
        if (!t) continue;
        expanded.add(t);
        expanded.add(t.replace(/\s+/g, ''));
    }
    return Array.from(expanded);
}

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
        { type: 'goals_club_50', value: 'GC25', label: '> 25 Tore für Club' },
        { type: 'assists_club_50', value: 'AC25', label: '> 25 Assists für Club' },
        { type: 'goals_season_10', value: 'GS10', label: '> 10 Tore/Sais.' },
        { type: 'assists_season_10', value: 'AS10', label: '> 10 Assists/Sais.' }
    ];
    const leagueExtras = leagues.map(l => ({ type: 'league', value: l, label: LEAGUE_MAP[l] }));
    const allExtras = [...leagueExtras, ...specials];

    const today = new Date().toISOString().split('T')[0];

    return new Promise((resolve, reject) => {
        db.serialize(() => {
            db.get("SELECT grid_data FROM daily_grids WHERE date < ? ORDER BY date DESC LIMIT 1", [today], (err, prevRow) => {
                const forbiddenClubs = prevRow ? extractClubsFromGrid(JSON.parse(prevRow.grid_data)) : [];

                db.all("SELECT grid_data FROM daily_grids ORDER BY date DESC LIMIT 30", [], (err, dbRows) => {
                    const last30 = (dbRows || []).map(r => r.grid_data);
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
        if (err) return res.status(500).json({ error: 'Grid lookup failed' });
        if (row) return res.json(JSON.parse(row.grid_data));
        try {
            const gridData = await generateDailyGridData();
            const newGrid = { ...gridData, date: today };
            const payload = JSON.stringify(newGrid);
            db.run("INSERT OR IGNORE INTO daily_grids (date, grid_data) VALUES (?, ?)", [today, payload], (insertErr) => {
                if (insertErr) return res.status(500).json({ error: 'Grid persist failed' });
                // Always return the canonical stored grid for the day.
                db.get("SELECT grid_data FROM daily_grids WHERE date = ?", [today], (readErr, storedRow) => {
                    if (readErr || !storedRow) return res.status(500).json({ error: 'Grid read-back failed' });
                    res.json(JSON.parse(storedRow.grid_data));
                });
            });
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
            case 'league': {
                const terms = getLeagueSearchTerms(cat);
                if (!terms.length) return resolve(false);
                const leagueWhere = terms.map(() => "league_code LIKE ?").join(" OR ");
                sql = `SELECT 1 FROM player_leagues WHERE tm_id = ? AND (${leagueWhere}) LIMIT 1`;
                params.push(...terms.map(t => `%${t}%`));
                break;
            }
            case 'goals_season_10': sql = "SELECT 1 FROM player_season_goals WHERE tm_id = ? AND goals >= 10 LIMIT 1"; break;
            case 'assists_season_10': sql = "SELECT 1 FROM player_season_assists WHERE tm_id = ? AND assists >= 10 LIMIT 1"; break;
            case 'champion': sql = "SELECT 1 FROM players WHERE tm_id = ? AND meistertitel > 0 LIMIT 1"; break;
            case 'cupwinner': sql = "SELECT 1 FROM players WHERE tm_id = ? AND is_cupwinner = 1 LIMIT 1"; break;
            default: return resolve(false);
        }
        db.get(sql, params, (err, row) => resolve(!!row));
    });
}

// --- NEUES PUNKTESYSTEM (1–10 pro Antwort, max 90 + 10 Bonus = 100) ---
function parseSeasonToYear(seasonName) {
    if (!seasonName || typeof seasonName !== 'string') return null;
    const m = seasonName.trim().match(/^(\d{2,4})/);
    if (!m) return null;
    let yy = parseInt(m[1], 10);
    if (yy >= 90) return 1900 + yy;
    if (yy >= 0 && yy <= 50) return 2000 + yy;
    return yy >= 100 ? yy : 2000 + yy;
}

function getEarliestSeasonYear(tmId) {
    return new Promise((resolve) => {
        db.all(
            `SELECT season_name FROM player_season_goals WHERE tm_id = ? UNION SELECT season_name FROM player_season_assists WHERE tm_id = ?`,
            [tmId, tmId],
            (err, rows) => {
                if (err || !rows || rows.length === 0) return resolve(null);
                let minYear = null;
                for (const r of rows) {
                    const y = parseSeasonToYear(r.season_name);
                    if (y != null && (minYear == null || y < minYear)) minYear = y;
                }
                resolve(minYear);
            }
        );
    });
}

function getClubAppearances(tmId, clubKey) {
    return new Promise((resolve) => {
        const patterns = [`%${clubKey}%`];
        if (CLUB_MAP[clubKey]) patterns.push(`%${CLUB_MAP[clubKey]}%`);
        const placeholders = patterns.map(() => 'club_name LIKE ?').join(' OR ');
        db.get(
            `SELECT appearances FROM player_club_appearances WHERE tm_id = ? AND (${placeholders}) LIMIT 1`,
            [tmId, ...patterns],
            (err, row) => resolve(row ? (row.appearances || 0) : 0)
        );
    });
}

async function calculateRarity(player, rowCat, colCat) {
    const totalApps = (player.total_einsaetze || 0) + 1;
    // Base: 1–10 (viele Einsätze → 1, wenige → 10)
    let baseScore = 1 + 9 * Math.max(0, 1 - totalApps / 650);
    baseScore = Math.max(1, Math.min(10, Math.round(baseScore * 10) / 10));

    // Vintage: 0–2 (ältere Spieler = mehr Punkte)
    const earliestYear = await getEarliestSeasonYear(player.tm_id);
    let vintageBonus = 0;
    if (earliestYear != null) {
        if (earliestYear < 2000) vintageBonus = 2;
        else if (earliestYear < 2005) vintageBonus = 1.5;
        else if (earliestYear < 2010) vintageBonus = 1;
        else if (earliestYear < 2015) vintageBonus = 0.5;
    }

    // Intersection obscurity: 0–3 (Club A ∩ Club B, niedriges min = obscurer)
    let obscurityBonus = 0;
    if (rowCat && rowCat.type === 'team' && colCat && colCat.type === 'team') {
        const [appA, appB] = await Promise.all([
            getClubAppearances(player.tm_id, rowCat.value),
            getClubAppearances(player.tm_id, colCat.value)
        ]);
        const minApps = Math.min(appA, appB);
        if (minApps <= 5) obscurityBonus = 3;
        else if (minApps <= 15) obscurityBonus = 2;
        else if (minApps <= 30) obscurityBonus = 1;
    }

    let rarity = baseScore + vintageBonus + obscurityBonus;
    rarity = Math.max(1, Math.min(10, Math.round(rarity * 10) / 10));
    return rarity.toFixed(1);
}

async function evaluateCategory(tmId, cat, otherCat) {
    if (cat.type === 'goals_club_50' || cat.type === 'assists_club_50') {
        if (!otherCat || otherCat.type !== 'team') return false;
        const table = cat.type === 'goals_club_50' ? 'player_club_goals' : 'player_club_assists';
        const col = cat.type === 'goals_club_50' ? 'goals' : 'assists';
        return new Promise(resolve => {
            db.get(`SELECT 1 FROM ${table} WHERE tm_id = ? AND (club_name LIKE ? OR club_name LIKE ?) AND ${col} >= 25 LIMIT 1`,
                [tmId, `%${CLUB_MAP[otherCat.value]}%`, `%${otherCat.value}%`], (e, r) => resolve(!!r));
        });
    }
    return await checkCriteria(tmId, cat);
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

        const mRow = await evaluateCategory(player.tm_id, rowCat, colCat);
        const mCol = await evaluateCategory(player.tm_id, colCat, rowCat);

        if (mRow && mCol) {
            const rarity = await calculateRarity(player, rowCat, colCat);
            res.json({ correct: true, rarity });
        } else {
            let failedRow = !mRow;
            let failedCol = !mCol;
            res.json({ correct: false, failedRow, failedCol });
        }
    });
});

// --- Leaderboard: Score abgeben und Rangliste abrufen ---
app.post('/api/submit-score', (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    const { playerId, displayName, score, correctCount } = req.body || {};
    if (!playerId || typeof score !== 'number' || typeof correctCount !== 'number') {
        return res.status(400).json({ error: 'playerId, score und correctCount erforderlich' });
    }
    const name = (displayName && String(displayName).trim()) ? String(displayName).trim().slice(0, 30) : 'Anonym';
    db.serialize(() => {
        db.run('DELETE FROM daily_scores WHERE date = ? AND player_id = ?', [today, String(playerId).slice(0, 64)], () => {
            db.run(
                'INSERT INTO daily_scores (date, player_id, display_name, score, correct_count) VALUES (?, ?, ?, ?, ?)',
                [today, String(playerId).slice(0, 64), name, score, correctCount],
                (err) => {
                    if (err) return res.status(500).json({ error: 'Speichern fehlgeschlagen' });
                    res.json({ ok: true });
                }
            );
        });
    });
});

app.get('/api/leaderboard', (req, res) => {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const playerId = req.query.playerId || null;
    db.all(
        `SELECT player_id, display_name, score, correct_count
         FROM daily_scores WHERE date = ? ORDER BY score DESC, correct_count DESC LIMIT 50`,
        [date],
        (err, rows) => {
            if (err) return res.status(500).json({ error: 'Abfrage fehlgeschlagen' });
            const list = (rows || []).map((r, i) => ({
                rank: i + 1,
                playerId: r.player_id,
                displayName: r.display_name || 'Anonym',
                score: r.score,
                correctCount: r.correct_count,
                isYou: playerId !== null && r.player_id === playerId
            }));
            const yourEntry = list.find((e) => e.isYou);
            const yourRank = yourEntry ? yourEntry.rank : null;
            res.json({ date, list, yourRank });
        }
    );
});

// --- Lösungen: Ein gültiger Spieler pro Zelle (nur nach Spielende sinnvoll) ---
function getCandidateTmIds(cat, otherCat) {
    return new Promise((resolve) => {
        if (cat.type === 'goals_club_50' || cat.type === 'assists_club_50') {
            if (!otherCat || otherCat.type !== 'team') return resolve([]);
            const table = cat.type === 'goals_club_50' ? 'player_club_goals' : 'player_club_assists';
            const col = cat.type === 'goals_club_50' ? 'goals' : 'assists';
            db.all(
                `SELECT DISTINCT tm_id FROM ${table} WHERE (club_name LIKE ? OR club_name LIKE ?) AND ${col} >= 25 LIMIT 500`,
                [`%${CLUB_MAP[otherCat.value]}%`, `%${otherCat.value}%`],
                (e, rows) => resolve((rows || []).map((r) => r.tm_id))
            );
            return;
        }
        let sql = ''; let params = [];
        switch (cat.type) {
            case 'team': sql = "SELECT DISTINCT tm_id FROM player_clubs WHERE (club_name LIKE ? OR club_name LIKE ?) LIMIT 500"; params = [`%${CLUB_MAP[cat.value]}%`, `%${cat.value}%`]; break;
            case 'nation': sql = "SELECT DISTINCT tm_id FROM player_nations WHERE nation_code = ? LIMIT 500"; params = [NATION_MAP[cat.value]]; break;
            case 'league': {
                const terms = getLeagueSearchTerms(cat);
                if (!terms.length) return resolve([]);
                const leagueWhere = terms.map(() => "league_code LIKE ?").join(" OR ");
                sql = `SELECT DISTINCT tm_id FROM player_leagues WHERE (${leagueWhere}) LIMIT 500`;
                params = terms.map(t => `%${t}%`);
                break;
            }
            case 'goals_season_10': sql = "SELECT DISTINCT tm_id FROM player_season_goals WHERE goals >= 10 LIMIT 500"; break;
            case 'assists_season_10': sql = "SELECT DISTINCT tm_id FROM player_season_assists WHERE assists >= 10 LIMIT 500"; break;
            case 'champion': sql = "SELECT tm_id FROM players WHERE meistertitel > 0 LIMIT 500"; break;
            case 'cupwinner': sql = "SELECT tm_id FROM players WHERE is_cupwinner = 1 LIMIT 500"; break;
            default: return resolve([]);
        }
        db.all(sql, params, (e, rows) => resolve((rows || []).map((r) => r.tm_id)));
    });
}

async function getOneValidPlayerForCell(rowCat, colCat) {
    const [rowIds, colIds] = await Promise.all([
        getCandidateTmIds(rowCat, colCat),
        getCandidateTmIds(colCat, rowCat)
    ]);
    const setCol = new Set(colIds);
    const intersection = rowIds.filter((id) => setCol.has(id));
    if (intersection.length === 0) return null;
    return new Promise((resolve) => {
        db.get("SELECT name FROM players WHERE tm_id = ?", [intersection[0]], (err, row) => resolve(row ? row.name.trim() : null));
    });
}

app.get('/api/grid-solutions', async (req, res) => {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    db.get("SELECT grid_data FROM daily_grids WHERE date = ?", [date], async (err, row) => {
        if (!row) return res.status(404).json({ error: 'Grid nicht gefunden' });
        const grid = JSON.parse(row.grid_data);
        const { rows = [], cols = [] } = grid;
        if (rows.length < 3 || cols.length < 3) return res.status(400).json({ error: 'Ungültiges Grid' });
        const cells = {};
        for (let r = 0; r < 3; r++) {
            for (let c = 0; c < 3; c++) {
                const name = await getOneValidPlayerForCell(rows[r], cols[c]);
                cells[`${r}-${c}`] = name || '—';
            }
        }
        res.json({ date, cells });
    });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.listen(PORT, '0.0.0.0', () => console.log(`Server läuft`));
