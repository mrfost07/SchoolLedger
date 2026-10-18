-- School profile & branding (Phase 1b): the configuration surface for a
-- school's public identity; consumed by the future admin console UI.
ALTER TABLE "schools"
  ADD COLUMN "address" TEXT,
  ADD COLUMN "contactEmail" TEXT,
  ADD COLUMN "contactPhone" TEXT,
  ADD COLUMN "website" TEXT,
  ADD COLUMN "logoUrl" TEXT,
  ADD COLUMN "brandColor" TEXT;

-- Academic policy extensions: INC window, honors thresholds. Defaults mirror
-- the legacy environment defaults so behaviour is unchanged for schools
-- without explicit overrides (the app falls back to env when no row exists).
ALTER TABLE "school_policies"
  ADD COLUMN "incCompletionDays" INTEGER NOT NULL DEFAULT 365,
  ADD COLUMN "honorsSummaMax" DECIMAL(3,2) NOT NULL DEFAULT 1.20,
  ADD COLUMN "honorsMagnaMax" DECIMAL(3,2) NOT NULL DEFAULT 1.45,
  ADD COLUMN "honorsCumLaudeMax" DECIMAL(3,2) NOT NULL DEFAULT 1.75;
