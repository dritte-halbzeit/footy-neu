import sqlite3
import cloudscraper
from bs4 import BeautifulSoup
import time
import random
import datetime
import re

DB_NAME = 'schweizer_fussball_grid.db'
# Robuster Scraper mit Browser-Imitation
SCRAPER = cloudscraper.create_scraper(browser={'browser': 'chrome', 'platform': 'darwin', 'desktop': True})

def get_current_league_ids():
    """Holt die IDs aller Spieler, die aktuell in der SL oder CL gemeldet sind."""
    urls = [
        "https://www.transfermarkt.ch/super-league/startseite/wettbewerb/C1",
        "https://www.transfermarkt.ch/challenge-league/startseite/wettbewerb/C2"
    ]
    found_ids = set()
    for url in urls:
        print(f"🔭 Scanne Kaderliste: {url}")
        try:
            res = SCRAPER.get(url, timeout=20)
            soup = BeautifulSoup(res.content, 'html.parser')
            links = soup.find_all('a', href=re.compile(r'/profil/spieler/(\d+)'))
            for link in links:
                m = re.search(r'/spieler/(\d+)', link['href'])
                if m: found_ids.add(int(m.group(1)))
        except Exception as e:
            print(f"⚠️ Fehler beim Scannen: {e}")
    return found_ids

def get_stats(tm_id):
    """Holt Stats aus den Leistungsdatendetails."""
    url = f"https://www.transfermarkt.ch/spieler/leistungsdatendetails/spieler/{tm_id}/plus/0?saison=&verein=&liga=&wettbewerb=&pos=&trainer_id="
    try:
        res = SCRAPER.get(url, timeout=15)
        if res.status_code != 200: return None
        soup = BeautifulSoup(res.content, 'html.parser')
        footer = soup.find('tfoot')
        if not footer: return None
        cells = footer.find_all('td')
        if len(cells) > 6:
            def clean(v): return int(v.text.strip().replace('.', '').replace('-', '0'))
            return {'e': clean(cells[4]), 't': clean(cells[5]), 'a': clean(cells[6])}
    except:
        return None

def run_update():
    conn = sqlite3.connect(DB_NAME)
    cursor = conn.cursor()

    # Sicherstellen, dass die Spalte für den CH-Status existiert
    try:
        cursor.execute("ALTER TABLE players ADD COLUMN in_switzerland INTEGER DEFAULT 0")
    except:
        pass

    # 1. Schritt: Alle Spieler auf in_switzerland = 0 setzen (Reset)
    print("🧹 Setze CH-Status zurück...")
    cursor.execute("UPDATE players SET in_switzerland = 0")

    # 2. Schritt: Aktuelle IDs finden und in_switzerland = 1 setzen
    current_ids = get_current_league_ids()
    print(f"✅ {len(current_ids)} Spieler in Schweizer Kadern gefunden.")
    
    for tid in current_ids:
        cursor.execute("UPDATE players SET in_switzerland = 1 WHERE tm_id = ?", (tid,))
    conn.commit()

    # 3. Schritt: NUR Spieler aktualisieren, die in der Schweiz aktiv sind
    # LIMIT auf 150 gesetzt für kurze Laufzeit
    cursor.execute("""
        SELECT tm_id, name FROM players 
        WHERE in_switzerland = 1 AND retired = 0 
        ORDER BY last_updated ASC 
        LIMIT 150
    """)
    to_update = cursor.fetchall()

    if not to_update:
        print("✅ Keine Spieler zur Aktualisierung gefunden.")
        return

    print(f"🔄 Starte Update für {len(to_update)} aktive CH-Spieler...")

    for i, (tid, name) in enumerate(to_update):
        stats = get_stats(tid)
        now = datetime.date.today().isoformat()
        
        if stats:
            cursor.execute("""
                UPDATE players 
                SET total_einsaetze = ?, total_tore = ?, total_assists = ?, last_updated = ?
                WHERE tm_id = ?
            """, (stats['e'], stats['t'], stats['a'], now, tid))
            conn.commit()
            print(f"[{i+1}/{len(to_update)}] ✅ {name} aktualisiert.")
        else:
            print(f"[{i+1}/{len(to_update)}] ⚠️ {name} übersprungen (keine Daten).")
        
        # Faire Pause zwischen den Anfragen
        time.sleep(random.uniform(4, 7))

    conn.close()
    print("🏁 Update-Prozess erfolgreich beendet.")

if __name__ == "__main__":
    run_update()
