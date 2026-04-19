/**
 * POST /api/voice/status — Twilio status callback for call lifecycle events.
 *
 * Twilio POSTs to this endpoint on call state transitions (queued, ringing,
 * in-progress, completed, busy, failed, no-answer, canceled). We only care
 * about terminal statuses so we can free the per-call session blob in
 * Redis promptly — the TTL eventually handles it, but an active kitchen
 * during the dinner rush produces a lot of churn and we shouldn't wait.
 *
 * This endpoint returns an empty 200 (not TwiML). Twilio ignores the body
 * for status callbacks.
 */
import { NextResponse } from 'next/server';
import { getEnv } from '@/lib/env';
import { verifyTwilioSignature, canonicalWebhookUrl } from '@/lib/voice/twilioSignature';
import { getVoiceSessionStore, keyFor } from '@/lib/voice/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TERMINAL_STATUSES = new Set(['completed', 'busy', 'failed', 'no-answer', 'canceled']);

export async function POST(request) {
  const formData = await request.formData().catch(() => null);
  if (!formData) {
    return NextResponse.json({ error: 'Malformed form body.' }, { status: 400 });
  }
  const params = Object.fromEntries(
    [...formData.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : '']),
  );

  let env;
  try {
    env = getEnv();
  } catch {
    // A misconfigured server still needs to return something so Twilio
    // doesn't retry forever; 200 is fine here since there's no ongoing
    // caller experience to protect.
    return new NextResponse(null, { status: 200 });
  }

  const url = canonicalWebhookUrl(request, { publicBaseUrl: env.PUBLIC_BASE_URL });
  const sig = verifyTwilioSignature({
    url,
    params,
    signatureHeader: request.headers.get('x-twilio-signature'),
    authToken: env.TWILIO_AUTH_TOKEN,
  });
  if (!sig.ok) {
    return NextResponse.json({ error: 'Forbidden.' }, { status: 403 });
  }

  const callSid = params.CallSid;
  const status = params.CallStatus;
  if (callSid && status && TERMINAL_STATUSES.has(status)) {
    try {
      await getVoiceSessionStore().delete(keyFor(callSid));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[voice.status] session cleanup failed', err);
    }
  }
  return new NextResponse(null, { status: 200 });
}
