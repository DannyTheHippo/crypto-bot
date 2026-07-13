import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { TypedConfigService } from '../../../config/environment/typed-config.service';

export const ARMING_TOKEN_HEADER = 'x-arming-token';

// §10b arm-hardening: second transport-layer factor on top of the HMAC challenge/response (hmac.ts)
// — a captured/replayed HMAC proof still needs this header to reach the handler at all. Read
// directly off process.env (never through TypedConfigService/AppConfig), mirroring
// SENTIMENT_FEED_API_KEY's own header comment in app.module.ts: the token is a shared secret, never
// logged or folded into configHash, and re-read per request so a deployment can rotate it without a
// restart. Absent env is fail-CLOSED only where it matters — a live boot must never arm without this
// guard configured — and a no-op everywhere else (paper/testnet get no extra friction on the demo
// stack, matching the four-gates' own "only live is gated" posture).
@Injectable()
export class ArmingTransportGuard implements CanActivate {
  constructor(private readonly config: TypedConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const token = process.env['ARMING_TRANSPORT_TOKEN'];
    if (token === undefined || token === '') {
      return this.config.mode.configMode !== 'live';
    }
    const req = context.switchToHttp().getRequest<IncomingMessage>();
    const raw = req.headers[ARMING_TOKEN_HEADER];
    const candidate = Array.isArray(raw) ? raw[0] : raw;
    if (candidate === undefined) return false;
    return constantTimeEqual(token, candidate);
  }
}

// Hashes both sides to a fixed-length digest before comparing — timingSafeEqual throws on unequal
// buffer lengths, and an attacker-controlled candidate is free to be any length (unlike hmac.ts's
// verifyArmingHmac, which can fix the expected length to 64 hex chars because it is comparing two
// hex-encoded SHA-256 digests specifically).
function constantTimeEqual(expected: string, candidate: string): boolean {
  const expectedHash = createHash('sha256').update(expected).digest();
  const candidateHash = createHash('sha256').update(candidate).digest();
  return timingSafeEqual(expectedHash, candidateHash);
}
