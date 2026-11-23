CREATE TYPE "ReaderDirection" AS ENUM ('ENTRY', 'EXIT');

ALTER TABLE "AttendanceReader"
    ADD COLUMN "direction" "ReaderDirection",
    ADD COLUMN "exitReaderId" TEXT,
    ADD CONSTRAINT "AttendanceReader_exit_direction_check"
        CHECK ("exitReaderId" IS NULL OR ("direction" IS NOT DISTINCT FROM 'ENTRY' AND "exitReaderId" <> "id")),
    ADD CONSTRAINT "AttendanceReader_exitReaderId_fkey"
        FOREIGN KEY ("exitReaderId") REFERENCES "AttendanceReader" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE UNIQUE INDEX "AttendanceReader_exitReaderId_key" ON "AttendanceReader" ("exitReaderId");

ALTER TABLE "AttendanceScan"
    ADD COLUMN "isLecturer" BOOLEAN,
    ADD COLUMN "readerDirection" "ReaderDirection",
    ADD COLUMN "exitReaderId" TEXT;

ALTER TABLE "AttendanceSession"
    ADD COLUMN "exitReaderId" TEXT,
    ADD COLUMN "lessonGroup" TEXT,
    ADD COLUMN "teacherScheduleId" TEXT,
    ALTER COLUMN "closesAt" DROP NOT NULL;
