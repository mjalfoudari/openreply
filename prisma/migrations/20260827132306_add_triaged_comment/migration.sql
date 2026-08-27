-- CreateEnum
CREATE TYPE "CommentPlatform" AS ENUM ('INSTAGRAM', 'YOUTUBE');

-- CreateEnum
CREATE TYPE "CommentClassification" AS ENUM ('KEYWORD_MATCH', 'GENUINE', 'LOW_EFFORT', 'SPAM');

-- CreateEnum
CREATE TYPE "CommentStatus" AS ENUM ('PENDING', 'HANDLED', 'DISMISSED');

-- CreateTable
CREATE TABLE "TriagedComment" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "platform" "CommentPlatform" NOT NULL DEFAULT 'INSTAGRAM',
    "instagramAccountId" TEXT,
    "mediaId" TEXT NOT NULL,
    "mediaThumbnailUrl" TEXT,
    "mediaCaption" TEXT,
    "commentId" TEXT NOT NULL,
    "authorUsername" TEXT,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "classification" "CommentClassification" NOT NULL,
    "status" "CommentStatus" NOT NULL DEFAULT 'PENDING',
    "repliedText" TEXT,
    "handledAt" TIMESTAMP(3),
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TriagedComment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TriagedComment_commentId_key" ON "TriagedComment"("commentId");

-- CreateIndex
CREATE INDEX "TriagedComment_workspaceId_status_createdAt_idx" ON "TriagedComment"("workspaceId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "TriagedComment_mediaId_idx" ON "TriagedComment"("mediaId");

-- AddForeignKey
ALTER TABLE "TriagedComment" ADD CONSTRAINT "TriagedComment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriagedComment" ADD CONSTRAINT "TriagedComment_instagramAccountId_fkey" FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
