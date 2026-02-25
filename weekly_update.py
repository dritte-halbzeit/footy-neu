import sqlite3
import cloudscraper
from bs4 import BeautifulSoup
import time
import random
import datetime
import re
import pandas as pd

DB_NAME = 'schweizer_fussball_grid.db'

# URLs zum Entdecken neuer Spieler
LEAGUE_URLS = [
    "https://www.transfermarkt.ch/super-league/startseite/wettbewerb/C1",
    "https://www.transfermarkt.ch/challenge-league/startseite/wettbewerb/C2"
]

def get_scraper():
    scraper = cloudscraper.create_scraper()
    scraper.headers.update({
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36'
    })
    return scraper

def discover_ids():
    """Scannt die Liga-Startseiten nach allen aktuellen Spieler-IDs."""
    scraper = get_scraper()
    ids = set()
    for url in LEAGUE_URLS:
        print(f"🔭 Scanne Kaderliste: {url}")
        try:
            res = scraper.get(url, timeout=20)
            soup = BeautifulSoup(res.content, 'html.parser')
            links = soup.find_all('a', href=re.compile(r'/profil/spieler/(\d+)'))
            for link in links:
                m = re.search(r'/spieler/(\d+)', link['href'])
                if m: ids.add(int(m.group(1)))
            time.sleep(3)
        except Exception as e:
            print(f"❌ Fehler beim Scannen: {e}")
    return ids

def get_full_data(tm_id):
    """Holt Namen, Nationen, Clubs und Stats eines Spielers."""
    scraper = get_scraper()
    # Profil für Name/Nationen/Clubs
    p_url = f"https://www.transfermarkt.ch/spieler/profil/spieler/{tm_id}"
    # Leistungsdaten für die exakten Zahlen
    s_url = f"https://www.transfermarkt.ch/spieler/leistungsdatendetails/spieler/{tm_id}/plus/0?saison=&verein=&liga=&wettbewerb=&pos=&trainer_id="
    
    try:
        # 1. Basis-Infos
        res = scraper.get(p_url, timeout=15)
        soup = BeautifulSoup(res.content, 'html.parser')
        
        name = soup.find('h1').text.strip() if soup.find('h1') else "Unbekannt"
        
        # Nationen sammeln
        nations = [img['title'] for img in soup.find_all('img', class_='flaggenabfrage') if img.get('title')]
        
        # Club-Historie (alle Vereine in der Liste)
        clubs = set()
        club_links = soup.find_all('a', href=re.compile(r'/startseite/verein/'))
        for cl in club_links:
            c_name = cl.text.strip()
            if c_name and len(c_name) > 2: clubs.add(c_name)

        # Check ob Karriereende
        retired = 1 if "karriereende" in soup.text.lower() or "retired" in soup.text.lower() else 0

        # 2. Statistiken
        time.sleep(2)
        res_s = scraper.get(s_url, timeout=15)
        soup_s = BeautifulSoup(res_s.content, 'html.parser')
        footer = soup_s.find('tfoot')
        
        e, t, a = 0, 0, 0
        if footer:
            cells = footer.find_all('td')
            if len(cells) > 6:
                def clean(v): return int(v.text.strip().replace('.', '').replace('-', '0'))
                e, t, a = clean(cells[4]), clean(cells[5]), clean(cells[6])

        return {'name': name, 'nations': nations, 'clubs': clubs, 'e': e, 't': t, 'a': a, 'retired': retired}
    except:
        return None

def run():
    conn = sqlite3.connect(DB_NAME)
    cursor = conn.cursor()

    # Spalten initialisieren falls nötig
    try: cursor.execute("ALTER TABLE players ADD COLUMN retired INTEGER DEFAULT 0")
    except: pass
    try: cursor.execute("ALTER TABLE players ADD COLUMN last_updated TEXT")
    except: pass

    # --- TEIL 1: NEUE SPIELER FINDEN ---
    current_ids = discover_ids()
    cursor.execute("SELECT tm_id FROM players")
    known_ids = {row[0] for row in cursor.fetchall()}
    new_ids = list(current_ids - known_ids)

    print(f"✨ {len(new_ids)} neue Spieler entdeckt.")
    # Wir limitieren neue Spieler auf 15 pro Woche, um GitHub-Zeitlimits einzuhalten
    for tid in new_ids[:15]:
        print(f"🆕 Erfasse neuen Spieler {tid}...")
        d = get_full_data(tid)
        if d:
            cursor.execute("INSERT OR REPLACE INTO players (tm_id, name, total_tore, total_assists, total_einsaetze, retired, last_updated) VALUES (?,?,?,?,?,?,?)",
                           (tid, d['name'], d['t'], d['a'], d['e'], d['retired'], datetime.date.today().isoformat()))
            for n in d['nations']:
                cursor.execute("INSERT OR IGNORE INTO player_nations VALUES (?,?)", (tid, n))
            for c in d['clubs']:
                cursor.execute("INSERT OR IGNORE INTO player_clubs VALUES (?,?)", (tid, c))
            conn.commit()
        time.sleep(random.uniform(5, 10))

    # --- TEIL 2: STATS VON AKTIVEN AKTUALISIEREN ---
    # Wir nehmen 50 aktive Spieler, die am längsten nicht geprüft wurden
    cursor.execute("SELECT tm_id, name FROM players WHERE retired = 0 ORDER BY last_updated ASC LIMIT 50")
    to_update = cursor.fetchall()

    print(f"🔄 Aktualisiere Stats für {len(to_update)} aktive Spieler...")
    for tid, name in to_update:
        d = get_full_data(tid)
        if d:
            cursor.execute("UPDATE players SET total_tore=?, total_assists=?, total_einsaetze=?, retired=?, last_updated=? WHERE tm_id=?",
                           (d['t'], d['a'], d['e'], d['retired'], datetime.date.today().isoformat(), tid))
            conn.commit()
            print(f"✅ {name} aktualisiert.")
        time.sleep(random.uniform(5, 10))

    conn.close()
    print("🏁 Update beendet.")

if __name__ == "__main__":
    run()