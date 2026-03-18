import sqlite3
import datetime
import random
import time
import requests

from weekly_update import DB_NAME, get_current_swiss_ids
from api_stats import get_player_stats, API_BASE

MIN_EXPECTED_SWISS_IDS = 120


def ensure_players_columns(cur):
    cur.execute("PRAGMA table_info(players)")
    cols = {r[1] for r in cur.fetchall()}
    if "in_switzerland" not in cols:
        cur.execute("ALTER TABLE players ADD COLUMN in_switzerland INTEGER DEFAULT 0")
    if "last_updated" not in cols:
        cur.execute("ALTER TABLE players ADD COLUMN last_updated TEXT")


def ensure_tables(cur):
    for sql in [
        "CREATE TABLE IF NOT EXISTS player_club_goals (tm_id INTEGER, club_name TEXT, goals INTEGER, PRIMARY KEY(tm_id, club_name))",
        "CREATE TABLE IF NOT EXISTS player_club_assists (tm_id INTEGER, club_name TEXT, assists INTEGER, PRIMARY KEY(tm_id, club_name))",
        "CREATE TABLE IF NOT EXISTS player_club_appearances (tm_id INTEGER, club_name TEXT, appearances INTEGER, PRIMARY KEY(tm_id, club_name))",
        "CREATE TABLE IF NOT EXISTS player_club_yellow_cards (tm_id INTEGER, club_name TEXT, yellow_cards INTEGER, PRIMARY KEY(tm_id, club_name))",
        "CREATE TABLE IF NOT EXISTS player_club_red_cards (tm_id INTEGER, club_name TEXT, red_cards INTEGER, PRIMARY KEY(tm_id, club_name))",
        "CREATE TABLE IF NOT EXISTS player_club_last_season (tm_id INTEGER, club_name TEXT, last_season_year INTEGER, PRIMARY KEY(tm_id, club_name))",
        "CREATE TABLE IF NOT EXISTS player_season_goals (tm_id INTEGER, season_name TEXT, goals INTEGER, PRIMARY KEY(tm_id, season_name))",
        "CREATE TABLE IF NOT EXISTS player_season_assists (tm_id INTEGER, season_name TEXT, assists INTEGER, PRIMARY KEY(tm_id, season_name))",
        "CREATE TABLE IF NOT EXISTS player_leagues (tm_id INTEGER, league_code TEXT)",
    ]:
        cur.execute(sql)


def upsert_club_stat(cur, tid, table, col, data):
    for club_name, value in (data or {}).items():
        if value and int(value) > 0:
            cur.execute(
                f"INSERT INTO {table} (tm_id, club_name, {col}) VALUES (?, ?, ?) "
                f"ON CONFLICT(tm_id, club_name) DO UPDATE SET {col}=excluded.{col}",
                (tid, club_name, int(value))
            )

def check_api_health():
    try:
        resp = requests.get(f"{API_BASE}/docs", timeout=15)
        if resp.status_code != 200:
            print(f"❌ API health check failed: {API_BASE}/docs -> {resp.status_code}")
            return False
        return True
    except Exception as e:
        print(f"❌ API health check exception: {e}")
        return False


