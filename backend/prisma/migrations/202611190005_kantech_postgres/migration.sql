CREATE TABLE "KantechReaderStatus" (
    "readerId" TEXT PRIMARY KEY REFERENCES "AttendanceReader" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "state" TEXT NOT NULL CHECK ("state" IN ('connected', 'unavailable')),
    "checkedAt" TIMESTAMPTZ(3) NOT NULL
);

CREATE TABLE "KantechEvent" (
    "id" TEXT PRIMARY KEY,
    "readerId" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "occurredAt" TIMESTAMPTZ(3),
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "captureMode" TEXT NOT NULL CHECK ("captureMode" IN ('observe', 'attendance')),
    "outcome" TEXT
);

CREATE INDEX "KantechEvent_receivedAt_id_idx" ON "KantechEvent" ("receivedAt", "id");
CREATE INDEX "KantechEvent_readerId_receivedAt_id_idx" ON "KantechEvent" ("readerId", "receivedAt", "id");
CREATE INDEX "KantechEvent_outcome_receivedAt_id_idx" ON "KantechEvent" ("outcome", "receivedAt", "id");

CREATE VIEW "KantechReadings" AS
SELECT event."id", event."readerId", event."alias", event."granted", event."occurredAt",
       event."receivedAt", event."captureMode", COALESCE(scan."outcome", event."outcome", 'received') AS "outcome"
FROM "KantechEvent" AS event
LEFT JOIN "AttendanceScan" AS scan ON scan."id" = event."id" AND event."captureMode" = 'attendance';
