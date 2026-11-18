try:
    from connector import SmartServiceConnector
    from poller import EventPoller
except Exception:
    from connector import SmartServiceConnector
    from poller import EventPoller

import logging
import signal
import atexit
import sys

def main():
    logging.basicConfig(level=logging.INFO, format="%(levelname)s:%(name)s:%(message)s")
    print("Initializing Kantech SmartService Connector...")
    
    connector = SmartServiceConnector()

    def shutdown(signum=None, frame=None):
        print("Stopping service...")
        try:
            poller.stop()
        except Exception:
            pass
        try:
            connector.logout()
        finally:
            sys.exit(0)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)
    atexit.register(connector.logout)
    
    if not connector.login():
        print("Initial login failed. Poller will attempt to retry.")
    
    poller = EventPoller(connector)
    
    try:
        poller.start()
    except KeyboardInterrupt:
        shutdown()
    finally:
        connector.logout()

if __name__ == "__main__":
    main()
