import { prisma } from './prisma';

export type AuditAction =
  | 'ADMIN_LOGIN_SUCCESS'
  | 'ADMIN_LOGIN_FAILED'
  | 'API_KEY_GENERATED'
  | 'API_KEY_REVOKED'
  | 'OPERATOR_AUTH_SUCCESS'
  | 'OPERATOR_AUTH_FAILED'
  | 'SESSION_CREATED'
  | 'SESSION_PAIRING_ATTEMPT'
  | 'SESSION_PAIRING_AUTHORIZED'
  | 'SESSION_PAIRING_REJECTED'
  | 'SESSION_STARTED'
  | 'SESSION_STOPPED_BY_OPERATOR'
  | 'SESSION_STOPPED_BY_USER'
  | 'SESSION_EXPIRED'
  | 'DEVICE_CONNECTED'
  | 'DEVICE_DISCONNECTED';

export async function logAuditEvent(params: {
  action: AuditAction;
  actorType: 'ADMIN' | 'OPERATOR' | 'DEVICE' | 'SYSTEM';
  actorId?: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
  sessionId?: string;
}) {
  const timestamp = new Date().toISOString();
  const detailsStr = params.details ? JSON.stringify(params.details) : undefined;

  // Always log to stdout for server log observability
  console.log(`[AUDIT] [${timestamp}] [${params.action}] [${params.actorType}] Actor: ${params.actorId || 'N/A'} - Session: ${params.sessionId || 'N/A'} - IP: ${params.ipAddress || 'N/A'}`);

  try {
    // Attempt to persist to database if available
    await prisma.auditLog.create({
      data: {
        action: params.action,
        actorType: params.actorType,
        actorId: params.actorId,
        details: detailsStr,
        ipAddress: params.ipAddress,
        sessionId: params.sessionId,
      },
    });
  } catch (error) {
    // Fail-safe: don't crash app if DB write fails during audit logging
    console.error(`[AUDIT ERROR] Failed to save audit log to DB:`, error);
  }
}
