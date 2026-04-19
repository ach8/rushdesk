/**
 * POST /api/voice/incoming — Twilio Voice webhook for inbound calls.
 *
 * Flow
 * ----
 *   1. Twilio dials our webhook with form-encoded call metadata.
 *   2. We verify the X-Twilio-Signature (HMAC-SHA1) — anything failing
 *      that check is rejected with 403. This is the ONLY thing that
 *      prevents internet randos from injecting orders.
 *   3. We resolve the active business + load its menu.
 *   4. We seed a session in Redis keyed by CallSid.
 *   5. We return TwiML with a greeting + a `<Gather input="speech">` that
 *      posts every caller utterance to `/api/voice/turn`.
 *
 * Security / tenancy notes
 * ------------------------
 *   - The business is resolved server-side (same helper the admin UI
 *     uses). Twilio could carry any `From`/`To` — never trust it for
 *     tenant scoping. (Multi-tenant dial-in routing can later key on the
 *     `To` number against Business.twilioNumber.)
 *   - The initial menu snapshot is baked into the system prompt for the
 *     life of the call. `createOrder` still re-validates every item
 *     against the DB at submit time, so a stale menu item cannot produce
 *     an invalid order.
 */
import { NextResponse } from 'next/server';
import { getEnv } from '@/lib/env';
import { prisma } from '@/lib/prisma';
import { resolveActiveBusinessId } from '@/lib/orders';
import { verifyTwilioSignature, canonicalWebhookUrl } from '@/lib/voice/twilioSignature';
import { buildTwiml, twimlResponse } from '@/lib/voice/twiml';
import { getVoiceSessionStore, createEmptySession, keyFor } from '@/lib/voice/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GENERIC_ERROR_TWIML = buildTwiml([
  {
    type: 'say',
    text: "Sorry, we're unable to take your call right now. Please try again shortly. Goodbye.",
  },
  { type: 'hangup' },
]);

export async function POST(request) {
  // Twilio sends application/x-www-form-urlencoded — NOT JSON.
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
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[voice.incoming] env misconfigured', err);
    return twimlResponse(GENERIC_ERROR_TWIML);
  }

  const url = canonicalWebhookUrl(request, { publicBaseUrl: env.PUBLIC_BASE_URL });
  const sig = verifyTwilioSignature({
    url,
    params,
    signatureHeader: request.headers.get('x-twilio-signature'),
    authToken: env.TWILIO_AUTH_TOKEN,
  });
  if (!sig.ok) {
    // Don't leak which reason — a probing attacker gets nothing useful.
    return NextResponse.json({ error: 'Forbidden.' }, { status: 403 });
  }

  const callSid = params.CallSid;
  if (!callSid) {
    return NextResponse.json({ error: 'Missing CallSid.' }, { status: 400 });
  }

  const businessId = await resolveActiveBusinessId();
  if (!businessId) {
    // No business configured — bail politely, don't leave the caller in
    // an infinite gather loop.
    return twimlResponse(
      buildTwiml([
        {
          type: 'say',
          voice: env.TWILIO_VOICE,
          language: env.TWILIO_LANGUAGE,
          text: 'Sorry, no restaurant is configured on this line yet. Goodbye.',
        },
        { type: 'hangup' },
      ]),
    );
  }

  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { id: true, name: true },
  });
  const businessName = business?.name ?? 'our restaurant';

  // Build a speech-recognition hint list from menu item names so Twilio's
  // STT is primed for branded / non-dictionary items ("McRib", "Shawarma").
  const menuItems = await prisma.menuItem.findMany({
    where: { businessId, available: true },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
    take: 100,
  });
  const hints = menuItems
    .map((m) => m.name)
    .join(',')
    .slice(0, 1024);

  const session = createEmptySession({
    callSid,
    businessId,
    from: params.From || null,
    to: params.To || null,
  });
  try {
    await getVoiceSessionStore().set(keyFor(callSid), session);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[voice.incoming] failed to persist session', err);
    return twimlResponse(GENERIC_ERROR_TWIML);
  }

  const greeting = `Hi! Thanks for calling ${businessName}. What can I get started for you today?`;
  const twiml = buildTwiml([
    {
      type: 'gather',
      // Greeting goes INSIDE the Gather so the caller can barge in
      // while Twilio is speaking — it feels much more fluid.
      prompt: greeting,
      voice: env.TWILIO_VOICE,
      language: env.TWILIO_LANGUAGE,
      action: `/api/voice/turn?callSid=${encodeURIComponent(callSid)}`,
      speechTimeout: 'auto',
      hints,
    },
    // Fallback if the caller is silent through the whole Gather timeout.
    {
      type: 'say',
      voice: env.TWILIO_VOICE,
      language: env.TWILIO_LANGUAGE,
      text: "Sorry, I didn't hear anything. Please call back when you're ready. Goodbye.",
    },
    { type: 'hangup' },
  ]);
  return twimlResponse(twiml);
}
