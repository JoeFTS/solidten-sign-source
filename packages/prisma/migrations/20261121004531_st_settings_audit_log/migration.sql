-- CreateTable
CREATE TABLE "StSettingsAuditLog" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "teamId" INTEGER,
    "setting" TEXT NOT NULL,
    "oldValue" JSONB,
    "newValue" JSONB,
    "userId" INTEGER,
    "userEmail" TEXT NOT NULL,
    "userName" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StSettingsAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StSettingsAuditLog_organisationId_createdAt_idx" ON "StSettingsAuditLog"("organisationId", "createdAt");

-- CreateIndex
CREATE INDEX "StSettingsAuditLog_teamId_createdAt_idx" ON "StSettingsAuditLog"("teamId", "createdAt");
