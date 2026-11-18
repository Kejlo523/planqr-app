-- CreateTable
CREATE TABLE "AttendanceReader" (
    "id" TEXT NOT NULL,
    "buildingId" TEXT NOT NULL,
    "roomNumber" TEXT NOT NULL,
    "label" TEXT NOT NULL,

    CONSTRAINT "AttendanceReader_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceCard" (
    "alias" TEXT NOT NULL,
    "login" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "album" TEXT,
    "scheduleId" TEXT,

    CONSTRAINT "AttendanceCard_pkey" PRIMARY KEY ("alias")
);

-- CreateTable
CREATE TABLE "AttendanceScan" (
    "id" TEXT NOT NULL,
    "readerId" TEXT NOT NULL,
    "roomKey" TEXT NOT NULL,
    "buildingId" TEXT NOT NULL,
    "roomNumber" TEXT NOT NULL,
    "roomLabel" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "login" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "album" TEXT,
    "scheduleId" TEXT,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "candidates" JSONB,
    "selectedKey" TEXT,
    "retryAt" TIMESTAMPTZ(3),
    "resolution" TEXT NOT NULL DEFAULT 'none',
    "outcome" TEXT NOT NULL DEFAULT 'received',

    CONSTRAINT "AttendanceScan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceSession" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "lessonId" TEXT NOT NULL,
    "lessonStart" TIMESTAMPTZ(3) NOT NULL,
    "lessonEnd" TIMESTAMPTZ(3) NOT NULL,
    "title" TEXT NOT NULL,
    "ownerLogin" TEXT NOT NULL,
    "ownerName" TEXT NOT NULL,
    "roomKey" TEXT NOT NULL,
    "readerId" TEXT NOT NULL,
    "roomLabel" TEXT NOT NULL,
    "openedAt" TIMESTAMPTZ(3) NOT NULL,
    "closesAt" TIMESTAMPTZ(3) NOT NULL,
    "manualClosedAt" TIMESTAMPTZ(3),
    "sentAt" TIMESTAMPTZ(3),
    "voided" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "AttendanceSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceMember" (
    "id" SERIAL NOT NULL,
    "sessionId" INTEGER NOT NULL,
    "login" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "album" TEXT,
    "firstAt" TIMESTAMPTZ(3) NOT NULL,
    "lastAt" TIMESTAMPTZ(3) NOT NULL,
    "count" INTEGER NOT NULL,
    "manual" BOOLEAN NOT NULL DEFAULT false,
    "removed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "AttendanceMember_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AttendanceScan_roomKey_occurredAt_id_idx" ON "AttendanceScan"("roomKey", "occurredAt", "id");

-- CreateIndex
CREATE INDEX "AttendanceScan_resolution_retryAt_idx" ON "AttendanceScan"("resolution", "retryAt");

-- CreateIndex
CREATE INDEX "AttendanceScan_login_outcome_idx" ON "AttendanceScan"("login", "outcome");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceSession_key_key" ON "AttendanceSession"("key");

-- CreateIndex
CREATE INDEX "AttendanceSession_roomKey_openedAt_idx" ON "AttendanceSession"("roomKey", "openedAt");

-- CreateIndex
CREATE INDEX "AttendanceSession_ownerLogin_lessonId_lessonStart_idx" ON "AttendanceSession"("ownerLogin", "lessonId", "lessonStart");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceMember_sessionId_login_key" ON "AttendanceMember"("sessionId", "login");

-- AddForeignKey
ALTER TABLE "AttendanceMember" ADD CONSTRAINT "AttendanceMember_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AttendanceSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
