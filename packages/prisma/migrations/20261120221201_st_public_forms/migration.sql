-- CreateTable
CREATE TABLE "StPublicForm" (
    "id" TEXT NOT NULL,
    "directLinkId" TEXT NOT NULL,
    "opensAt" TIMESTAMP(3),
    "closesAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "maxSubmissions" INTEGER,
    "submissionCount" INTEGER NOT NULL DEFAULT 0,
    "introText" TEXT,
    "thankYouMessage" TEXT,
    "redirectUrl" TEXT,
    "requireVerifiedEmail" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StPublicForm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StPublicFormSubmission" (
    "id" TEXT NOT NULL,
    "formId" TEXT NOT NULL,
    "envelopeId" TEXT NOT NULL,
    "submitterEmail" TEXT NOT NULL,
    "submitterName" TEXT,
    "emailVerified" BOOLEAN NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StPublicFormSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StPublicForm_directLinkId_key" ON "StPublicForm"("directLinkId");

-- CreateIndex
CREATE UNIQUE INDEX "StPublicFormSubmission_envelopeId_key" ON "StPublicFormSubmission"("envelopeId");

-- CreateIndex
CREATE INDEX "StPublicFormSubmission_formId_createdAt_idx" ON "StPublicFormSubmission"("formId", "createdAt");

-- AddForeignKey
ALTER TABLE "StPublicForm" ADD CONSTRAINT "StPublicForm_directLinkId_fkey" FOREIGN KEY ("directLinkId") REFERENCES "TemplateDirectLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StPublicFormSubmission" ADD CONSTRAINT "StPublicFormSubmission_formId_fkey" FOREIGN KEY ("formId") REFERENCES "StPublicForm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Existing direct links on version 2 templates get the safe defaults (verified email on, no limits).
INSERT INTO "StPublicForm" ("id", "directLinkId", "requireVerifiedEmail", "updatedAt")
SELECT gen_random_uuid()::text, "TemplateDirectLink"."id", true, CURRENT_TIMESTAMP
FROM "TemplateDirectLink"
JOIN "Envelope" ON "Envelope"."id" = "TemplateDirectLink"."envelopeId"
WHERE "Envelope"."internalVersion" = 2;
