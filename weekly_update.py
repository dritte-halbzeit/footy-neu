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

def get_current_swiss_ids():
    """Holt alle IDs von Spielern, die aktuell in SL oder CL gemeldet sind."""
    urls = [
        "https://www.transfermarkt.ch/super-league/startseite/wettbewerb/C1",
        "https://www.transfermarkt.ch/challenge-league/startseite/wettbewerb/C2"
    ]
    current_ids = set()
    for url in urls:
        print(f"🔭 Scanne aktuelle Kaderliste: {url}")
        try:
            res = SCRAPER.get(url, timeout=20)
            soup = BeautifulSoup(res.content, 'html.parser')
            links = soup.find_all('a', href=re.compile(r'/profil/spieler/(\d+)'))
            for link in links:
                m = re.search(r'/spieler/(\d+)', link['href'])
                if m: current_ids.add(int(m.group(1)))
            time.sleep(3)
        except Exception as e:
            print(f"❌ Fehler beim Scannen der Ligen: {e}")
    return current_ids

def get_player_stats(tm_id):
    """Holt Stats für Spieler in der Schweiz."""
    s_url = f"https://www.transfermarkt.ch/spieler/leistungsdatendetails/spieler/{tm_id}/plus/0?saison=&verein=&liga=&wettbewerb=&pos=&trainer_id="
    try:
        res = SCRAPER.get(s_url, timeout=20)
        if res.status_code != 200: return None
        
        soup = BeautifulSoup(res.content, 'html.parser')
        footer = soup.find('tfoot')
        if not footer: return None

        cells = footer.find_all('td')
        if len(cells) > 6:
            def clean(v):
                txt = v.text.strip().replace('.', '').replace(',', '').replace('-', '0')
                return int(txt) if txt.isdigit() else 0
            # Wir brauchen nur Einsätze, Tore, Assists
            return {'e': clean(cells[4]), 't': clean(cells[5]), 'a': clean(cells[6])}
    except:
        return None

def run_update():
    conn = sqlite3.connect(DB_NAME)
    cursor = conn.cursor()

    # Neue Spalte hinzufügen, falls sie fehlt
    try:
        cursor.execute("ALTER TABLE players ADD COLUMN in_switzerland INTEGER DEFAULT 0")
    except:
        pass

    # 1. Alle aktuellen IDs aus den Schweizer Ligen holen
    current_ch_ids = get_current_swiss_ids()
    print(f"✅ {len(current_ch_ids)} Spieler aktuell in der Schweiz gefunden.")

    # 2. Status in der DB aktualisieren
    # Zuerst alle auf 0 setzen
    cursor.execute("UPDATE players SET in_switzerland = 0")
    # Dann die gefundenen auf 1 setzen
    for tid in current_ch_ids:
        cursor.execute("UPDATE players SET in_switzerland = 1 WHERE tm_id = ?", (tid,))
    conn.commit()

    # 3. Nur Spieler scrapen, die in der Schweiz spielen (in_switzerland = 1)
    # Und die noch nicht heute aktualisiert wurden
    today = datetime.date.today().isoformat()
    cursor.execute("SELECT tm_id, name FROM players WHERE in_switzerland = 1 AND (last_updated != ? OR last_updated IS NULL)", (today,))
    to_scrape = cursor.fetchall()

    print(f"🔄 Starte Update für {len(to_scrape)} Spieler mit Schweizer Einsätzen...")

    for i, (tid, name) in enumerate(to_scrape):
        print(f"[{i+1}/{len(to_scrape)}] ⚽ Scrape: {name}")
        stats = get_player_stats(tid)
        
        if stats:
            cursor.execute("""
                UPDATE players 
                SET total_einsaetze = ?, total_tore = ?, total_assists = ?, last_updated = ?
                WHERE tm_id = ?
            """, (stats['e'], stats['t'], stats['a'], today, tid))
            conn.commit()
        
        # Moderate Pause
        time.sleep(random.uniform(4, 7))

    conn.close()
    print("🎉 Wöchentliches Schweizer Update abgeschlossen.")

if __name__ == "__main__":
    run_update()