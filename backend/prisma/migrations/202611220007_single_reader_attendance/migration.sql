ALTER TABLE "AttendanceReader"
    ADD COLUMN "singleReader" BOOLEAN NOT NULL DEFAULT false,
    ADD CONSTRAINT "AttendanceReader_single_reader_check"
        CHECK (NOT "singleReader" OR ("direction" IS NOT DISTINCT FROM 'ENTRY' AND "exitReaderId" IS NULL));
