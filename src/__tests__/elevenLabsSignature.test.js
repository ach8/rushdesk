import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  computeElevenLabsSignature,
  parseSignatureHeader,
  verifyElevenLabsSignature,
} from '@/lib/voice/elevenLabsSignature';

const SECRET = 'whsec_test_secret';
const BODY = '{"conversation_id":"conv_1","items":[{"menu_item_id":"mi_1","quantity":2}]}';

function sign(ts, body = BODY, secret = SECRET) {
  const mac = createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
  return `t=${ts},v0=${mac}`;
}

describe('parseSignatureHeader', () => {
  it('parses t= and v0= pairs', () => {
    expect(parseSignatureHeader('t=123,v0=abc')).toEqual({
      timestamp: '123',
      signatures: ['abc'],
    });
  });

  it('supports multiple v0 entries (key rotation)', () => {
    expect(parseSignatureHeader('t=123,v0=a,v0=b').signatures).toEqual(['a', 'b']);
  });

  it('returns null on missing parts', () => {
    expect(parseSignatureHeader('v0=abc')).toBeNull();
    expect(parseSignatureHeader('t=123')).toBeNull();
    expect(parseSignatureHeader('')).toBeNull();
    expect(parseSignatureHeader(null)).toBeNull();
  });
});

describe('computeElevenLabsSignature', () => {
  it('matches HMAC-SHA256(hex) over "<timestamp>.<body>"', () => {
    const expected = createHmac('sha256', SECRET).update(`100.${BODY}`).digest('hex');
    expect(computeElevenLabsSignature('100', BODY, SECRET)).toBe(expected);
  });
});

describe('verifyElevenLabsSignature', () => {
  const now = () => 1_700_000_000;

  it('accepts a well-signed request within the tolerance window', () => {
    const header = sign(now());
    const res = verifyElevenLabsSignature({
      rawBody: BODY,
      signatureHeader: header,
      secret: SECRET,
      now,
    });
    expect(res.ok).toBe(true);
  });

  it('rejects a tampered body even with the original signature', () => {
    const header = sign(now());
    const res = verifyElevenLabsSignature({
      rawBody: BODY.replace('"quantity":2', '"quantity":200'),
      signatureHeader: header,
      secret: SECRET,
      now,
    });
    expect(res).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('rejects a signature computed with a different secret', () => {
    const header = sign(now(), BODY, 'other-secret');
    const res = verifyElevenLabsSignature({
      rawBody: BODY,
      signatureHeader: header,
      secret: SECRET,
      now,
    });
    expect(res).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('rejects a stale timestamp outside the tolerance window (replay protection)', () => {
    const old = now() - 60 * 60; // 1h ago, default tolerance is 30m
    const header = sign(old);
    const res = verifyElevenLabsSignature({
      rawBody: BODY,
      signatureHeader: header,
      secret: SECRET,
      now,
    });
    expect(res).toEqual({ ok: false, reason: 'stale-timestamp' });
  });

  it('rejects a missing signature header', () => {
    const res = verifyElevenLabsSignature({
      rawBody: BODY,
      signatureHeader: null,
      secret: SECRET,
      now,
    });
    expect(res).toEqual({ ok: false, reason: 'missing-signature' });
  });

  it('rejects a malformed header', () => {
    const res = verifyElevenLabsSignature({
      rawBody: BODY,
      signatureHeader: 'garbage',
      secret: SECRET,
      now,
    });
    expect(res).toEqual({ ok: false, reason: 'malformed-signature' });
  });

  it('fails closed when the secret is missing — does NOT default open', () => {
    const header = sign(now());
    const res = verifyElevenLabsSignature({
      rawBody: BODY,
      signatureHeader: header,
      secret: undefined,
      now,
    });
    expect(res).toEqual({ ok: false, reason: 'missing-secret' });
  });

  it('accepts when any one v0 entry matches (key rotation)', () => {
    const ts = now();
    const good = computeElevenLabsSignature(String(ts), BODY, SECRET);
    const header = `t=${ts},v0=deadbeef,v0=${good}`;
    const res = verifyElevenLabsSignature({
      rawBody: BODY,
      signatureHeader: header,
      secret: SECRET,
      now,
    });
    expect(res.ok).toBe(true);
  });
});
