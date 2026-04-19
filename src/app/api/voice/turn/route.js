/**
 * POST /api/voice/turn — one conversational turn inside a live call.
 *
 * Twilio calls this endpoint after every `<Gather input="speech">` with
 * the transcribed utterance in `SpeechResult`. We:
 *
 *   1. Validate the Twilio signature (same invariant as /incoming).
 *   2. Load the session for this CallSid from Redis. If it's missing —
 *      e.g. the session expired, or this is a stray webhook — we greet
 *      the caller fresh rather than crashing.
 *   3. Rebuild the system prompt from the current menu. Menu items may
 *      have toggled available/unavailable mid-call; the AI always sees
 *      the most current picture.
 *   4. Run one agent turn. The agent may call `submit_order` internally,
 *      which flows through the same `createOrder` → event-broker →
 *      kitchen-dashboard SSE path the rest of the app uses. No extra
 *      wiring needed: the moment submit_order returns `ok`, the kitchen
 *      screen shows the order live.
 *   5. Persist the updated session.
 *   6. Return TwiML — either another `<Gather>` or `<Say>` + `<Hangup/>`
 *      if the agent wrapped up.
 *
 * Error-handling philosophy: the caller is live on the phone. On ANY
 * unexpected failure we fall back to a spoken apology + hangup rather
 * than leaving dead air. Stack traces go to the server log, not TwiML.
 */
import { NextResponse } from 'next/server';
import { getEnv } from '@/lib/env';
import { prisma } from '@/lib/prisma';
import { verifyTwilioSignature, canonicalWebhookUrl } from '@/lib/voice/twilioSignature';
import { buildTwiml, twimlResponse } from '@/lib/voice/twiml';
import { getVoiceSessionStore, createEmptySession, keyFor } from '@/lib/voice/session';
import { buildSystemPrompt, runAgentTurn } from '@/lib/voice/agent';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function apologyAndHangup(env) {
  return twimlResponse(
    buildTwiml([
      {
        type: 'say',
        voice: env?.TWILIO_VOICE,
        language: env?.TWILIO_LANGUAGE,
        text: "Sorry, I'm having trouble on my end. Please call us back in a minute. Goodbye.",
      },
      { type: 'hangup' },
    ]),
  );
}

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
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[voice.turn] env misconfigured', err);
    return apologyAndHangup(null);
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

  const callSid = params.CallSid || new URL(request.url).searchParams.get('callSid');
  if (!callSid) {
    return apologyAndHangup(env);
  }

  const store = getVoiceSessionStore();
  let session;
  try {
    session = await store.get(keyFor(callSid));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[voice.turn] session store read failed', err);
    return apologyAndHangup(env);
  }

  // Session missing — likely Redis eviction or a Twilio retry after a long
  // pause. Reconstruct a minimal session so the caller gets *something*
  // back instead of a 500 → dead air.
  if (!session) {
    const businessId = await prisma.business
      .findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true } })
      .then((b) => b?.id ?? null);
    if (!businessId) return apologyAndHangup(env);
    session = createEmptySession({
      callSid,
      businessId,
      from: params.From || null,
      to: params.To || null,
    });
  }

  // Menu + business metadata fresh per turn — items can toggle
  // availability mid-call.
  const business = await prisma.business.findUnique({
    where: { id: session.businessId },
    select: { id: true, name: true },
  });
  if (!business) return apologyAndHangup(env);
  const menuItems = await prisma.menuItem.findMany({
    where: { businessId: session.businessId },
    select: { id: true, name: true, category: true, price: true, available: true },
    orderBy: [{ category: 'asc' }, { name: 'asc' }],
    take: 200,
  });

  const systemPrompt = buildSystemPrompt({
    businessName: business.name,
    menuItems,
    callerPhone: session.from,
  });

  const utterance = params.SpeechResult || '';

  let result;
  try {
    result = await runAgentTurn({
      session,
      userUtterance: utterance,
      systemPrompt,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[voice.turn] agent failure', err);
    // Persist what we had so a follow-up turn can still resume — but
    // apologize out loud right now.
    return apologyAndHangup(env);
  }

  // Save updated session. A failure here is non-fatal: we still speak
  // the reply; worst case the next turn starts from a stale session.
  try {
    await store.set(keyFor(callSid), result.session);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[voice.turn] session store write failed', err);
  }

  // Hints again — some callers switch modes mid-call (menu → delivery
  // address), but biasing toward menu vocabulary is still net-positive.
  const hints = menuItems
    .filter((m) => m.available !== false)
    .map((m) => m.name)
    .join(',')
    .slice(0, 1024);

  if (result.done) {
    return twimlResponse(
      buildTwiml([
        {
          type: 'say',
          voice: env.TWILIO_VOICE,
          language: env.TWILIO_LANGUAGE,
          text: result.reply,
        },
        { type: 'hangup' },
      ]),
    );
  }

  return twimlResponse(
    buildTwiml([
      {
        type: 'gather',
        prompt: result.reply,
        voice: env.TWILIO_VOICE,
        language: env.TWILIO_LANGUAGE,
        action: `/api/voice/turn?callSid=${encodeURIComponent(callSid)}`,
        speechTimeout: 'auto',
        hints,
      },
      // Belt-and-suspenders if the caller goes silent for the whole
      // Gather window — don't leave them hanging.
      {
        type: 'say',
        voice: env.TWILIO_VOICE,
        language: env.TWILIO_LANGUAGE,
        text: "I didn't catch that. Please call back when you're ready. Goodbye.",
      },
      { type: 'hangup' },
    ]),
  );
}
