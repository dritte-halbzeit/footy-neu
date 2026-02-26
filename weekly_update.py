import sqlite3
import cloudscraper
from bs4 import BeautifulSoup
import time
import random
import datetime
import re

DB_NAME = 'schweizer_fussball_grid.db'
SCRAPER = cloudscraper.create_scraper(browser={'browser': 'chrome', 'platform': 'darwin', 'desktop': True})

def get_current_league_ids():
    """Scannt die Kaderlisten nach allen aktuellen IDs."""
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

def get_full_player_data(tm_id):
    """Holt alle Daten für einen NEUEN Spieler (Profil + Stats)."""
    p_url = f"https://www.transfermarkt.ch/spieler/profil/spieler/{tm_id}"
    s_url = f"https://www.transfermarkt.ch/spieler/leistungsdatendetails/spieler/{tm_id}/plus/0?saison=&verein=&liga=&wettbewerb=&pos=&trainer_id="
    
    try:
        # 1. Profilseite für Name, Nation und Club-Historie
        res = SCRAPER.get(p_url, timeout=15)
        soup = BeautifulSoup(res.content, 'html.parser')
        
        name = soup.find('h1').text.strip() if soup.find('h1') else "Unbekannt"
        nations = [img['title'] for img in soup.find_all('img', class_='flaggenabfrage') if img.get('title')]
        
        clubs = set()
        club_links = soup.find_all('a', href=re.compile(r'/startseite/verein/'))
        for cl in club_links:
            c_name = cl.text.strip()
            if c_name and len(c_name) > 2: clubs.add(c_name)

        # 2. Stats
        time.sleep(2)
        res_s = SCRAPER.get(s_url, timeout=15)
        soup_s = BeautifulSoup(res_s.content, 'html.parser')
        footer = soup_s.find('tfoot')
        e, t, a = 0, 0, 0
        if footer:
            cells = footer.find_all('td')
            if len(cells) > 6:
                def clean(v): return int(v.text.strip().replace('.', '').replace('-', '0'))
                e, t, a = clean(cells[4]), clean(cells[5]), clean(cells[6])

        return {'name': name, 'nations': nations, 'clubs': clubs, 'e': e, 't': t, 'a': a}
    except:
        return None

def run_update():
    conn = sqlite3.connect(DB_NAME)
    cursor = conn.cursor()

    # Spalte sicherstellen
    try: cursor.execute("ALTER TABLE players ADD COLUMN in_switzerland INTEGER DEFAULT 0")
    except: pass

    # 1. Alle auf in_switzerland = 0 setzen
    cursor.execute("UPDATE players SET in_switzerland = 0")

    # 2. Aktuelle IDs finden
    current_ids = get_current_league_ids()
    
    # Bekannte IDs aus der DB holen
    cursor.execute("SELECT tm_id FROM players")
    known_ids = {row[0] for row in cursor.fetchall()}

    new_player_ids = current_ids - known_ids
    existing_player_ids = current_ids & known_ids

    print(f"📊 Analyse: {len(existing_player_ids)} bekannte Spieler, {len(new_player_ids)} neue Spieler.")

    # 3. Bekannte Spieler auf in_switzerland = 1 setzen
    for tid in existing_player_ids:
        cursor.execute("UPDATE players SET in_switzerland = 1 WHERE tm_id = ?", (tid,))
    conn.commit()

    # 4. Neue Spieler komplett neu anlegen (Limit 20 pro Woche)
    new_count = 0
    for tid in new_player_ids:
        if new_count >= 20: break 
        print(f"🆕 Erfasse neuen Spieler {tid}...")
        d = get_full_player_data(tid)
        if d:
            cursor.execute("INSERT INTO players (tm_id, name, total_tore, total_assists, total_einsaetze, in_switzerland, last_updated) VALUES (?,?,?,?,?,?,?)",
                           (tid, d['name'], d['t'], d['a'], d['e'], 1, datetime.date.today().isoformat()))
            for n in d['nations']:
                cursor.execute("INSERT OR IGNORE INTO player_nations VALUES (?,?)", (tid, n))
            for c in d['clubs']:
                cursor.execute("INSERT OR IGNORE INTO player_clubs VALUES (?,?)", (tid, c))
            new_count += 1
            conn.commit()
        time.sleep(random.uniform(5, 10))

    # 5. Stats von 150 bestehenden CH-Spielern updaten (wie bisher)
    cursor.execute("""
        SELECT tm_id, name FROM players 
        WHERE in_switzerland = 1 AND retired = 0 
        ORDER BY last_updated ASC 
        LIMIT 150
    """)
    to_update = cursor.fetchall()
    
    print(f"🔄 Update von {len(to_update)} bestehenden Spielern...")
    for tid, name in to_update:
        # (Hier die Stats-Abfrage wie im vorherigen Skript)
        # ... (der Kürze halber hier weggelassen, sollte aber im File sein)
        pass

    conn.close()
    print("🏁 Fertig.")

if __name__ == "__main__":
    run_update()
