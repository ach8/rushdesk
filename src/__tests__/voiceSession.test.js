import { describe, it, expect, vi } from 'vitest';
import {
  createInMemorySessionStore,
  createRedisSessionStore,
  createEmptySession,
  keyFor,
} from '@/lib/voice/session';
import { buildTwiml, escapeXml } from '@/lib/voice/twiml';

describe('createEmptySession', () => {
  it('seeds the minimum fields the route handlers expect', () => {
    const s = createEmptySession({
      callSid: 'CA1',
      businessId: 'biz_1',
      from: '+15551',
      to: '+15552',
    });
    expect(s).toMatchObject({
      callSid: 'CA1',
      businessId: 'biz_1',
      from: '+15551',
      to: '+15552',
      turnCount: 0,
      messages: [],
      placedOrderId: null,
      done: false,
    });
    expect(typeof s.createdAt).toBe('string');
  });
});

describe('keyFor', () => {
  it('namespaces voice session keys so they cannot collide with other Redis data', () => {
    expect(keyFor('CAxxxx')).toBe('rushdesk:voice:session:CAxxxx');
  });
});

describe('in-memory session store', () => {
  it('supports get / set / delete', async () => {
    const store = createInMemorySessionStore();
    expect(await store.get('k')).toBeNull();
    await store.set('k', { a: 1 });
    expect(await store.get('k')).toEqual({ a: 1 });
    await store.delete('k');
    expect(await store.get('k')).toBeNull();
  });
});

describe('redis session store (with a stub client)', () => {
  it('serializes to JSON and applies the TTL every write', async () => {
    const redis = {
      get: vi.fn(async () => JSON.stringify({ a: 1 })),
      set: vi.fn(async () => 'OK'),
      del: vi.fn(async () => 1),
    };
    const store = createRedisSessionStore(redis, { ttlSeconds: 600 });
    expect(await store.get('k')).toEqual({ a: 1 });

    await store.set('k', { b: 2 });
    expect(redis.set).toHaveBeenCalledWith('k', JSON.stringify({ b: 2 }), 'EX', 600);

    await store.delete('k');
    expect(redis.del).toHaveBeenCalledWith('k');
  });

  it('returns null on a malformed payload rather than crashing the turn handler', async () => {
    const redis = { get: vi.fn(async () => '{not valid'), set: vi.fn(), del: vi.fn() };
    const store = createRedisSessionStore(redis);
    expect(await store.get('k')).toBeNull();
  });

  it('rejects construction without a redis client', () => {
    expect(() => createRedisSessionStore(null)).toThrow(/redis client/);
  });
});

describe('twiml composer', () => {
  it('escapes user-controlled text so a caller name cannot break XML', () => {
    const xml = buildTwiml([{ type: 'say', text: 'Hi, <script>alert(1)</script>!' }]);
    expect(xml).toContain('&lt;script&gt;');
    expect(xml).not.toContain('<script>');
  });

  it('emits a gather that barges on the prompt (caller can interrupt)', () => {
    const xml = buildTwiml([
      {
        type: 'gather',
        action: '/api/voice/turn?callSid=CA1',
        prompt: 'What would you like?',
        voice: 'Polly.Joanna-Neural',
        language: 'en-US',
        hints: 'burger,fries',
      },
    ]);
    expect(xml).toContain('<Gather');
    expect(xml).toContain('input="speech"');
    expect(xml).toContain('action="/api/voice/turn?callSid=CA1"');
    expect(xml).toContain('speechModel="experimental_conversations"');
    expect(xml).toContain('actionOnEmptyResult="true"');
    // Nested <Say> enables speech barge-in.
    expect(xml).toMatch(/<Gather[^>]*><Say/);
  });

  it('renders a hangup verb', () => {
    const xml = buildTwiml([{ type: 'hangup' }]);
    expect(xml).toContain('<Hangup/>');
  });

  it('escapeXml is reversible for plain text', () => {
    expect(escapeXml('A & B < C > "D" \'E\'')).toBe(
      'A &amp; B &lt; C &gt; &quot;D&quot; &apos;E&apos;',
    );
  });
});
