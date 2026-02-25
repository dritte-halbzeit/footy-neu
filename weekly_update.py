import sqlite3
import cloudscraper
from bs4 import BeautifulSoup
import time
import random
import datetime

DB_NAME = 'schweizer_fussball_grid.db'

def get_stats(tm_id):
    scraper = cloudscraper.create_scraper()
    url = f"https://www.transfermarkt.ch/spieler/leistungsdatendetails/spieler/{tm_id}/plus/0?saison=&verein=&liga=&wettbewerb=&pos=&trainer_id="
    headers = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'}
    
    try:
        response = scraper.get(url, headers=headers, timeout=15)
        if response.status_code != 200: return None
        soup = BeautifulSoup(response.content, 'html.parser')
        
        # Check Karriereende
        retired = 1 if "karriereende" in soup.text.lower() or "retired" in soup.text.lower() else 0
        
        footer = soup.find('tfoot')
        if not footer: return {'retired': retired, 'e': 0, 't': 0, 'a': 0}

        cells = footer.find_all('td')
        def clean(v):
            return int(v.text.strip().replace('.', '').replace('-', '0')) if len(cells) > 6 else 0

        return {
            'e': clean(cells[4]),
            't': clean(cells[5]),
            'a': clean(cells[6]),
            'retired': retired
        }
    except:
        return None

def run_update():
    conn = sqlite3.connect(DB_NAME)
    cursor = conn.cursor()

    # 1. Spalten sicherheitshalber anlegen
    try: cursor.execute("ALTER TABLE players ADD COLUMN retired INTEGER DEFAULT 0")
    except: pass
    try: cursor.execute("ALTER TABLE players ADD COLUMN last_updated TEXT")
    except: pass

    # 2. Welche Spieler sollen wir heute updaten?
    # Wir nehmen max. 100 Spieler pro Durchgang, um unter dem Radar zu bleiben
    # Priorität: Aktive Spieler, die am längsten nicht geupdated wurden
    cursor.execute("""
        SELECT tm_id, name FROM players 
        WHERE retired = 0 
        ORDER BY last_updated ASC 
        LIMIT 100
    """)
    players = cursor.fetchall()

    print(f"🔄 Update von {len(players)} Spielern startet...")

    for tm_id, name in players:
        stats = get_stats(tm_id)
        now = datetime.datetime.now().strftime("%Y-%m-%d")
        
        if stats:
            cursor.execute("""
                UPDATE players 
                SET total_einsaetze = ?, total_tore = ?, total_assists = ?, retired = ?, last_updated = ?
                WHERE tm_id = ?
            """, (stats['e'], stats['t'], stats['a'], stats['retired'], now, tm_id))
            conn.commit()
            print(f"✅ {name} aktualisiert.")
        
        time.sleep(random.uniform(5, 10)) # Vorsichtige Pause

    conn.close()

if __name__ == "__main__":
    run_update()