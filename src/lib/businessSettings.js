/**
 * Per-business configuration accessors.
 *
 * Today the only setting stored on `Business` that's exposed through an
 * admin UI is `requireVoicePaymentUpfront`. This module centralizes the
 * read/write path so the orders pipeline has exactly one place to ask
 * "should this voice order demand payment first?".
 *
 * The `isAdvancePaymentConfigured` helper combines the per-business
 * toggle with a check of the required env vars. This lets us FAIL OPEN
 * (fall back to the legacy no-payment flow) if a deployer enables the
 * toggle but forgot to configure Stripe or Twilio — the alternative
 * (failing closed) would silently drop every voice order. The fail-open
 * is logged loudly so the gap is detected.
 */
import { prisma as defaultPrisma } from './prisma.js';
import { getEnv } from './env.js';

export async function getBusinessSettings(businessId, { prisma = defaultPrisma } = {}) {
  if (!businessId) return null;
  return prisma.business.findUnique({
    where: { id: businessId },
    select: {
      id: true,
      name: true,
      requireVoicePaymentUpfront: true,
    },
  });
}

export async function updateRequireVoicePaymentUpfront(
  businessId,
  value,
  { prisma = defaultPrisma } = {},
) {
  if (!businessId) throw new Error('businessId is required.');
  return prisma.business.update({
    where: { id: businessId },
    data: { requireVoicePaymentUpfront: Boolean(value) },
    select: {
      id: true,
      name: true,
      requireVoicePaymentUpfront: true,
    },
  });
}

/**
 * Return the list of env vars that must be set for advance-payment to
 * function end-to-end. Empty when everything is configured.
 */
export function missingAdvancePaymentEnv(env = undefined) {
  const e =
    env ??
    (() => {
      try {
        return getEnv();
      } catch {
        return {};
      }
    })();
  const required = [
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_FROM_NUMBER',
    'APP_BASE_URL',
  ];
  return required.filter((key) => !e[key]);
}

export function isAdvancePaymentConfigured(env) {
  return missingAdvancePaymentEnv(env).length === 0;
}
