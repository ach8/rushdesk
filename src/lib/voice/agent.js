/**
 * Voice AI agent — one function call per conversational turn.
 *
 * Invariants
 * ----------
 *   - All pricing / availability decisions are made against the DB by
 *     `createOrder` (via the `submit_order` tool). The AI never sees a
 *     trusted price field; it can only reference menu_item_ids from the
 *     system prompt, and the server re-resolves prices authoritatively.
 *   - `turnCount` is capped — a looping / confused model cannot keep a
 *     caller on the line forever and rack up OpenAI + Twilio bills.
 *   - History is trimmed to a fixed window so prompt size stays bounded
 *     on long calls.
 *
 * Deployment note
 * ---------------
 * This agent runs turn-by-turn over HTTP (Twilio `<Gather>` → webhook).
 * That's the Vercel-native shape. A future "true realtime" upgrade would
 * move the voice transport to Twilio Media Streams + OpenAI Realtime API
 * over a persistent WebSocket — which requires a long-lived compute host
 * outside Vercel's serverless functions. The tool contract (`submit_order`,
 * etc.) stays the same either way, so swapping transports is local to
 * `src/app/api/voice/*`.
 */
import { getOpenAIClient } from '@/lib/openai';
import { getEnv } from '@/lib/env';
import { VOICE_TOOL_DEFINITIONS, executeToolCall } from './tools.js';

export const MAX_TURNS = 25;
// Keep the last N messages in-context. Long enough to hold a normal phone
// order, short enough to keep token costs and latency predictable.
export const MESSAGE_WINDOW = 24;
// Cap the number of consecutive tool calls per turn so a confused model
// can't spin on itself while the caller waits in silence.
export const MAX_TOOL_ITERATIONS = 4;

/**
 * Render the menu for the system prompt. Compact and deterministic —
 * the AI only needs menu_item_id, name, category, price, notes.
 */
export function formatMenuForPrompt(menuItems) {
  if (!menuItems || menuItems.length === 0) {
    return 'The menu is currently empty. Apologize and tell the caller the restaurant is not accepting orders right now.';
  }

  const available = menuItems.filter((m) => m.available !== false);
  if (available.length === 0) {
    return 'Every item is currently unavailable. Apologize and tell the caller orders are paused.';
  }

  // Group by category for a readable block.
  const byCategory = new Map();
  for (const item of available) {
    const cat = item.category || 'Other';
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat).push(item);
  }

  const lines = [];
  for (const [cat, items] of byCategory) {
    lines.push(`== ${cat} ==`);
    for (const item of items) {
      const price = Number(item.price ?? 0).toFixed(2);
      lines.push(`- [${item.id}] ${item.name} — $${price}`);
    }
  }
  return lines.join('\n');
}

/**
 * Build the system prompt for a call. Kept as its own function so tests
 * can diff it and so it can be rendered once per call, not per turn.
 */
export function buildSystemPrompt({ businessName, menuItems, callerPhone }) {
  const menu = formatMenuForPrompt(menuItems);
  return [
    `You are the friendly phone receptionist for ${businessName}. You answer calls and take food orders.`,
    '',
    'Your job, in order:',
    '  1. Greet the caller and ask what they would like to order.',
    '  2. Help them build the order using ONLY the menu below.',
    '  3. Before placing the order, read back the full list of items with quantities and any special instructions, plus the order type (dine-in, takeaway, delivery), and ask the caller to confirm.',
    '  4. Once the caller confirms, call the `submit_order` function. Do NOT call it before getting explicit confirmation.',
    '  5. After the tool returns successfully, tell the caller the short order code and the total, then thank them and wrap up.',
    '',
    'Hard rules:',
    '  - Speak naturally but keep turns short — the caller is listening, not reading.',
    '  - Never invent menu items. If the caller asks for something not on the menu, politely say so and suggest an alternative.',
    '  - Always use the exact menu_item_id values from the menu below. Never pass a name as the id.',
    '  - Do not quote prices yourself; the system will compute the total and tell you in the submit_order response.',
    '  - If the caller wants delivery, ask for their address and include it in order_notes.',
    '  - If the caller is rude, abusive, or seems to be calling by mistake, stay calm and wrap up politely.',
    '',
    `Caller's phone number: ${callerPhone || 'unknown'}`,
    '',
    'Menu:',
    menu,
  ].join('\n');
}

/**
 * Trim message history to the last N entries, preserving any leading
 * system message. OpenAI charges on the whole prompt every turn; on a
 * long-winded call this keeps cost + latency flat.
 */
export function trimHistory(messages, window = MESSAGE_WINDOW) {
  if (messages.length <= window) return messages;
  // Always keep the first message if it's system (belt-and-suspenders —
  // in practice the route handler rebuilds the system prompt per turn).
  const head = messages[0]?.role === 'system' ? [messages[0]] : [];
  const tail = messages.slice(-window);
  return [...head, ...tail];
}

