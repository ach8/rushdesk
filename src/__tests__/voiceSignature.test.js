import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  computeTwilioSignature,
  verifyTwilioSignature,
  canonicalWebhookUrl,
} from '@/lib/voice/twilioSignature';

const AUTH_TOKEN = 'test-auth-token';
const URL = 'https://rushdesk.example.com/api/voice/incoming';

function expected(params) {
  const sorted = Object.keys(params).sort();
  let data = URL;
  for (const k of sorted) data += k + params[k];
  return createHmac('sha1', AUTH_TOKEN).update(data).digest('base64');
}

describe('computeTwilioSignature', () => {
  it('matches the Twilio HMAC-SHA1 recipe for sorted params', () => {
    const params = { CallSid: 'CA1', From: '+15550001', To: '+15550002' };
    expect(computeTwilioSignature(URL, params, AUTH_TOKEN)).toBe(expected(params));
  });

  it('is order-insensitive — callers can pass params in any order', () => {
    const a = { b: '1', a: '2', c: '3' };
    const b = { c: '3', a: '2', b: '1' };
    expect(computeTwilioSignature(URL, a, AUTH_TOKEN)).toBe(
      computeTwilioSignature(URL, b, AUTH_TOKEN),
    );
  });
});

describe('verifyTwilioSignature', () => {
  const params = { CallSid: 'CA1', SpeechResult: 'two burgers please' };
  const good = expected(params);

  it('accepts a well-signed request', () => {
    const res = verifyTwilioSignature({
      url: URL,
      params,
      signatureHeader: good,
      authToken: AUTH_TOKEN,
    });
    expect(res.ok).toBe(true);
  });

  it('rejects a tampered param even with the original signature', () => {
    const res = verifyTwilioSignature({
      url: URL,
      params: { ...params, SpeechResult: 'free food please' },
      signatureHeader: good,
      authToken: AUTH_TOKEN,
    });
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ reason: 'bad-signature' });
  });

  it('rejects a missing signature header', () => {
    const res = verifyTwilioSignature({
      url: URL,
      params,
      signatureHeader: null,
      authToken: AUTH_TOKEN,
    });
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ reason: 'missing-signature' });
  });

  it('fails closed when the auth token is missing — does NOT default open', () => {
    const res = verifyTwilioSignature({
      url: URL,
      params,
      signatureHeader: good,
      authToken: undefined,
    });
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ reason: 'missing-token' });
  });

  it('rejects a signature computed against a different URL (prevents path swaps)', () => {
    const other = createHmac('sha1', AUTH_TOKEN)
      .update(
        'https://evil.example.com/api/voice/incoming' + 'CallSidCA1SpeechResulttwo burgers please',
      )
      .digest('base64');
    const res = verifyTwilioSignature({
      url: URL,
      params,
      signatureHeader: other,
      authToken: AUTH_TOKEN,
    });
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ reason: 'bad-signature' });
  });
});

describe('canonicalWebhookUrl', () => {
  it('prefers PUBLIC_BASE_URL so a proxy-rewritten Host cannot break signing', () => {
    const req = { url: 'https://internal-host.vercel.internal/api/voice/turn?callSid=CA1' };
    const out = canonicalWebhookUrl(req, { publicBaseUrl: 'https://rushdesk.example.com' });
    expect(out).toBe('https://rushdesk.example.com/api/voice/turn?callSid=CA1');
  });

  it('falls back to the request origin when no PUBLIC_BASE_URL is set', () => {
    const req = { url: 'https://rushdesk.example.com/api/voice/incoming' };
    expect(canonicalWebhookUrl(req, {})).toBe('https://rushdesk.example.com/api/voice/incoming');
  });

  it('strips a trailing slash from PUBLIC_BASE_URL', () => {
    const req = { url: 'https://x/api/voice/incoming' };
    expect(canonicalWebhookUrl(req, { publicBaseUrl: 'https://rushdesk.example.com/' })).toBe(
      'https://rushdesk.example.com/api/voice/incoming',
    );
  });
});
