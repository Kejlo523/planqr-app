CREATE TYPE "KantechCaptureMode" AS ENUM ('observe', 'attendance');

CREATE TABLE "KantechCaptureSettings" (
    "id" INTEGER PRIMARY KEY CHECK ("id" = 1),
    "mode" "KantechCaptureMode" NOT NULL,
    "activeFrom" TIMESTAMPTZ(3),
    CHECK (("mode" = 'attendance') = ("activeFrom" IS NOT NULL))
);

ALTER TABLE "KantechEvent" ADD COLUMN "captureActiveFrom" TIMESTAMPTZ(3);
