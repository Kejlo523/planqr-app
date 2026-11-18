CREATE TYPE "AuditCategory" AS ENUM ('AUTH', 'TABLETS', 'MESSAGES', 'ADMIN', 'ATTENDANCE', 'KANTECH');

CREATE TABLE "AuditEvent" (
    "id" SERIAL NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "category" "AuditCategory" NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target" TEXT,
    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AuditEvent_occurredAt_idx" ON "AuditEvent"("occurredAt");
CREATE INDEX "AuditEvent_category_id_idx" ON "AuditEvent"("category", "id");

CREATE TABLE "AuditSettings" (
    "id" INTEGER NOT NULL,
    "retentionDays" INTEGER NOT NULL DEFAULT 30,
    CONSTRAINT "AuditSettings_pkey" PRIMARY KEY ("id")
);

INSERT INTO "AuditSettings" ("id") VALUES (1);