/**
 * Run a single conversational turn.
 *
 * @param {{
 *   session: import('./session.js').VoiceSession,
 *   userUtterance: string,
 *   systemPrompt: string,
 *   deps?: { openai?: any, model?: string, executeTool?: typeof executeToolCall },
 * }} args
 * @returns {Promise<{ reply: string, session: object, done: boolean, placedOrderId: string | null }>}
 */
export async function runAgentTurn({ session, userUtterance, systemPrompt, deps = {} }) {
  const {
    openai = getOpenAIClient(),
    model = getEnv().OPENAI_MODEL,
    executeTool = executeToolCall,
  } = deps;

  // Work on a shallow copy — callers shouldn't see intermediate state if
  // we throw partway through a tool iteration.
  const next = {
    ...session,
    messages: [...session.messages],
    turnCount: session.turnCount + 1,
  };

  const cleanedUtterance = String(userUtterance ?? '').trim();
  if (cleanedUtterance.length > 0) {
    next.messages.push({ role: 'user', content: cleanedUtterance.slice(0, 1000) });
  } else {
    // Twilio fires the turn webhook even when the caller said nothing
    // (actionOnEmptyResult=true). Give the model an explicit nudge so it
    // re-prompts rather than hallucinating a caller utterance.
    next.messages.push({
      role: 'user',
      content: '[the caller did not say anything — gently re-prompt them]',
    });
  }

  // Hard stop on pathological long calls.
  if (next.turnCount > MAX_TURNS) {
    next.done = true;
    const reply =
      "I'm sorry, we've been on the line a while — let me wrap up here. Please call back if you'd like to place an order. Goodbye.";
    next.messages.push({ role: 'assistant', content: reply });
    next.messages = trimHistory(next.messages);
    return { reply, session: next, done: true, placedOrderId: next.placedOrderId };
  }

  const messagesForModel = [
    { role: 'system', content: systemPrompt },
    ...trimHistory(next.messages),
  ];

  let assistantReply = '';
  // Loop the model <-> tool exchange, with a hard iteration cap to prevent
  // runaway tool calls from stalling the caller in dead air.
  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    const completion = await openai.chat.completions.create({
      model,
      messages: messagesForModel,
      tools: VOICE_TOOL_DEFINITIONS,
      // Low temperature for predictable ordering behavior — not zero,
      // because a too-rigid receptionist sounds robotic.
      temperature: 0.3,
    });

    const choice = completion.choices?.[0];
    const message = choice?.message;
    if (!message) {
      assistantReply = "Sorry, I didn't catch that. Could you repeat?";
      break;
    }

    const toolCalls = message.tool_calls ?? [];
    if (toolCalls.length === 0) {
      assistantReply = (message.content ?? '').trim();
      if (!assistantReply) {
        assistantReply = "Sorry, I didn't catch that. Could you repeat?";
      }
      // Persist the assistant turn in history.
      next.messages.push({ role: 'assistant', content: assistantReply });
      messagesForModel.push({ role: 'assistant', content: assistantReply });
      break;
    }

    // The model wants to call one or more tools. Preserve the assistant
    // turn (with the tool_calls metadata) in history so the next model
    // call can match `tool_call_id`s.
    const assistantTurn = {
      role: 'assistant',
      content: message.content ?? '',
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.function?.name, arguments: tc.function?.arguments ?? '{}' },
      })),
    };
    next.messages.push(assistantTurn);
    messagesForModel.push(assistantTurn);

    for (const call of toolCalls) {
      let parsedArgs = {};
      try {
        parsedArgs = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        parsedArgs = {};
      }
      const result = await executeTool({
        name: call.function?.name,
        args: parsedArgs,
        session: next,
      });

      if (call.function?.name === 'submit_order' && result?.ok) {
        // Success path: mark the call ready to wrap up after the AI
        // composes its spoken confirmation on the next iteration.
        next.placedOrderId = result.order_id;
        next.done = true;
      }

      const toolMessage = {
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result),
      };
      next.messages.push(toolMessage);
      messagesForModel.push(toolMessage);
    }
    // Fall through — loop again so the model can speak a response that
    // incorporates the tool results.
  }

  if (!assistantReply) {
    // Ran out of iterations without a text reply — surface something
    // speakable so the caller isn't left in silence.
    assistantReply =
      "Sorry, I'm having trouble on my end. Let me try that again — could you repeat your order?";
    next.messages.push({ role: 'assistant', content: assistantReply });
  }

  next.messages = trimHistory(next.messages);
  return {
    reply: assistantReply,
    session: next,
    done: Boolean(next.done),
    placedOrderId: next.placedOrderId,
  };
}
