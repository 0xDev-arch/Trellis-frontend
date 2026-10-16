import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  deniedResponse,
  requireActor,
} from '@/lib/auth';
import { checkPermission } from '@/lib/permissions';
import {
  canPerformActionInImpersonation,
  endImpersonation,
  getImpersonationAuditLog,
  getImpersonationSession,
  getSessionsForAdmin,
  recordImpersonationAction,
  startImpersonation,
} from '@/lib/impersonation';

export const runtime = 'nodejs';

const StartSchema = z.object({
  action: z.literal('start'),
  targetUserId: z.string().trim().min(1).max(200),
  scope: z.enum(['read_only', 'limited_write', 'debug']).default('read_only'),
  durationMinutes: z.number().int().min(1).max(30).default(15),
  reason: z.string().trim().min(3).max(500),
  confirm: z.literal(true),
});

const EndSchema = z.object({
  action: z.literal('end'),
  sessionId: z.string().min(1).max(200),
  reason: z.string().trim().max(500).optional(),
  confirm: z.literal(true),
});

const AuthorizeSchema = z.object({
  action: z.literal('authorize'),
  sessionId: z.string().min(1).max(200),
  requestedAction: z.string().trim().min(1).max(100),
  resource: z.string().trim().min(1).max(300),
  confirm: z.literal(true),
});

const AuditSchema = z.object({
  action: z.literal('audit'),
  sessionId: z.string().min(1).max(200),
  confirm: z.literal(true),
});

const RequestSchema = z.discriminatedUnion('action', [
  StartSchema,
  EndSchema,
  AuthorizeSchema,
  AuditSchema,
]);

function permissionFailure(
  action: 'impersonate_user' | 'view_audit_logs',
  actor: { id: string; role: 'guest' | 'viewer' | 'contributor' | 'maintainer' | 'admin' },
  confirmed: boolean,
) {
  const decision = checkPermission(action, {
    role: actor.role,
    actorId: actor.id,
    resourceScope: 'global',
    context: { confirmed },
  });
  return decision.allowed ? null : deniedResponse(decision);
}

function ownedSession(sessionId: string, actorId: string) {
  const session = getImpersonationSession(sessionId);
  // Avoid disclosing whether another administrator has an active support session.
  if (!session || session.adminId !== actorId) return null;
  return session;
}

export async function GET(request: NextRequest) {
  const identity = await requireActor(request);
  if (!identity.ok) return identity.response;

  const denial = permissionFailure('view_audit_logs', identity.actor, false);
  if (denial) return denial;

  const sessions = getSessionsForAdmin(identity.actor.id).map((session) => ({
    id: session.id,
    targetUserId: session.targetUserId,
    startedAt: session.startedAt,
    expiresAt: session.expiresAt,
    scope: session.scope,
    isActive: session.isActive,
    reason: session.reason,
  }));
  return NextResponse.json({ sessions });
}

export async function POST(request: NextRequest) {
  const identity = await requireActor(request);
  if (!identity.ok) return identity.response;

  const body: unknown = await request.json().catch(() => null);
  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid support-access request', details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const denial = permissionFailure('impersonate_user', identity.actor, parsed.data.confirm);
  if (denial) return denial;

  try {
    if (parsed.data.action === 'start') {
      const session = startImpersonation(
        identity.actor.id,
        parsed.data.targetUserId,
        parsed.data.scope,
        parsed.data.durationMinutes,
        {
          reason: parsed.data.reason,
          userAgent: request.headers.get('user-agent') ?? undefined,
        },
      );
      return NextResponse.json(
        {
          session: {
            id: session.id,
            targetUserId: session.targetUserId,
            startedAt: session.startedAt,
            expiresAt: session.expiresAt,
            scope: session.scope,
          },
          targetNotice: `A support session is active with ${session.scope} access until ${session.expiresAt}.`,
        },
        { status: 201 },
      );
    }

    const session = ownedSession(parsed.data.sessionId, identity.actor.id);
    if (!session) {
      return NextResponse.json({ error: 'Support session not found' }, { status: 404 });
    }

    if (parsed.data.action === 'end') {
      endImpersonation(parsed.data.sessionId, parsed.data.reason ?? 'Ended by administrator');
      return NextResponse.json({ ended: true, sessionId: parsed.data.sessionId });
    }

    if (parsed.data.action === 'audit') {
      return NextResponse.json({ events: getImpersonationAuditLog(parsed.data.sessionId) });
    }

    const allowed = canPerformActionInImpersonation(
      parsed.data.sessionId,
      parsed.data.requestedAction,
    );
    recordImpersonationAction(
      parsed.data.sessionId,
      parsed.data.requestedAction,
      parsed.data.resource,
      allowed ? 'success' : 'blocked',
    );
    return NextResponse.json({
      allowed,
      sessionId: parsed.data.sessionId,
      notice: 'Support actions are scoped and recorded in the session audit trail.',
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Support access operation failed' },
      { status: 400 },
    );
  }
}
