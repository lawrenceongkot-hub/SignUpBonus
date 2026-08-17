import { NextResponse } from 'next/server';
import { authenticateAdminRequest } from '@/lib/auth';
import { checkDatabaseHealth } from '@/lib/prisma';

export async function GET() {
  const isAdmin = await authenticateAdminRequest();
  if (!isAdmin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const health = await checkDatabaseHealth();
  return NextResponse.json(health);
}
