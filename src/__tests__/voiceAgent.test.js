import { describe, it, expect, vi } from 'vitest';
import {
  runAgentTurn,
  buildSystemPrompt,
  formatMenuForPrompt,
  trimHistory,
  MESSAGE_WINDOW,
  MAX_TURNS,
} from '@/lib/voice/agent';

function session(overrides = {}) {
  return {
    callSid: 'CA1',
    businessId: 'biz_1',
    from: '+15551111111',
    to: '+15552222222',
    messages: [],
    turnCount: 0,
    placedOrderId: null,
    done: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeOpenAIStub(responses) {
  const queue = [...responses];
  return {
    chat: {
      completions: {
        create: vi.fn(async () => {
          if (queue.length === 0) throw new Error('openai stub exhausted');
          return queue.shift();
        }),
      },
    },
  };
}

describe('formatMenuForPrompt', () => {
  it('groups items by category and renders ids + prices the AI can quote back', () => {
    const out = formatMenuForPrompt([
      { id: 'mi_a', name: 'Burger', category: 'Mains', price: '9.50', available: true },
      { id: 'mi_b', name: 'Fries', category: 'Sides', price: 3.25, available: true },
      { id: 'mi_c', name: 'Coke', category: 'Drinks', price: 2.5, available: false },
    ]);
    expect(out).toContain('== Mains ==');
    expect(out).toContain('[mi_a] Burger — $9.50');
    expect(out).toContain('== Sides ==');
    expect(out).toContain('[mi_b] Fries — $3.25');
    // Unavailable items must NOT be offered to the caller.
    expect(out).not.toContain('mi_c');
    expect(out).not.toContain('Coke');
  });

  it('handles an empty / fully-unavailable menu gracefully', () => {
    expect(formatMenuForPrompt([])).toMatch(/menu is currently empty/i);
    expect(
      formatMenuForPrompt([{ id: 'x', name: 'X', category: 'c', price: 1, available: false }]),
    ).toMatch(/unavailable/i);
  });
});

describe('buildSystemPrompt', () => {
  it('embeds business name, caller phone, and the menu', () => {
    const prompt = buildSystemPrompt({
      businessName: "Joe's Pizza",
      menuItems: [{ id: 'mi_1', name: 'Pepperoni', category: 'Pizza', price: 12, available: true }],
      callerPhone: '+15559998888',
    });
    expect(prompt).toContain("Joe's Pizza");
    expect(prompt).toContain('+15559998888');
    expect(prompt).toContain('[mi_1] Pepperoni');
  });
});

describe('trimHistory', () => {
  it('is a no-op under the window', () => {
    const msgs = [{ role: 'user', content: 'a' }];
    expect(trimHistory(msgs, MESSAGE_WINDOW)).toEqual(msgs);
  });

  it('keeps the tail when over the window', () => {
    const msgs = Array.from({ length: MESSAGE_WINDOW + 5 }, (_, i) => ({
      role: 'user',
      content: String(i),
    }));
    const trimmed = trimHistory(msgs);
    expect(trimmed).toHaveLength(MESSAGE_WINDOW);
    expect(trimmed[trimmed.length - 1].content).toBe(String(MESSAGE_WINDOW + 4));
  });
});

describe('runAgentTurn', () => {
  it('handles a text-only model response and records it in history', async () => {
    const openai = makeOpenAIStub([
      {
        choices: [{ message: { content: 'Great! What would you like?', tool_calls: [] } }],
      },
    ]);
    const result = await runAgentTurn({
      session: session(),
      userUtterance: 'Hi',
      systemPrompt: 'system',
      deps: { openai, model: 'gpt-test', executeTool: vi.fn() },
    });
    expect(result.reply).toBe('Great! What would you like?');
    expect(result.done).toBe(false);
    expect(result.session.turnCount).toBe(1);
    // User + assistant were both appended.
    expect(result.session.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('runs a submit_order tool call and then the follow-up text turn, marking the call done', async () => {
    const openai = makeOpenAIStub([
      // Turn 1: model asks to call submit_order.
      {
        choices: [
          {
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'tc_1',
                  type: 'function',
                  function: {
                    name: 'submit_order',
                    arguments: JSON.stringify({
                      items: [{ menu_item_id: 'mi_1', quantity: 1 }],
                      order_type: 'TAKEAWAY',
                    }),
                  },
                },
              ],
            },
          },
        ],
      },
      // Turn 2: model produces the spoken confirmation.
      {
        choices: [
          {
            message: {
              content:
                'Perfect — your order number is 1A2B3C and your total is $9.50. Thanks for calling!',
              tool_calls: [],
            },
          },
        ],
      },
    ]);

    const executeTool = vi.fn(async () => ({
      ok: true,
      order_id: 'order_xyz1A2B3C',
      short_code: '1A2B3C',
      total: 9.5,
      items: [{ name: 'Burger', quantity: 1, notes: null }],
    }));

    const result = await runAgentTurn({
      session: session(),
      userUtterance: 'Yes, place the order.',
      systemPrompt: 'system',
      deps: { openai, model: 'gpt-test', executeTool },
    });

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool.mock.calls[0][0].name).toBe('submit_order');
    expect(result.done).toBe(true);
    expect(result.placedOrderId).toBe('order_xyz1A2B3C');
    expect(result.reply).toMatch(/1A2B3C/);
    // History carries: user → assistant(tool_calls) → tool(result) → assistant(text)
    const roles = result.session.messages.map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'tool', 'assistant']);
  });

  it('does NOT mark the call done when submit_order fails — the AI should apologize and retry', async () => {
    const openai = makeOpenAIStub([
      {
        choices: [
          {
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'tc_1',
                  type: 'function',
                  function: {
                    name: 'submit_order',
                    arguments: JSON.stringify({
                      items: [{ menu_item_id: 'mi_bad', quantity: 1 }],
                      order_type: 'TAKEAWAY',
                    }),
                  },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            message: {
              content: "Sorry, that item isn't available. Would you like something else?",
              tool_calls: [],
            },
          },
        ],
      },
    ]);
    const executeTool = vi.fn(async () => ({ ok: false, code: 'menu_item_unavailable' }));

    const result = await runAgentTurn({
      session: session(),
      userUtterance: 'Yes place it',
      systemPrompt: 'system',
      deps: { openai, model: 'gpt-test', executeTool },
    });
    expect(result.done).toBe(false);
    expect(result.placedOrderId).toBeNull();
  });

  it('nudges the model when the caller says nothing instead of hallucinating an utterance', async () => {
    const openai = makeOpenAIStub([
      {
        choices: [{ message: { content: 'Sorry, could you say that again?', tool_calls: [] } }],
      },
    ]);
    await runAgentTurn({
      session: session(),
      userUtterance: '',
      systemPrompt: 'sys',
      deps: { openai, model: 'gpt-test', executeTool: vi.fn() },
    });
    const sent = openai.chat.completions.create.mock.calls[0][0];
    const userMsg = sent.messages.find((m) => m.role === 'user');
    expect(userMsg.content).toMatch(/caller did not say anything/i);
  });

  it('hangs up gracefully once MAX_TURNS is exceeded, without calling OpenAI', async () => {
    const openai = makeOpenAIStub([]);
    const result = await runAgentTurn({
      session: session({ turnCount: MAX_TURNS }), // next turn exceeds cap
      userUtterance: 'still going',
      systemPrompt: 'sys',
      deps: { openai, model: 'gpt-test', executeTool: vi.fn() },
    });
    expect(result.done).toBe(true);
    expect(result.reply).toMatch(/wrap up|goodbye/i);
    expect(openai.chat.completions.create).not.toHaveBeenCalled();
  });
});
