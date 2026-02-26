const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

console.log("--- 🚀 SERVER-START-SEQUENZ ---");

// 1. Verzeichnis-Inhalt auflisten (um zu sehen, was wirklich da ist)
const files = fs.readdirSync(__dirname);
console.log("📂 Vorhandene Dateien im Ordner:", files.join(", "));

// 2. Pfad-Prüfung
const dbName = 'schweizer_fussball_grid.db'; // <--- PRÜFE DAS GEGEN GITHUB!
const dbPath = path.join(__dirname, dbName);

if (!fs.existsSync(dbPath)) {
    console.error(`❌ FEHLER: Die Datei ${dbName} wurde NICHT gefunden.`);
} else {
    const stats = fs.statSync(dbPath);
    console.log(`✅ Datei gefunden! Größe: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
}

// 3. Datenbank-Verbindung mit Try-Catch
let db;
try {
    db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, (err) => {
        if (err) console.error("❌ SQLITE-ERROR beim Öffnen:", err.message);
        else console.log("✅ Datenbank erfolgreich geöffnet.");
    });
} catch (e) {
    console.error("❌ ABSTURZ beim Datenbank-Initialisieren:", e.message);
}

app.use(express.json());
app.use(express.static(__dirname));

// Test-Endpunkt
app.get('/api/search', (req, res) => {
    if (!db) return res.json({error: "Keine Datenbank"});
    const q = req.query.q || "";
    db.all("SELECT name FROM players WHERE name LIKE ? LIMIT 5", [`%${q}%`], (err, rows) => {
        res.json(rows || []);
    });
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// WICHTIG: Server binden
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`--- 🌐 SERVER BEREIT AUF PORT ${PORT} ---`);
});

server.on('error', (err) => {
    console.error("❌ SERVER-FEHLER:", err);
});