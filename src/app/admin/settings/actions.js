'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ADMIN_SESSION_COOKIE, verifyAdminSessionValue } from '@/lib/adminSession';
import { resolveActiveBusinessId } from '@/lib/orders';
import { updateRequireVoicePaymentUpfront } from '@/lib/businessSettings';

/**
 * Toggle `Business.requireVoicePaymentUpfront` for the active business.
 *
 * Session is re-verified server-side: an unauthenticated client cannot
 * flip the flag by crafting a POST to this action. `businessId` is
 * likewise resolved from the server, not from the form.
 */
export async function setRequireVoicePaymentUpfront(_prevState, formData) {
  const auth = verifyAdminSessionValue(cookies().get(ADMIN_SESSION_COOKIE)?.value);
  if (!auth.ok) {
    redirect('/admin/login');
  }

  const businessId = await resolveActiveBusinessId();
  if (!businessId) {
    return { error: 'No business is configured yet.' };
  }

  // Checkbox semantics: a checked checkbox sends the input value; an
  // unchecked one sends nothing. We treat the presence of `"on"` (or
  // any truthy string) as enable, absence as disable.
  const raw = formData.get('requireVoicePaymentUpfront');
  const next = raw === 'on' || raw === 'true' || raw === '1';

  try {
    await updateRequireVoicePaymentUpfront(businessId, next);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[admin/settings] update failed', err);
    return { error: 'Failed to update setting. Please try again.' };
  }

  return { ok: true, requireVoicePaymentUpfront: next };
}
