CREATE TABLE "AttendanceReaderGroup" (
    "id" SERIAL PRIMARY KEY,
    "name" TEXT NOT NULL
);

ALTER TABLE "AttendanceReader"
    ADD COLUMN "groupId" INTEGER REFERENCES "AttendanceReaderGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    ADD COLUMN "deviceId" TEXT;
CREATE INDEX "AttendanceReader_groupId_idx" ON "AttendanceReader"("groupId");

ALTER TABLE "AttendanceScan" ADD COLUMN "rulesVersion" INTEGER NOT NULL DEFAULT 1;
