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
db.run(`CREATE TABLE IF NOT EXISTS player_club_last_season (tm_id INTEGER, club_name TEXT, last_season_year INTEGER, PRIMARY KEY(tm_id, club_name))`);
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
db.run(`ALTER TABLE players ADD COLUMN is_world_cup INTEGER DEFAULT 0`, () => {});
db.run(`ALTER TABLE players ADD COLUMN is_euro INTEGER DEFAULT 0`, () => {});
db.run(`ALTER TABLE players ADD COLUMN national_team_appearances INTEGER DEFAULT 0`, () => {});

app.use(express.json());
app.use(express.static(__dirname));
app.use('/logos', express.static(path.join(__dirname, 'logos')));

// --- FIXIERTES MAPPING (Wird nicht mehr geändert) ---
const CLUB_MAP = {
    "Basel": "FC Basel 1893", "Thun": "FC Thun", "St. Gallen": "FC St. Gallen 1879",
    "Lugano": "FC Lugano", "Sion": "FC Sion", "Young Boys": "Young Boys",
    "Luzern": "FC Luzern", "Grasshopper": "Grasshopper Club Zürich",
    "Zürich": "FC Zürich", "Winterthur": "FC Winterthur", "Lausanne": "Lausanne-Sport",
    "Servette": "Servette FC", "Aarau": "FC Aarau", "Vaduz": "FC Vaduz",
    "Xamax": "Neuchâtel Xamax", "Wil": "FC Wil 1900"
};

const CHALLENGE_CLUBS = new Set(["Aarau", "Vaduz", "Xamax", "Wil"]);

