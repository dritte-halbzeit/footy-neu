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
    """Scannt die Kaderlisten von SL und CL nach allen aktuellen IDs."""
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

def get_complete_player_data(tm_id):
    """Holt das VOLLSTÄNDIGE Profil eines Spielers (Stamm, Titel, Stats)."""
    p_url = f"https://www.transfermarkt.ch/spieler/profil/spieler/{tm_id}"
    s_url = f"https://www.transfermarkt.ch/spieler/leistungsdatendetails/spieler/{tm_id}/plus/0?saison=&verein=&liga=&wettbewerb=&pos=&trainer_id="
    
    try:
        # 1. Hauptprofil für Name, Nationen, Clubs und Titel
        res = SCRAPER.get(p_url, timeout=15)
        soup = BeautifulSoup(res.content, 'html.parser')
        
        name = soup.find('h1').text.strip() if soup.find('h1') else "Unbekannt"
        nations = [img['title'] for img in soup.find_all('img', class_='flaggenabfrage') if img.get('title')]
        
        clubs = set()
        for cl in soup.find_all('a', href=re.compile(r'/startseite/verein/')):
            c_name = cl.text.strip()
            if c_name and len(c_name) > 2: clubs.add(c_name)

        # Titel-Check (Erfolge-Box)
        erfolge_text = soup.get_text().lower()
        ist_meister = 1 if any(x in erfolge_text for x in ["meister", "champion"]) else 0
        ist_ts = 1 if any(x in erfolge_text for x in ["torschützenkönig", "top scorer"]) else 0
        ist_cup = 1 if any(x in erfolge_text for x in ["cupsieger", "cup winner"]) else 0

        # 2. Leistungsdaten für die exakten Zahlen (Einsätze, Tore, Assists)
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

        # Check ob Karriereende (wichtig für zukünftige Filterung)
        retired = 1 if "karriereende" in erfolge_text or "retired" in erfolge_text else 0

        return {
            'name': name, 'nations': nations, 'clubs': clubs, 
            'e': e, 't': t, 'a': a, 
            'ch': ist_meister, 'ts': ist_ts, 'cup': ist_cup,
            'retired': retired
        }
    except Exception as e:
        print(f"❌ Fehler bei ID {tm_id}: {e}")
        return None

def run_update():
    conn = sqlite3.connect(DB_NAME)
    cursor = conn.cursor()

    # Vorbereitung: Falls Spalten fehlen
    try: cursor.execute("ALTER TABLE players ADD COLUMN in_switzerland INTEGER DEFAULT 0")
    except: pass
    try: cursor.execute("ALTER TABLE players ADD COLUMN last_updated TEXT")
    except: pass

    # 1. Alle Spieler auf in_switzerland = 0 setzen (Reset für den Abgleich)
    cursor.execute("UPDATE players SET in_switzerland = 0")

    # 2. Kaderlisten scannen
    current_ids = get_current_league_ids()
    cursor.execute("SELECT tm_id FROM players")
    known_ids = {row[0] for row in cursor.fetchall()}

    new_player_ids = list(current_ids - known_ids)
    existing_player_ids = current_ids & known_ids

    print(f"📊 Analyse: {len(existing_player_ids)} bekannte Spieler, {len(new_player_ids)} potenzielle Neuzugänge.")

    # 3. Bekannte Spieler markieren
    for tid in existing_player_ids:
        cursor.execute("UPDATE players SET in_switzerland = 1 WHERE tm_id = ?", (tid,))
    conn.commit()

    # 4. NEUE SPIELER KOMPLETT ERFASSEN (Limit 20 pro Woche)
    new_added = 0
    for tid in new_player_ids:
        if new_added >= 20: break 
        print(f"🆕 Erfasse neuen Spieler (ID: {tid})...")
        d = get_complete_player_data(tid)
        if d:
            cursor.execute("""
                INSERT INTO players (tm_id, name, total_tore, total_assists, total_einsaetze, 
                                    meistertitel, is_topscorer, is_cupwinner, retired, in_switzerland, last_updated) 
                VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                (tid, d['name'], d['t'], d['a'], d['e'], d['ch'], d['ts'], d['cup'], d['retired'], 1, datetime.date.today().isoformat()))
            
            for n in d['nations']:
                cursor.execute("INSERT OR IGNORE INTO player_nations VALUES (?,?)", (tid, n))
            for c in d['clubs']:
                cursor.execute("INSERT OR IGNORE INTO player_clubs VALUES (?,?)", (tid, c))
            new_added += 1
            conn.commit()
            print(f"✅ Vollständig erfasst: {d['name']}")
        time.sleep(random.uniform(7, 12))

    # 5. BESTEHENDE SCHWEIZER SPIELER AKTUALISIEREN (Limit 150 pro Woche)
    cursor.execute("""
        SELECT tm_id, name FROM players 
        WHERE in_switzerland = 1 AND retired = 0 
        ORDER BY last_updated ASC LIMIT 150
    """)
    to_update = cursor.fetchall()
    
    print(f"🔄 Aktualisiere {len(to_update)} bestehende Schweizer Spieler...")
    for tid, name in to_update:
        d = get_complete_player_data(tid)
        if d:
            cursor.execute("""
                UPDATE players 
                SET total_tore=?, total_assists=?, total_einsaetze=?, meistertitel=?, is_topscorer=?, is_cupwinner=?, retired=?, last_updated=?
                WHERE tm_id=?
            """, (d['t'], d['a'], d['e'], d['ch'], d['ts'], d['cup'], d['retired'], datetime.date.today().isoformat(), tid))
            conn.commit()
            print(f"✅ Update: {name}")
        time.sleep(random.uniform(5, 8))

    conn.close()
    print(f"🏁 Update beendet. {new_added} neue Spieler hinzugefügt.")

if __name__ == "__main__":
    run_update()
