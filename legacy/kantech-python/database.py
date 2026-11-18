import os
import logging
from datetime import datetime
from typing import Optional, List, Dict
import psycopg
from psycopg.rows import dict_row
from config import (
    POSTGRES_HOST,
    POSTGRES_PORT,
    POSTGRES_DB,
    POSTGRES_USER,
    POSTGRES_PASSWORD,
    POSTGRES_CONNECT_TIMEOUT,
    DYDAKTYK_USERNAMES,
)

logger = logging.getLogger(__name__)

class DatabaseManager:
    def __init__(self):
        self.db_config = {
            "host": POSTGRES_HOST,
            "port": POSTGRES_PORT,
            "dbname": POSTGRES_DB,
            "user": POSTGRES_USER,
            "password": POSTGRES_PASSWORD,
            "connect_timeout": POSTGRES_CONNECT_TIMEOUT,
        }
        self._last_seen_access: Dict[str, datetime] = {}
        self._last_seen_count: Dict[str, int] = {}
        self._seen_access_ids = set()
        self.init_database()

    def _connect(self, dict_cursor: bool = False):
        row_factory = dict_row if dict_cursor else None
        return psycopg.connect(**self.db_config, row_factory=row_factory)

    def is_connected(self) -> bool:
        try:
            with self._connect() as conn:
                with conn.cursor() as cursor:
                    cursor.execute("SELECT 1")
                    cursor.fetchone()
            return True
        except Exception:
            return False

    def get_connection_info(self) -> Dict[str, str]:
        return {
            "host": self.db_config["host"],
            "port": str(self.db_config["port"]),
            "database": self.db_config["dbname"],
            "user": self.db_config["user"],
        }

    def fetch_all(self, query: str, params: tuple = ()) -> List[Dict]:
        with self._connect(dict_cursor=True) as conn:
            with conn.cursor() as cursor:
                cursor.execute(query, params)
                return [dict(row) for row in cursor.fetchall()]

    def fetch_one(self, query: str, params: tuple = ()) -> Optional[Dict]:
        with self._connect(dict_cursor=True) as conn:
            with conn.cursor() as cursor:
                cursor.execute(query, params)
                row = cursor.fetchone()
                return dict(row) if row else None
    
    def init_database(self):
        """Initialize database with required tables"""
        with self._connect() as conn:
            with conn.cursor() as cursor:
                cursor.execute('''
                CREATE TABLE IF NOT EXISTS tblDydaktyk (
                    id SERIAL PRIMARY KEY,
                    username TEXT NOT NULL,
                    card_hex TEXT NOT NULL,
                    opened_at TIMESTAMP NOT NULL,
                    closed_at TIMESTAMP,
                    status TEXT,
                    is_active INTEGER NOT NULL DEFAULT 1,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            ''')

                cursor.execute('''
                CREATE TABLE IF NOT EXISTS tblUser (
                    id SERIAL PRIMARY KEY,
                    username TEXT NOT NULL,
                    card_hex TEXT NOT NULL,
                    last_access TIMESTAMP NOT NULL,
                    status TEXT,
                    dydaktyk_id INTEGER,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            ''')

                cursor.execute('''
                CREATE INDEX IF NOT EXISTS idx_dydaktyk_active
                ON tblDydaktyk(is_active)
            ''')

                cursor.execute('''
                CREATE INDEX IF NOT EXISTS idx_dydaktyk_username
                ON tblDydaktyk(username)
            ''')

                cursor.execute('''
                CREATE UNIQUE INDEX IF NOT EXISTS idx_dydaktyk_username_unique
                ON tblDydaktyk(username)
            ''')

                cursor.execute('''
                CREATE INDEX IF NOT EXISTS idx_user_username
                ON tblUser(username)
            ''')

                cursor.execute('''
                CREATE INDEX IF NOT EXISTS idx_user_card_hex
                ON tblUser(card_hex)
            ''')

                cursor.execute('''
                CREATE INDEX IF NOT EXISTS idx_user_dydaktyk_id
                ON tblUser(dydaktyk_id)
            ''')

                cursor.execute('''
                CREATE UNIQUE INDEX IF NOT EXISTS idx_user_unique
                ON tblUser(username, card_hex)
            ''')

            info = self.get_connection_info()
            print(f"Database initialized: {info['host']}:{info['port']}/{info['database']}")
    
    def _is_dydaktyk(self, username: str) -> bool:
        normalized = username.strip().lower()
        # if DYDAKTYK_USERNAMES:
        #     return normalized in DYDAKTYK_USERNAMES
        return normalized.startswith("g")

    def _is_close_status(self, status: str) -> bool:
        status_l = status.strip().lower()
        return "close" in status_l or "closed" in status_l or "zamkn" in status_l

    def get_active_dydaktyk_id(self) -> Optional[int]:
        try:
            with self._connect() as conn:
                with conn.cursor() as cursor:
                    cursor.execute('''
                    SELECT id FROM tblDydaktyk
                    WHERE is_active = 1
                    ORDER BY opened_at DESC
                    LIMIT 1
                ''')
                    row = cursor.fetchone()
                return row[0] if row else None
        except Exception as e:
            print(f"Error getting active dydaktyk: {e}")
            return None

    def get_active_dydaktyk(self) -> Optional[Dict]:
        try:
            with self._connect(dict_cursor=True) as conn:
                with conn.cursor() as cursor:
                    cursor.execute('''
                    SELECT * FROM tblDydaktyk
                    WHERE is_active = 1
                    ORDER BY opened_at DESC
                    LIMIT 1
                ''')
                    row = cursor.fetchone()
                return dict(row) if row else None
        except Exception as e:
            print(f"Error getting active dydaktyk details: {e}")
            return None

    def open_dydaktyk(self, username: str, card_hex: str, opened_at: datetime, status: str) -> Optional[int]:
        try:
            with self._connect() as conn:
                with conn.cursor() as cursor:
                    cursor.execute('''
                    UPDATE tblDydaktyk
                    SET is_active = 0, closed_at = %s, updated_at = %s
                    WHERE is_active = 1
                ''', (opened_at, datetime.now()))

                    cursor.execute('SELECT id FROM tblDydaktyk WHERE username = %s', (username,))
                    existing = cursor.fetchone()

                    if existing:
                        cursor.execute('''
                        UPDATE tblDydaktyk
                        SET card_hex = %s, opened_at = %s, closed_at = NULL, status = %s, is_active = 1, updated_at = %s
                        WHERE username = %s
                    ''', (card_hex, opened_at, status, datetime.now(), username))
                        return existing[0]

                    cursor.execute('''
                    INSERT INTO tblDydaktyk
                    (username, card_hex, opened_at, status, is_active)
                    VALUES (%s, %s, %s, %s, 1)
                    RETURNING id
                ''', (username, card_hex, opened_at, status))

                    row = cursor.fetchone()
                    return row[0] if row else None
        except Exception as e:
            print(f"Error opening dydaktyk: {e}")
            return None

    def close_active_dydaktyk(self, closed_at: datetime, status: str) -> bool:
        try:
            with self._connect() as conn:
                with conn.cursor() as cursor:
                    cursor.execute('''
                    UPDATE tblDydaktyk
                    SET closed_at = %s, status = %s, is_active = 0, updated_at = %s
                    WHERE is_active = 1
                ''', (closed_at, status, datetime.now()))
                return cursor.rowcount > 0
        except Exception as e:
            print(f"Error closing dydaktyk: {e}")
            return False

    def save_user_with_relation(self, username: str, card_hex: str, last_access: datetime,
                                status: str, dydaktyk_id: int) -> bool:
        try:
            with self._connect() as conn:
                with conn.cursor() as cursor:
                    cursor.execute('''
                    INSERT INTO tblUser
                    (username, card_hex, last_access, status, dydaktyk_id, updated_at)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    ON CONFLICT (username, card_hex)
                    DO UPDATE SET
                        last_access = EXCLUDED.last_access,
                        status = EXCLUDED.status,
                        dydaktyk_id = EXCLUDED.dydaktyk_id,
                        updated_at = EXCLUDED.updated_at
                    RETURNING id
                ''', (username, card_hex, last_access, status, dydaktyk_id, datetime.now()))
                    saved_row = cursor.fetchone()
                conn.commit()
                verified_row = self.fetch_one(
                    '''
                    SELECT id, username, card_hex, last_access, status, dydaktyk_id
                    FROM tblUser
                    WHERE username = %s AND card_hex = %s
                    LIMIT 1
                ''',
                    (username, card_hex),
                )
                logger.info(
                    "Saved tblUser row for %s (%s) -> inserted_id=%s verified_id=%s rowcount=%s verified=%s",
                    username,
                    card_hex,
                    saved_row[0] if saved_row else None,
                    verified_row.get("id") if verified_row else None,
                    cursor.rowcount,
                    verified_row,
                )
                return True
        except Exception as e:
            print(f"Error saving user with relation: {e}")
            return False

    def get_user_relation(self, username: str, card_hex: str) -> Optional[int]:
        try:
            with self._connect() as conn:
                with conn.cursor() as cursor:
                    cursor.execute('''
                    SELECT dydaktyk_id FROM tblUser
                    WHERE username = %s AND card_hex = %s
                    LIMIT 1
                ''', (username, card_hex))
                    row = cursor.fetchone()
                return row[0] if row and row[0] is not None else None
        except Exception as e:
            print(f"Error getting user relation: {e}")
            return None

    def get_latest_user_access(self, limit: int = 10) -> List[Dict]:
        try:
            with self._connect(dict_cursor=True) as conn:
                with conn.cursor() as cursor:
                    cursor.execute('''
                    SELECT * FROM tblUser
                    ORDER BY updated_at DESC
                    LIMIT %s
                ''', (limit,))
                return [dict(row) for row in cursor.fetchall()]
        except Exception as e:
            print(f"Error retrieving user access events: {e}")
            return []

    def get_latest_dydaktyk(self, limit: int = 10) -> List[Dict]:
        try:
            with self._connect(dict_cursor=True) as conn:
                with conn.cursor() as cursor:
                    cursor.execute('''
                    SELECT * FROM tblDydaktyk
                    ORDER BY opened_at DESC
                    LIMIT %s
                ''', (limit,))
                return [dict(row) for row in cursor.fetchall()]
        except Exception as e:
            print(f"Error retrieving dydaktyk events: {e}")
            return []

    def close(self):
        """Close database connection"""
        pass
    
    def parse_and_save_access_data(self, raw_data: str) -> List[Dict]:
        """Parse access data table format and save to database"""
        saved_records = []
        try:
            lines = raw_data.strip().split('\n')
            data_lines = []
            for line in lines:
                stripped = line.strip()
                if not stripped:
                    continue
                if stripped == 'No records found' or stripped.startswith('-'):
                    continue

                first_token = stripped.split(maxsplit=1)[0]
                if first_token in {'ID', 'User'}:
                    continue

                data_lines.append(stripped)
            
            for line in data_lines:
                parts = line.split()
                if len(parts) < 6:
                    continue

                try:
                    access_id = ''
                    count = None

                    try:
                        datetime.strptime(f"{parts[1]} {parts[2]}", '%Y-%m-%d %H:%M:%S')
                        row_format = 'table'
                    except ValueError:
                        row_format = 'summary' if parts[1].isdigit() else None

                    if row_format == 'table':
                        access_id = parts[0]
                        if access_id in self._seen_access_ids:
                            continue

                        date_str = parts[1]
                        time_str = parts[2]
                        card_hex = parts[3]
                        username = parts[4]
                        status = ' '.join(parts[5:])
                    elif row_format == 'summary':
                        username = parts[0]
                        count = int(parts[1])
                        card_hex = parts[2]
                        date_str = parts[3]
                        time_str = parts[4]
                        status = ' '.join(parts[5:])
                        access_id = f"{username}:{card_hex}:{date_str} {time_str}"

                        if access_id in self._seen_access_ids:
                            continue
                    else:
                        continue

                    last_access = datetime.strptime(f"{date_str} {time_str}", '%Y-%m-%d %H:%M:%S')
                    self._seen_access_ids.add(access_id)
                    logger.info(
                        "Raw access row: access_id=%s user=%s card=%s time=%s status=%s",
                        access_id,
                        username,
                        card_hex,
                        last_access,
                        status,
                    )

                    if self._is_dydaktyk(username):
                        # Check if this dydaktyk already has active session
                        with self._connect() as conn:
                            with conn.cursor() as cursor:
                                cursor.execute(
                                    'SELECT id FROM tblDydaktyk WHERE username = %s AND is_active = 1',
                                    (username,)
                                )
                                existing_active = cursor.fetchone()
                        
                        if existing_active:
                            # Second swipe - close the active session
                            if self.close_active_dydaktyk(last_access, "Second swipe"):
                                saved_records.append({
                                    'type': 'dydaktyk_close',
                                    'username': username,
                                    'card_hex': card_hex,
                                    'status': 'Second swipe'
                                })
                                print(f"Closed dydaktyk (second swipe): {username}")
                            continue
                        
                        if self._is_close_status(status):
                            if self.close_active_dydaktyk(last_access, status):
                                saved_records.append({
                                    'type': 'dydaktyk_close',
                                    'username': username,
                                    'card_hex': card_hex,
                                    'status': status
                                })
                                print(f"Closed dydaktyk: {username} - {status}")
                        else:
                            dydaktyk_id = self.open_dydaktyk(username, card_hex, last_access, status)
                            if dydaktyk_id:
                                saved_records.append({
                                    'type': 'dydaktyk_open',
                                    'username': username,
                                    'card_hex': card_hex,
                                    'dydaktyk_id': dydaktyk_id,
                                    'status': status
                                })
                                print(f"Opened dydaktyk: {username} - {card_hex} - id {dydaktyk_id}")
                    else:
                        active = self.get_active_dydaktyk()
                        dydaktyk_id = active.get("id") if active else None
                        if dydaktyk_id:
                            existing_relation = self.get_user_relation(username, card_hex)

                            if existing_relation == dydaktyk_id:
                                continue

                            if self.save_user_with_relation(username, card_hex, last_access, status, dydaktyk_id):
                                saved_records.append({
                                    'type': 'user',
                                    'username': username,
                                    'card_hex': card_hex,
                                    'dydaktyk_id': dydaktyk_id,
                                    'status': status,
                                    'count': count
                                })
                                print(f"Saved user: {username} -> dydaktyk {dydaktyk_id}")
                except (ValueError, IndexError) as e:
                    print(f"Error parsing line: {line} - {e}")
                    continue
        except Exception as e:
            print(f"Error parsing access data: {e}")
        
        return saved_records