const NATION_MAP = {
    "SUI": "Switzerland", "ALB": "Albania", "GER": "Germany", "FRA": "France",
    "ITA": "Italy", "SRB": "Serbia", "KOS": "Kosovo", "AUT": "Austria", "ESP": "Spain", "BRA": "Brazil",
    "ARG": "Argentina", "CMR": "Cameroon", "CIV": "Cote d'Ivoire", "POR": "Portugal", "TUR": "Türkiye",
    "CRO": "Croatia", "BIH": "Bosnia-Herzegovina"
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

// --- GRID GENERATOR (deterministisch pro Datum) ---

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

function hashSeed(input) {
    let h = 2166136261;
    for (let i = 0; i < input.length; i++) {
        h ^= input.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

function mulberry32(seed) {
    let t = seed >>> 0;
    return function () {
        t += 0x6D2B79F5;
        let r = Math.imul(t ^ (t >>> 15), t | 1);
        r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
}

function shuffleWithRng(arr, rng) {
    const out = [...arr];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

function addDaysIso(dateStr, deltaDays) {
    const d = new Date(`${dateStr}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + deltaDays);
    return d.toISOString().split('T')[0];
}

function shouldUseChallengeClubOnDate(dateStr) {
    // Deterministic schedule with mandatory one-day break after a Challenge-club day.
    // We iterate from a fixed base date to avoid DB/state dependency across instances.
    const baseDate = "2024-01-01";
    if (dateStr < baseDate) return false;

    let d = baseDate;
    let prevHadChallenge = false;
    while (d <= dateStr) {
        const rng = mulberry32(hashSeed(`challenge-club-day:${d}`));
        const wantsChallenge = rng() < 0.38;
        const hasChallenge = wantsChallenge && !prevHadChallenge;
        if (d === dateStr) return hasChallenge;
        prevHadChallenge = hasChallenge;
        d = addDaysIso(d, 1);
    }
    return false;
}

function generateDailyGridData(dateStr) {
    const clubs = Object.keys(CLUB_MAP);
    const nations = Object.keys(NATION_MAP);
    const leagues = Object.keys(LEAGUE_MAP);
    const specials = [
        { type: 'champion', value: 'CHAMP', label: 'Meister' },
        { type: 'cupwinner', value: 'CUP', label: 'Cupsieger' },
        { type: 'champions_league', value: 'UCL', label: 'Champions League' },
        { type: 'world_cup', value: 'WC', label: 'World Cup' },
        { type: 'goals_club_50', value: 'GC25', label: '> 25 Tore für Club' },
        { type: 'assists_club_50', value: 'AC15', label: '> 15 Assists für Club' },
        { type: 'goals_season_10', value: 'GS10', label: '> 10 Tore/Sais.' },
        { type: 'assists_season_10', value: 'AS10', label: '> 10 Assists/Sais.' }
    ];
    const leagueExtras = leagues.map(l => ({ type: 'league', value: l, label: LEAGUE_MAP[l] }));
    const allExtras = [...leagueExtras, ...specials];

    const rng = mulberry32(hashSeed(`daily-grid:${dateStr}`));
    const numOther = rng() < 0.5 ? 1 : 2;
    const other1 = shuffleWithRng(allExtras, rng)[0];
    const numClubsNeeded = numOther === 2 ? 4 : 5;
    const challengeClubs = clubs.filter(c => CHALLENGE_CLUBS.has(c));
    const regularClubs = clubs.filter(c => !CHALLENGE_CLUBS.has(c));
    const allowChallengeToday = shouldUseChallengeClubOnDate(dateStr);

    let selectedClubs = [];
    if (allowChallengeToday && challengeClubs.length > 0) {
        const pickedChallenge = shuffleWithRng(challengeClubs, rng)[0];
        const regularPicks = shuffleWithRng(regularClubs, rng).slice(0, Math.max(0, numClubsNeeded - 1));
        selectedClubs = shuffleWithRng([pickedChallenge, ...regularPicks], rng).slice(0, numClubsNeeded);
    } else {
        selectedClubs = shuffleWithRng(regularClubs, rng).slice(0, numClubsNeeded);
    }

    const rowClubs = selectedClubs.slice(0, 3);
    const colClubs = selectedClubs.slice(3);
    const rows = rowClubs.map(c => ({ type: 'team', value: c, label: c }));
    const cols = [];

    if (numOther === 2) {
        const nat = shuffleWithRng(nations, rng)[0];
        cols.push({ type: 'nation', value: nat, label: nat });
        cols.push(other1);
    } else {
        cols.push({ type: 'team', value: colClubs[0], label: colClubs[0] });
        cols.push(other1);
    }
    cols.push({ type: 'team', value: colClubs[colClubs.length - 1], label: colClubs[colClubs.length - 1] });

    return { rows, cols };
}

app.get('/api/daily-grid', async (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    db.get("SELECT grid_data FROM daily_grids WHERE date = ?", [today], async (err, row) => {
        if (err) return res.status(500).json({ error: 'Grid lookup failed' });
        if (row) return res.json(JSON.parse(row.grid_data));
        try {
            const gridData = generateDailyGridData(today);
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
            case 'champions_league': sql = "SELECT 1 FROM player_leagues WHERE tm_id = ? AND league_code = ? LIMIT 1"; params.push('UEFA Champions League'); break;
            case 'world_cup': sql = "SELECT 1 FROM players WHERE tm_id = ? AND is_world_cup = 1 LIMIT 1"; break;
            case 'euro': sql = "SELECT 1 FROM players WHERE tm_id = ? AND is_euro = 1 LIMIT 1"; break;
            case 'national_team_appearances': sql = "SELECT 1 FROM players WHERE tm_id = ? AND national_team_appearances > 0 LIMIT 1"; break;
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
    if (yy >= 1000) return yy;
    if (yy >= 90) return 1900 + yy;
    if (yy >= 0 && yy <= 50) return 2000 + yy;
    return yy >= 100 ? yy : 2000 + yy;
}

function getLatestCareerSeasonYear(tmId) {
    return new Promise((resolve) => {
        db.all(
            `SELECT season_name FROM player_season_goals WHERE tm_id = ? UNION SELECT season_name FROM player_season_assists WHERE tm_id = ?`,
            [tmId, tmId],
            (err, rows) => {
                if (err || !rows || rows.length === 0) return resolve(null);
                let maxYear = null;
                for (const r of rows) {
                    const y = parseSeasonToYear(r.season_name);
                    if (y != null && (maxYear == null || y > maxYear)) maxYear = y;
                }
                resolve(maxYear);
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

function getClubLastSeasonYear(tmId, clubKey) {
    return new Promise((resolve) => {
        const patterns = [`%${clubKey}%`];
        if (CLUB_MAP[clubKey]) patterns.push(`%${CLUB_MAP[clubKey]}%`);
        const placeholders = patterns.map(() => 'club_name LIKE ?').join(' OR ');
        db.get(
            `SELECT MAX(last_season_year) AS y FROM player_club_last_season WHERE tm_id = ? AND (${placeholders})`,
            [tmId, ...patterns],
            (err, row) => resolve(row && row.y ? row.y : null)
        );
    });
}

async function getRelevantAppearances(player, rowCat, colCat) {
    const isRowTeam = rowCat && rowCat.type === 'team';
    const isColTeam = colCat && colCat.type === 'team';

    if (isRowTeam && isColTeam) {
        const [appA, appB] = await Promise.all([
            getClubAppearances(player.tm_id, rowCat.value),
            getClubAppearances(player.tm_id, colCat.value)
        ]);
        return Math.min(appA, appB);
    }

    if (isRowTeam) return await getClubAppearances(player.tm_id, rowCat.value);
    if (isColTeam) return await getClubAppearances(player.tm_id, colCat.value);

    return player.total_einsaetze || 0;
}

async function getLatestRelevantSeasonYear(player, rowCat, colCat) {
    const isRowTeam = rowCat && rowCat.type === 'team';
    const isColTeam = colCat && colCat.type === 'team';

    if (isRowTeam && isColTeam) {
        const [yA, yB] = await Promise.all([
            getClubLastSeasonYear(player.tm_id, rowCat.value),
            getClubLastSeasonYear(player.tm_id, colCat.value)
        ]);
        // Use the most recent of both club stints -> recent links get less bonus.
        const vals = [yA, yB].filter(v => v != null);
        if (vals.length) return Math.max(...vals);
    }
    if (isRowTeam) {
        const y = await getClubLastSeasonYear(player.tm_id, rowCat.value);
        if (y != null) return y;
    }
    if (isColTeam) {
        const y = await getClubLastSeasonYear(player.tm_id, colCat.value);
        if (y != null) return y;
    }
    return await getLatestCareerSeasonYear(player.tm_id);
}

function getFreshnessBonus(lastYear) {
    if (lastYear == null) return 0;
    const currentYear = new Date().getFullYear();
    const yearsSince = Math.max(0, currentYear - lastYear);
    // Option 1: freshness bonus (recent = obvious -> low bonus, old = rarer -> higher bonus)
    if (yearsSince <= 2) return 0;
    if (yearsSince <= 5) return 0.5;
    if (yearsSince <= 9) return 1.0;
    return 1.5;
}

async function calculateRarity(player, rowCat, colCat) {
    const relevantApps = await getRelevantAppearances(player, rowCat, colCat);
    const appsForBase = Math.max(0, relevantApps || 0);
    // Base: steilere Kurve (mittlere Einsatzzahlen werden nicht überbewertet)
    // 0 Apps ~= 10.0, 10 Apps ~= 8.9, 50 Apps ~= 5.8, 100 Apps ~= 3.6, hohe Apps -> nahe 1.0
    let baseScore = 1 + 9 * Math.exp(-appsForBase / 80);
    baseScore = Math.max(1, Math.min(10, Math.round(baseScore * 10) / 10));

    // Freshness bonus (Option 2 + 1): based on latest relevant appearance year.
    const latestRelevantYear = await getLatestRelevantSeasonYear(player, rowCat, colCat);
    const vintageBonus = getFreshnessBonus(latestRelevantYear);

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
        const minValue = cat.type === 'goals_club_50' ? 25 : 15;
        return new Promise(resolve => {
            db.get(`SELECT 1 FROM ${table} WHERE tm_id = ? AND (club_name LIKE ? OR club_name LIKE ?) AND ${col} >= ? LIMIT 1`,
                [tmId, `%${CLUB_MAP[otherCat.value]}%`, `%${otherCat.value}%`, minValue], (e, r) => resolve(!!r));
        });
    }
    return await checkCriteria(tmId, cat);
}

function normalizeForCompare(s) {
    return String(s || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

function findPlayerByInputName(inputName) {
    return new Promise((resolve) => {
        const cleaned = String(inputName || '').trim();
        if (!cleaned) return resolve(null);
        db.get(
            "SELECT tm_id, total_einsaetze, name FROM players WHERE LOWER(name) = LOWER(?)",
            [cleaned],
            (err, exactRow) => {
                if (exactRow) return resolve(exactRow);
                const wanted = normalizeForCompare(cleaned);
                db.all(
                    "SELECT tm_id, total_einsaetze, name FROM players ORDER BY total_einsaetze DESC",
                    [],
                    (err2, rows) => {
                        if (err2 || !rows) return resolve(null);
                        const match = rows.find((r) => normalizeForCompare(r.name) === wanted);
                        resolve(match || null);
                    }
                );
            }
        );
    });
}

app.get('/api/search', (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json([]);
    const wanted = normalizeForCompare(q);
    db.all("SELECT name, total_einsaetze FROM players ORDER BY total_einsaetze DESC LIMIT 20000", [], (err, rows) => {
        if (err || !rows) return res.json([]);
        const results = [];
        const seen = new Set();
        for (const r of rows) {
            const name = String(r.name || '').trim();
            if (!name) continue;
            const key = name.toLowerCase();
            if (seen.has(key)) continue;
            if (normalizeForCompare(name).includes(wanted)) {
                seen.add(key);
                results.push({ n: name });
                if (results.length >= 15) break;
            }
        }
        res.json(results);
    });
});

app.post('/api/verify', async (req, res) => {
    const { playerName, rowCat, colCat } = req.body;
    const player = await findPlayerByInputName(playerName);
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
            const minValue = cat.type === 'goals_club_50' ? 25 : 15;
            db.all(
                `SELECT DISTINCT tm_id FROM ${table} WHERE (club_name LIKE ? OR club_name LIKE ?) AND ${col} >= ? LIMIT 500`,
                [`%${CLUB_MAP[otherCat.value]}%`, `%${otherCat.value}%`, minValue],
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
            case 'champions_league': sql = "SELECT DISTINCT tm_id FROM player_leagues WHERE league_code = ? LIMIT 500"; params = ['UEFA Champions League']; break;
            case 'world_cup': sql = "SELECT tm_id FROM players WHERE is_world_cup = 1 LIMIT 500"; break;
            case 'euro': sql = "SELECT tm_id FROM players WHERE is_euro = 1 LIMIT 500"; break;
            case 'national_team_appearances': sql = "SELECT tm_id FROM players WHERE national_team_appearances > 0 LIMIT 500"; break;
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