def run_weekly_api_update():
    conn = sqlite3.connect(DB_NAME)
    cur = conn.cursor()

    ensure_players_columns(cur)
    ensure_tables(cur)

    if not check_api_health():
        conn.close()
        raise RuntimeError(f"API_BASE is not reachable: {API_BASE}")

    cur.execute("SELECT tm_id FROM players WHERE in_switzerland = 1")
    previous_swiss_ids = {row[0] for row in cur.fetchall()}

    swiss_ids = get_current_swiss_ids()
    print(f"Swiss-listed players found: {len(swiss_ids)}")
    if len(swiss_ids) < MIN_EXPECTED_SWISS_IDS:
        if previous_swiss_ids:
            print(
                f"⚠️ Suspiciously low Swiss count ({len(swiss_ids)}). "
                f"Using fallback from previous DB state ({len(previous_swiss_ids)})."
            )
            swiss_ids = previous_swiss_ids
        else:
            conn.close()
            raise RuntimeError(
                f"Swiss-listed player count too low ({len(swiss_ids)}). "
                "Aborting to avoid bad update."
            )

    cur.execute("UPDATE players SET in_switzerland = 0")
    if swiss_ids:
        cur.executemany("UPDATE players SET in_switzerland = 1 WHERE tm_id = ?", [(i,) for i in swiss_ids])
    conn.commit()

    today = datetime.date.today().isoformat()
    cur.execute("SELECT tm_id, name FROM players WHERE in_switzerland = 1 ORDER BY tm_id")
    to_update = cur.fetchall()
    print(f"Players to update via API: {len(to_update)}")

    ok = fail = 0
    failed_players = []
    for idx, (tid, name) in enumerate(to_update, 1):
        print(f"[{idx}/{len(to_update)}] {name} ({tid})")
        stats = get_player_stats(tid)
        if not stats:
            fail += 1
            failed_players.append((tid, name))
            print(f"   ⚠️ API stats missing/failed for {name} ({tid})")
            time.sleep(random.uniform(0.8, 1.8))
            continue

        cur.execute(
            "UPDATE players SET total_einsaetze=?, total_tore=?, total_assists=?, last_updated=? WHERE tm_id=?",
            (stats.get("e", 0), stats.get("t", 0), stats.get("a", 0), today, tid)
        )

        cur.execute("DELETE FROM player_leagues WHERE tm_id = ?", (tid,))
        for league_name in stats.get("leagues", []) or []:
            if league_name:
                cur.execute("INSERT INTO player_leagues (tm_id, league_code) VALUES (?, ?)", (tid, league_name))

        cur.execute("DELETE FROM player_club_last_season WHERE tm_id = ?", (tid,))
        for club_name, last_year in (stats.get("club_last_season_year", {}) or {}).items():
            if last_year:
                cur.execute(
                    "INSERT INTO player_club_last_season (tm_id, club_name, last_season_year) VALUES (?, ?, ?) "
                    "ON CONFLICT(tm_id, club_name) DO UPDATE SET last_season_year=excluded.last_season_year",
                    (tid, club_name, int(last_year))
                )

        upsert_club_stat(cur, tid, "player_club_goals", "goals", stats.get("club_goals"))
        upsert_club_stat(cur, tid, "player_club_assists", "assists", stats.get("club_assists"))
        upsert_club_stat(cur, tid, "player_club_appearances", "appearances", stats.get("club_appearances"))
        upsert_club_stat(cur, tid, "player_club_yellow_cards", "yellow_cards", stats.get("club_yellow_cards"))
        upsert_club_stat(cur, tid, "player_club_red_cards", "red_cards", stats.get("club_red_cards"))

        for season_name, goals in (stats.get("season_goals", {}) or {}).items():
            if goals and int(goals) > 0:
                cur.execute(
                    "INSERT INTO player_season_goals (tm_id, season_name, goals) VALUES (?, ?, ?) "
                    "ON CONFLICT(tm_id, season_name) DO UPDATE SET goals=excluded.goals",
                    (tid, season_name, int(goals))
                )

        for season_name, assists in (stats.get("season_assists", {}) or {}).items():
            if assists and int(assists) > 0:
                cur.execute(
                    "INSERT INTO player_season_assists (tm_id, season_name, assists) VALUES (?, ?, ?) "
                    "ON CONFLICT(tm_id, season_name) DO UPDATE SET assists=excluded.assists",
                    (tid, season_name, int(assists))
                )

        conn.commit()
        ok += 1
        time.sleep(random.uniform(0.8, 1.8))

    conn.close()
    print(f"Done. Success: {ok}, Failed: {fail}")
    if failed_players:
        sample = ", ".join([f"{n} ({tid})" for tid, n in failed_players[:10]])
        print(f"Failed sample: {sample}")
    if ok == 0:
        raise RuntimeError("No successful player updates. Failing run intentionally.")


if __name__ == "__main__":
    run_weekly_api_update()