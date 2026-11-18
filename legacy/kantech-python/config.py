import os

BASE_URL = os.getenv("KANTECH_URL", "http://kantech.example.invalid/SmartService")
USERNAME = os.getenv("KANTECH_USER", "exampleUser")
PASSWORD = os.getenv("KANTECH_PASS", "")
POLL_INTERVAL = int(os.getenv("KANTECH_POLL_INTERVAL", "1"))

# PostgreSQL Configuration
POSTGRES_HOST = os.getenv("POSTGRES_HOST", "127.0.0.1")
POSTGRES_PORT = int(os.getenv("POSTGRES_PORT", "5432"))
POSTGRES_DB = os.getenv("POSTGRES_DB", "planqr_db")
POSTGRES_USER = os.getenv("POSTGRES_USER", "zut")
POSTGRES_PASSWORD = os.getenv("POSTGRES_PASSWORD", "")
POSTGRES_CONNECT_TIMEOUT = int(os.getenv("POSTGRES_CONNECT_TIMEOUT", "5"))

# Optional explicit dydaktyk usernames.
# If this is set, only these usernames are treated as dydaktyk.
DYDAKTYK_USERNAMES = [
	name.strip().lower()
	for name in os.getenv("DYDAKTYK_USERNAMES", "").split(",")
	if name.strip()
]

# WebService Configuration
WEBSERVICE_HOST = os.getenv("WEBSERVICE_HOST", "0.0.0.0")
WEBSERVICE_PORT = int(os.getenv("WEBSERVICE_PORT", "5000"))
WEBSERVICE_DEBUG = os.getenv("WEBSERVICE_DEBUG", "False").lower() == "true"
