import { describe, it, expect, vi } from 'vitest';
import { handleSubmitOrder } from '@/app/api/voice/submit-order/route';
import { computeElevenLabsSignature } from '@/lib/voice/elevenLabsSignature';
import { createInMemoryRateLimiter } from '@/lib/voice/rateLimit';

const SECRET = 'whsec_test_secret';
const ENV = {
  ELEVENLABS_WEBHOOK_SECRET: SECRET,
  VOICE_ORDER_DAILY_LIMIT: 2,
};

function signedRequest(payload) {
  const rawBody = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  const mac = computeElevenLabsSignature(ts, rawBody, SECRET);
  return new Request('https://rushdesk.test/api/voice/submit-order', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'elevenlabs-signature': `t=${ts},v0=${mac}`,
    },
    body: rawBody,
  });
}

/**
 * Background scheduler stub: capture the promise so each test can
 * `await flush()` to deterministically observe the background work.
 */
function backgroundCapture() {
  const pending = [];
  return {
    runAfterResponse: (p) => {
      pending.push(p);
    },
    flush: () => Promise.all(pending.splice(0)),
  };
}

function baseDeps(overrides = {}) {
  const bg = backgroundCapture();
  return {
    bg,
    deps: {
      env: ENV,
      rateLimiter: createInMemoryRateLimiter(),
      resolveBusinessId: async () => 'biz_1',
      executeTool: vi.fn(async () => ({ ok: true, order_id: 'order_abc123', total: 22.5 })),
      runAfterResponse: bg.runAfterResponse,
      ...overrides,
    },
  };
}

const ORDER_BODY = {
  conversation_id: 'conv_1',
  caller_phone: '+15551234567',
  order_type: 'TAKEAWAY',
  items: [{ menu_item_id: 'mi_1', quantity: 1 }],
};

describe('POST /api/voice/submit-order', () => {
  it('rejects an unsigned request with 403 and never schedules background work', async () => {
    const rateLimiter = { hit: vi.fn() };
    const { bg, deps } = baseDeps({ rateLimiter });
    const res = await handleSubmitOrder(
      new Request('https://rushdesk.test/api/voice/submit-order', {
        method: 'POST',
        body: JSON.stringify(ORDER_BODY),
      }),
      deps,
    );
    expect(res.status).toBe(403);
    expect(rateLimiter.hit).not.toHaveBeenCalled();
    await bg.flush();
    expect(deps.executeTool).not.toHaveBeenCalled();
  });

  it('refuses anonymous / withheld caller IDs synchronously (no background work)', async () => {
    const { bg, deps } = baseDeps();
    const res = await handleSubmitOrder(
      signedRequest({ ...ORDER_BODY, caller_phone: 'anonymous' }),
      deps,
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ ok: false, code: 'caller_id_required' });
    await bg.flush();
    expect(deps.executeTool).not.toHaveBeenCalled();
  });

  it('acks immediately with 202 before createOrder resolves', async () => {
    let resolveCreate;
    const executeTool = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveCreate = () => resolve({ ok: true, order_id: 'order_abc123' });
        }),
    );
    const { bg, deps } = baseDeps({ executeTool });

    const res = await handleSubmitOrder(signedRequest(ORDER_BODY), deps);
    // Response is already in hand even though createOrder is still pending.
    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json).toMatchObject({ ok: true, status: 'accepted' });
    // No DB-derived fields leak into the instant ack.
    expect(json).not.toHaveProperty('order_id');
    expect(json).not.toHaveProperty('total');

    // Background work was scheduled and completes once we let it.
    expect(executeTool).toHaveBeenCalledTimes(1);
    resolveCreate();
    await bg.flush();
  });

  it('passes ctx (businessId, conversationId, callerPhone) through to the background tool dispatcher', async () => {
    const { bg, deps } = baseDeps();
    await handleSubmitOrder(signedRequest(ORDER_BODY), deps);
    await bg.flush();
    expect(deps.executeTool).toHaveBeenCalledWith({
      name: 'submit_order',
      args: expect.objectContaining({ conversation_id: 'conv_1' }),
      ctx: {
        businessId: 'biz_1',
        conversationId: 'conv_1',
        callerPhone: '+15551234567',
      },
    });
  });

  it('still acks ok:true even if background createOrder later fails (logged, not surfaced)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { bg, deps } = baseDeps({
      executeTool: vi.fn(async () => ({ ok: false, code: 'menu_item_unavailable', error: 'nope' })),
    });
    const res = await handleSubmitOrder(signedRequest(ORDER_BODY), deps);
    expect((await res.json()).ok).toBe(true);
    await bg.flush();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('allows the first two attempts and denies the third from the same caller (gate is synchronous)', async () => {
    const { bg, deps } = baseDeps();

    const r1 = await handleSubmitOrder(signedRequest(ORDER_BODY), deps);
    expect((await r1.json()).ok).toBe(true);

    const r2 = await handleSubmitOrder(signedRequest(ORDER_BODY), deps);
    expect((await r2.json()).ok).toBe(true);

    const r3 = await handleSubmitOrder(signedRequest(ORDER_BODY), deps);
    expect(r3.status).toBe(200);
    expect(r3.headers.get('Retry-After')).toBeTruthy();
    const j3 = await r3.json();
    expect(j3).toMatchObject({ ok: false, code: 'rate_limited', limit: 2 });
    expect(j3.error).toMatch(/daily limit/i);

    await bg.flush();
    // executeTool was only scheduled for the two allowed attempts.
    expect(deps.executeTool).toHaveBeenCalledTimes(2);
  });

  it('does not penalize a different caller for someone else hitting the limit', async () => {
    const { bg, deps } = baseDeps();
    await handleSubmitOrder(signedRequest(ORDER_BODY), deps);
    await handleSubmitOrder(signedRequest(ORDER_BODY), deps);
    const other = await handleSubmitOrder(
      signedRequest({ ...ORDER_BODY, caller_phone: '+15557654321' }),
      deps,
    );
    expect((await other.json()).ok).toBe(true);
    await bg.flush();
  });

  it('treats formatting variants of the same number as one caller', async () => {
    const { bg, deps } = baseDeps();
    await handleSubmitOrder(signedRequest({ ...ORDER_BODY, caller_phone: '+15551234567' }), deps);
    await handleSubmitOrder(
      signedRequest({ ...ORDER_BODY, caller_phone: '1 (555) 123-4567' }),
      deps,
    );
    const r3 = await handleSubmitOrder(
      signedRequest({ ...ORDER_BODY, caller_phone: '1-555-123-4567' }),
      deps,
    );
    const j3 = await r3.json();
    expect(j3.code).toBe('rate_limited');
    await bg.flush();
  });

  it('fails closed (denies) when the rate limiter itself errors', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { bg, deps } = baseDeps({
      rateLimiter: {
        hit: vi.fn(async () => {
          throw new Error('redis down');
        }),
      },
    });
    const res = await handleSubmitOrder(signedRequest(ORDER_BODY), deps);
    const json = await res.json();
    expect(json).toMatchObject({ ok: false, code: 'rate_limit_unavailable' });
    await bg.flush();
    expect(deps.executeTool).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
