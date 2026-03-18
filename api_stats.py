import os
import requests

API_BASE = os.getenv("API_BASE", "http://localhost:8000")
_club_name_cache = {}

def _get_club_name(club_id: str, timeout: int = 15) -> str:
    if not club_id:
        return "Unknown"
    if club_id in _club_name_cache:
        return _club_name_cache[club_id]
    try:
        resp = requests.get(f"{API_BASE}/clubs/{club_id}/profile", timeout=timeout)
        if resp.status_code == 200:
            data = resp.json()
            name = data.get("name")
            if name:
                _club_name_cache[club_id] = name
                return name
    except Exception:
        pass
    fallback = f"Verein_{club_id}"
    _club_name_cache[club_id] = fallback
    return fallback

def _season_id_to_name(season_id: str) -> str:
    try:
        year = int(season_id)
        if year < 2000:
            return season_id
        return f"{str(year-1)[-2:]}/{str(year)[-2:]}"
    except (ValueError, TypeError):
        return season_id

def _season_id_to_start_year(season_id: str):
    try:
        year = int(season_id)
        if year < 2000:
            return None
        return year - 1
    except (ValueError, TypeError):
        return None

def _safe_int(val, default=0):
    if val is None:
        return default
    if isinstance(val, int):
        return val
    try:
        s = str(val).strip().replace(".", "").replace(",", "").replace("-", "0")
        return int(s) if s and s.isdigit() else default
    except (ValueError, TypeError):
        return default

def get_player_stats(tm_id: int) -> dict | None:
    try:
        resp = requests.get(f"{API_BASE}/players/{tm_id}/stats", timeout=20)
        if resp.status_code != 200:
            return None
        data = resp.json()
        stats_list = data.get("stats") or []
        if not stats_list:
            return {
                "e": 0, "t": 0, "a": 0,
                "club_goals": {}, "club_assists": {}, "club_appearances": {},
                "club_yellow_cards": {}, "club_red_cards": {}, "club_last_season_year": {},
                "season_goals": {}, "season_assists": {}, "leagues": []
            }

        total_e = total_t = total_a = 0
        club_goals, club_assists, club_appearances = {}, {}, {}
        club_yellow_cards, club_red_cards = {}, {}
        club_last_season_year = {}
        season_goals, season_assists = {}, {}
        leagues_seen = set()

        for stat in stats_list:
            apps = _safe_int(stat.get("appearances"))
            goals = _safe_int(stat.get("goals"))
            assists = _safe_int(stat.get("assists"))
            yellows = _safe_int(stat.get("yellowCards") or stat.get("yellow_cards"))
            second_yellows = _safe_int(stat.get("secondYellowCards") or stat.get("second_yellow_cards"))
            reds = _safe_int(stat.get("redCards") or stat.get("red_cards"))

            club_id = str(stat.get("clubId") or stat.get("club_id") or "")
            season_id = str(stat.get("seasonId") or stat.get("season_id") or "")
            season_start_year = _season_id_to_start_year(season_id)

            comp_name = (stat.get("competitionName") or stat.get("competition_name") or "").strip()
            if comp_name:
                leagues_seen.add(comp_name)

            total_e += apps
            total_t += goals
            total_a += assists

            if club_id:
                club_name = _get_club_name(club_id)
                club_goals[club_name] = club_goals.get(club_name, 0) + goals
                club_assists[club_name] = club_assists.get(club_name, 0) + assists
                club_appearances[club_name] = club_appearances.get(club_name, 0) + apps
                club_yellow_cards[club_name] = club_yellow_cards.get(club_name, 0) + yellows
                club_red_cards[club_name] = club_red_cards.get(club_name, 0) + reds + second_yellows
                if season_start_year is not None:
                    prev = club_last_season_year.get(club_name)
                    club_last_season_year[club_name] = season_start_year if prev is None else max(prev, season_start_year)

            if season_id:
                sn = _season_id_to_name(season_id)
                season_goals[sn] = season_goals.get(sn, 0) + goals
                season_assists[sn] = season_assists.get(sn, 0) + assists

        return {
            "e": total_e, "t": total_t, "a": total_a,
            "club_goals": club_goals,
            "club_assists": club_assists,
            "club_appearances": club_appearances,
            "club_yellow_cards": club_yellow_cards,
            "club_red_cards": club_red_cards,
            "club_last_season_year": club_last_season_year,
            "season_goals": season_goals,
            "season_assists": season_assists,
            "leagues": list(leagues_seen),
        }
    except Exception:
        return None