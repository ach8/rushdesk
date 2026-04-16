import { PrismaClient } from '@prisma/client';

// Reuse a single PrismaClient instance across hot reloads in dev.
const globalForPrisma = globalThis;

export const prisma =
  globalForPrisma.__rushdeskPrisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__rushdeskPrisma = prisma;
}
