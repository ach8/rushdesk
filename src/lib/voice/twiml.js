/**
 * Tiny TwiML composer.
 *
 * We deliberately don't pull in the `twilio` SDK — signature validation is
 * ~30 lines of HMAC and TwiML is XML. Skipping the dependency keeps the
 * cold-start surface lean on Vercel serverless, where every extra package
 * adds invocation latency.
 *
 * See: https://www.twilio.com/docs/voice/twiml
 */

/**
 * Escape text for safe embedding in XML element bodies + attributes.
 * Twilio will otherwise mis-parse a caller name like "AT&T" or an order
 * note containing `<` / `>` / quotes.
 */
export function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function attrs(obj) {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}="${escapeXml(v)}"`)
    .join(' ');
}

/**
 * Build a TwiML `<Response>` from a list of verb descriptors.
 *
 * Example:
 *   buildTwiml([
 *     { type: 'say', text: 'Welcome.', voice: 'Polly.Joanna-Neural' },
 *     { type: 'gather', action: '/api/voice/turn?callSid=CAxxx',
 *       speechTimeout: 'auto', hints: 'burger,fries' },
 *   ]);
 */
export function buildTwiml(verbs) {
  const parts = ['<?xml version="1.0" encoding="UTF-8"?>', '<Response>'];

  for (const verb of verbs) {
    switch (verb.type) {
      case 'say': {
        const a = attrs({
          voice: verb.voice,
          language: verb.language,
        });
        parts.push(`<Say${a ? ' ' + a : ''}>${escapeXml(verb.text)}</Say>`);
        break;
      }
      case 'gather': {
        const a = attrs({
          input: 'speech',
          action: verb.action,
          method: 'POST',
          language: verb.language,
          // `experimental_conversations` is markedly better on spontaneous
          // restaurant-order speech ("uh, lemme get two burgers…") than the
          // default `phone_call` model. Twilio's own docs recommend it for
          // open-ended conversational flows.
          speechModel: verb.speechModel ?? 'experimental_conversations',
          speechTimeout: verb.speechTimeout ?? 'auto',
          // Still fire `action` even if the caller said nothing, so the
          // agent can prompt again rather than leaving dead air.
          actionOnEmptyResult: 'true',
          // Hints bias the STT decoder toward menu vocabulary — makes a
          // real accuracy difference on branded / non-dictionary items.
          hints: verb.hints,
          // Cap total speech length so a rambling caller doesn't tie up
          // a serverless function past its max duration.
          timeout: verb.timeout ?? 5,
        });
        // Nested <Say> lets Twilio start listening immediately while the
        // prompt is still being spoken — the caller can barge in.
        const inner = verb.prompt
          ? `<Say${verb.voice ? ` voice="${escapeXml(verb.voice)}"` : ''}${
              verb.language ? ` language="${escapeXml(verb.language)}"` : ''
            }>${escapeXml(verb.prompt)}</Say>`
          : '';
        parts.push(`<Gather ${a}>${inner}</Gather>`);
        break;
      }
      case 'hangup': {
        parts.push('<Hangup/>');
        break;
      }
      case 'redirect': {
        parts.push(`<Redirect method="POST">${escapeXml(verb.url)}</Redirect>`);
        break;
      }
      case 'pause': {
        parts.push(`<Pause length="${Number(verb.length) || 1}"/>`);
        break;
      }
      default:
        // Unknown verb — skip rather than break the whole response.
        break;
    }
  }

  parts.push('</Response>');
  return parts.join('');
}

/**
 * Standard HTTP response for a TwiML payload. Content-Type is required —
 * Twilio rejects responses without it.
 */
export function twimlResponse(xml) {
  return new Response(xml, {
    status: 200,
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
