-- AlterTable
ALTER TABLE "DocumentMeta" ADD COLUMN     "signingChannel" TEXT;

-- CreateTable
CREATE TABLE "OrganisationSmsSettings" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "senderLabel" VARCHAR(40),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganisationSmsSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamSmsSettings" (
    "id" TEXT NOT NULL,
    "teamId" INTEGER NOT NULL,
    "enabled" BOOLEAN,
    "senderLabel" VARCHAR(40),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamSmsSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecipientSmsChannel" (
    "id" SERIAL NOT NULL,
    "recipientId" INTEGER NOT NULL,
    "phoneE164" VARCHAR(16) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NOT_SENT',
    "lastError" TEXT,
    "sentAt" TIMESTAMP(3),
    "optedOutAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecipientSmsChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SmsMessage" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "recipientId" INTEGER NOT NULL,
    "envelopeId" TEXT NOT NULL,
    "teamId" INTEGER NOT NULL,
    "purpose" TEXT NOT NULL,
    "toE164" VARCHAR(16) NOT NULL,
    "body" TEXT NOT NULL,
    "segments" INTEGER NOT NULL DEFAULT 1,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "providerMessageId" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "isRetryable" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SmsMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SmsOptOut" (
    "phoneE164" VARCHAR(16) NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SmsOptOut_pkey" PRIMARY KEY ("phoneE164")
);

-- CreateTable
CREATE TABLE "SmsFakeOutbox" (
    "id" TEXT NOT NULL,
    "toE164" VARCHAR(16) NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SmsFakeOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrganisationSmsSettings_organisationId_key" ON "OrganisationSmsSettings"("organisationId");

-- CreateIndex
CREATE UNIQUE INDEX "TeamSmsSettings_teamId_key" ON "TeamSmsSettings"("teamId");

-- CreateIndex
CREATE UNIQUE INDEX "RecipientSmsChannel_recipientId_key" ON "RecipientSmsChannel"("recipientId");

-- CreateIndex
CREATE UNIQUE INDEX "SmsMessage_idempotencyKey_key" ON "SmsMessage"("idempotencyKey");

-- CreateIndex
CREATE INDEX "SmsMessage_teamId_createdAt_idx" ON "SmsMessage"("teamId", "createdAt");

-- CreateIndex
CREATE INDEX "SmsMessage_recipientId_createdAt_idx" ON "SmsMessage"("recipientId", "createdAt");

-- CreateIndex
CREATE INDEX "SmsMessage_envelopeId_idx" ON "SmsMessage"("envelopeId");

-- CreateIndex
CREATE INDEX "SmsFakeOutbox_toE164_idx" ON "SmsFakeOutbox"("toE164");

-- AddForeignKey
ALTER TABLE "OrganisationSmsSettings" ADD CONSTRAINT "OrganisationSmsSettings_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamSmsSettings" ADD CONSTRAINT "TeamSmsSettings_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipientSmsChannel" ADD CONSTRAINT "RecipientSmsChannel_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "Recipient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SmsMessage" ADD CONSTRAINT "SmsMessage_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "Recipient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
