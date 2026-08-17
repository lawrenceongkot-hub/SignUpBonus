import { PrismaClient } from '@prisma/client';

const globalForPrisma = global as unknown as { prisma: PrismaClient | undefined; dbInitialized?: boolean };

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

/**
 * Ensures the PostgreSQL database has all required enum types, tables, and indexes created.
 * Self-healing: Runs idempotent SQL if tables are missing so production never fails on unmigrated databases.
 */
export async function ensureDatabaseInitialized(): Promise<void> {
  if (globalForPrisma.dbInitialized) return;

  try {
    // 1. Create Enum safely
    await prisma.$executeRawUnsafe(`
      DO $$ BEGIN
        CREATE TYPE "SessionStatus" AS ENUM ('WAITING', 'PAIRING', 'CONNECTING', 'CONNECTED', 'SCREEN_SHARING', 'REMOTE_INTERACTION', 'DISCONNECTED', 'FAILED', 'ENDED');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    // 2. Create Tables safely
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "Operator" (
        "id" TEXT NOT NULL,
        "name" TEXT NOT NULL,
        "email" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL,
        CONSTRAINT "Operator_pkey" PRIMARY KEY ("id")
      );
    `);

    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "ApiKey" (
        "id" TEXT NOT NULL,
        "keyHash" TEXT NOT NULL,
        "keyPrefix" TEXT NOT NULL,
        "label" TEXT NOT NULL,
        "operatorId" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "expiresAt" TIMESTAMP(3),
        "revokedAt" TIMESTAMP(3),
        "lastUsedAt" TIMESTAMP(3),
        CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
      );
    `);

    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "Session" (
        "id" TEXT NOT NULL,
        "operatorId" TEXT,
        "apiKeyId" TEXT,
        "pairingTokenHash" TEXT NOT NULL,
        "status" "SessionStatus" NOT NULL DEFAULT 'WAITING',
        "expiresAt" TIMESTAMP(3) NOT NULL,
        "startedAt" TIMESTAMP(3),
        "endedAt" TIMESTAMP(3),
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL,
        CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
      );
    `);

    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "Device" (
        "id" TEXT NOT NULL,
        "sessionId" TEXT NOT NULL,
        "userAgent" TEXT,
        "platform" TEXT,
        "screenResolution" TEXT,
        "ipAddress" TEXT,
        "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "disconnectedAt" TIMESTAMP(3),
        CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
      );
    `);

    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "AuditLog" (
        "id" TEXT NOT NULL,
        "action" TEXT NOT NULL,
        "actorType" TEXT NOT NULL,
        "actorId" TEXT,
        "details" TEXT,
        "ipAddress" TEXT,
        "sessionId" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
      );
    `);

    // 3. Create Indexes safely
    await prisma.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS "Operator_email_key" ON "Operator"("email");
      CREATE UNIQUE INDEX IF NOT EXISTS "ApiKey_keyHash_key" ON "ApiKey"("keyHash");
      CREATE INDEX IF NOT EXISTS "ApiKey_keyHash_idx" ON "ApiKey"("keyHash");
      CREATE INDEX IF NOT EXISTS "ApiKey_revokedAt_idx" ON "ApiKey"("revokedAt");
      CREATE UNIQUE INDEX IF NOT EXISTS "Session_pairingTokenHash_key" ON "Session"("pairingTokenHash");
      CREATE INDEX IF NOT EXISTS "Session_pairingTokenHash_idx" ON "Session"("pairingTokenHash");
      CREATE INDEX IF NOT EXISTS "Session_status_idx" ON "Session"("status");
      CREATE INDEX IF NOT EXISTS "Device_sessionId_idx" ON "Device"("sessionId");
      CREATE INDEX IF NOT EXISTS "AuditLog_action_idx" ON "AuditLog"("action");
      CREATE INDEX IF NOT EXISTS "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");
    `);

    globalForPrisma.dbInitialized = true;
    console.log('[DATABASE] PostgreSQL schema verified & tables initialized successfully.');
  } catch (error) {
    console.warn('[DATABASE] Schema auto-init warning (will retry on demand):', error);
  }
}

export default prisma;
