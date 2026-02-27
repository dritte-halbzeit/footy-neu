import sqlite3
import cloudscraper
from bs4 import BeautifulSoup
import time
import random
import datetime
import re

DB_NAME = 'schweizer_fussball_grid.db'

# Wir nutzen eine globale Session für alle Anfragen
SCRAPER = cloudscraper.create_scraper(browser={'browser': 'chrome', 'platform': 'darwin', 'desktop': True})

def clean_player_name(raw_name):
    """
    Entfernt Rückennummern (z.B. #99) und überschüssige Whitespaces.
    Beispiel: '#99    Samuel Essende' -> 'Samuel Essende'
    """
    if not raw_name:
        return ""
    # Entfernt das Muster # (Zahlen) (Leerzeichen) am Anfang des Strings
    clean_name = re.sub(r'^#\d+\s+', '', raw_name)
    # Entfernt Zeilenumbrüche und doppelte Leerzeichen
    clean_name = " ".join(clean_name.split())
    return clean_name.strip()

def cleanup_existing_database(cursor):
    """
    Säubert alle Namen in der Datenbank, die noch Rückennummern enthalten.
    Dies korrigiert deine 5000+ bestehenden Einträge.
    """
    print("🧹 Suche nach Namen mit Rückennummern in der Datenbank...")
    cursor.execute("SELECT tm_id, name FROM players WHERE name LIKE '#%'")
    rows = cursor.fetchall()
    
    if rows:
        print(f"   -> {len(rows)} Einträge zur Bereinigung gefunden.")
        for tid, name in rows:
            new_name = clean_player_name(name)
            cursor.execute("UPDATE players SET name = ? WHERE tm_id = ?", (new_name, tid))
        print("✅ Datenbank-Bereinigung abgeschlossen.")
    else:
        print("✅ Keine Namen mit Rückennummern gefunden.")

def get_current_swiss_players_data():
    """
    Scant Super League und Challenge League Kader.
    Gibt ein Dictionary {tm_id: cleaned_name} zurück.
    """
    urls = [
        "https://www.transfermarkt.ch/super-league/startseite/wettbewerb/C1",
        "https://www.transfermarkt.ch/challenge-league/startseite/wettbewerb/C2"
    ]
    found_players = {}
    for url in urls:
        print(f"🔭 Scanne aktuelle Kaderliste: {url}")
        try:
            res = SCRAPER.get(url, timeout=20)
            soup = BeautifulSoup(res.content, 'html.parser')
            
            # Suche alle Spieler-Links in den Tabellen (Klasse 'hauptlink' ist spezifisch für Namen)
            links = soup.select('td.hauptlink a[href*="/profil/spieler/"]')
            for link in links:
                m = re.search(r'/spieler/(\d+)', link['href'])
                if m:
                    tm_id = int(m.group(1))
                    name = clean_player_name(link.text)
                    if name:
                        found_players[tm_id] = name
            time.sleep(3)
        except Exception as e:
            print(f"❌ Fehler beim Scannen von {url}: {e}")
    return found_players

def get_player_stats(tm_id):
    """Holt Leistungsdaten (Einsätze, Tore, Assists) von Transfermarkt."""
    s_url = f"https://www.transfermarkt.ch/spieler/leistungsdatendetails/spieler/{tm_id}/plus/0?saison=&verein=&liga=&wettbewerb=&pos=&trainer_id="
    try:
        res = SCRAPER.get(s_url, timeout=20)
        if res.status_code != 200: return None
        
        soup = BeautifulSoup(res.content, 'html.parser')
        footer = soup.find('tfoot')
        if not footer: return None

        cells = footer.find_all('td')
        if len(cells) > 6:
            def clean_val(v):
                txt = v.text.strip().replace('.', '').replace(',', '').replace('-', '0')
                return int(txt) if txt.isdigit() else 0
            return {'e': clean_val(cells[4]), 't': clean_val(cells[5]), 'a': clean_val(cells[6])}
    except:
        return None

def run_update():
    conn = sqlite3.connect(DB_NAME)
    cursor = conn.cursor()

    # 0. Bestehende Daten bereinigen (Falls noch #99 in der DB steht)
    cleanup_existing_database(cursor)
    conn.commit()

    # 1. Aktuelle IDs und Namen aus den Schweizer Ligen holen (für neue Spieler)
    scraped_players = get_current_swiss_players_data()
    print(f"✅ {len(scraped_players)} Spieler aktuell in der Schweiz gesichtet.")

    # 2. Status in der DB aktualisieren und neue Spieler anlegen
    # Wir setzen zuerst alle auf 0, um Abgänge zu markieren
    cursor.execute("UPDATE players SET in_switzerland = 0")
    
    for tid, name in scraped_players.items():
        # Prüfen, ob Spieler bereits existiert
        cursor.execute("SELECT tm_id FROM players WHERE tm_id = ?", (tid,))
        if cursor.fetchone():
            # Existiert: Update Status und Name (falls Name in DB noch alt ist)
            cursor.execute("UPDATE players SET in_switzerland = 1, name = ? WHERE tm_id = ?", (name, tid))
        else:
            # Neu: Einfügen
            print(f"🆕 Neu in Datenbank: {name}")
            cursor.execute("""
                INSERT INTO players (tm_id, name, in_switzerland, last_updated) 
                VALUES (?, ?, 1, NULL)
            """, (tid, name))
    conn.commit()

    # 3. Nur Spieler scrapen, die aktuell in der Schweiz spielen (in_switzerland = 1)
    # Und die noch nicht heute aktualisiert wurden
    today = datetime.date.today().isoformat()
    cursor.execute("""
        SELECT tm_id, name FROM players 
        WHERE in_switzerland = 1 AND (last_updated != ? OR last_updated IS NULL)
    """, (today,))
    
    to_scrape = cursor.fetchall()
    print(f"🔄 Starte Stats-Update für {len(to_scrape)} aktive Spieler...")

    for i, (tid, name) in enumerate(to_scrape):
        print(f"[{i+1}/{len(to_scrape)}] ⚽ Scrape Stats: {name}")
        stats = get_player_stats(tid)
        
        if stats:
            cursor.execute("""
                UPDATE players 
                SET total_einsaetze = ?, total_tore = ?, total_assists = ?, last_updated = ?
                WHERE tm_id = ?
            """, (stats['e'], stats['t'], stats['a'], today, tid))
            conn.commit()
        
        # Moderate Pause gegen Blocking
        time.sleep(random.uniform(4, 7))

    conn.close()
    print(f"🎉 Update für {today} abgeschlossen.")

if __name__ == "__main__":
    run_update()
