-- CreateEnum
CREATE TYPE "EnvelopeCommentAuthorType" AS ENUM ('RECIPIENT', 'TEAM');

-- AlterEnum
ALTER TYPE "WebhookTriggerEvents" ADD VALUE 'DOCUMENT_COMMENT_CREATED';

-- AlterTable
ALTER TABLE "OrganisationGlobalSettings" ADD COLUMN     "commentsEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "commentsSharedThread" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "TeamGlobalSettings" ADD COLUMN     "commentsEnabled" BOOLEAN,
ADD COLUMN     "commentsSharedThread" BOOLEAN;

-- CreateTable
CREATE TABLE "EnvelopeCommentSettings" (
    "envelopeId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "sharedThread" BOOLEAN NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EnvelopeCommentSettings_pkey" PRIMARY KEY ("envelopeId")
);

-- CreateTable
CREATE TABLE "EnvelopeCommentThread" (
    "id" TEXT NOT NULL,
    "envelopeId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "recipientId" INTEGER,
    "recipientEmail" TEXT,
    "recipientName" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedByUserId" INTEGER,
    "teamReadAt" TIMESTAMP(3),
    "lastCommentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EnvelopeCommentThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EnvelopeComment" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "envelopeId" TEXT NOT NULL,
    "authorType" "EnvelopeCommentAuthorType" NOT NULL,
    "authorRecipientId" INTEGER,
    "authorUserId" INTEGER,
    "authorName" TEXT NOT NULL,
    "authorEmail" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EnvelopeComment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EnvelopeCommentThread_envelopeId_key_key" ON "EnvelopeCommentThread"("envelopeId", "key");

-- CreateIndex
CREATE INDEX "EnvelopeComment_envelopeId_idx" ON "EnvelopeComment"("envelopeId");

-- CreateIndex
CREATE INDEX "EnvelopeComment_threadId_createdAt_idx" ON "EnvelopeComment"("threadId", "createdAt");

-- AddForeignKey
ALTER TABLE "EnvelopeCommentSettings" ADD CONSTRAINT "EnvelopeCommentSettings_envelopeId_fkey" FOREIGN KEY ("envelopeId") REFERENCES "Envelope"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnvelopeCommentThread" ADD CONSTRAINT "EnvelopeCommentThread_envelopeId_fkey" FOREIGN KEY ("envelopeId") REFERENCES "Envelope"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnvelopeComment" ADD CONSTRAINT "EnvelopeComment_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "EnvelopeCommentThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;
