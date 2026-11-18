import type { AuditCategory } from '@prisma/client';
import type { NextFunction, Response } from 'express';
import type { AuthRequest } from './authMiddleware';
import { writeAuditEvent } from '../services/auditLogService';

export function auditAction(
    category: AuditCategory,
    action: string,
    target: (req: AuthRequest) => unknown = (req) => req.params.id,
) {
    return (req: AuthRequest, res: Response, next: NextFunction) => {
        const actor = req.user?.login;
        if (actor) {
            const selectedTarget = target(req);
            res.once('finish', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    writeAuditEvent({ category, action, actor, target: selectedTarget });
                }
            });
        }
        next();
    };
}
