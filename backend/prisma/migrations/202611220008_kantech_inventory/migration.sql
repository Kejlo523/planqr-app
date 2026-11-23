CREATE TABLE "KantechInventory" (
    "id" INTEGER NOT NULL,
    "readers" JSONB NOT NULL,
    "checkedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "KantechInventory_pkey" PRIMARY KEY ("id")
);
