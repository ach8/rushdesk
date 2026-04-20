'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { setRequireVoicePaymentUpfront } from './actions';

const INITIAL_STATE = { ok: false };

/**
 * Controlled settings form for the voice-receptionist advance-payment
 * toggle. The server action is the source of truth — on success the
 * action returns the new value and we reflect it back in the checkbox
 * `defaultChecked`. The form posts the checkbox value verbatim
 * ("on"/absent) so the action does not have to parse JSON.
 */
export default function SettingsForm({
  initialRequireVoicePaymentUpfront,
  paymentEnvConfigured,
  missingEnv,
}) {
  const [state, formAction] = useFormState(setRequireVoicePaymentUpfront, INITIAL_STATE);

  const current = state.ok ? state.requireVoicePaymentUpfront : initialRequireVoicePaymentUpfront;

  return (
    <form action={formAction} className="space-y-6">
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm ring-1 ring-slate-900/5">
        <div className="flex items-start justify-between gap-6">
          <div className="flex-1">
            <h2 className="text-base font-semibold text-slate-900">
              Require advance payment for voice orders
            </h2>
            <p className="mt-1 text-sm leading-relaxed text-slate-600">
              When enabled, orders placed through the AI receptionist will{' '}
              <strong className="font-semibold">not</strong> appear on the kitchen dashboard until
              the caller completes payment. A Stripe checkout link is texted to the caller via SMS;
              the order only reaches the kitchen once Stripe confirms payment. If payment is not
              completed within 24 hours, the order is auto-cancelled.
            </p>
            <p className="mt-2 text-sm leading-relaxed text-slate-500">
              Leave this off to preserve the current behaviour: orders go straight to the kitchen.
            </p>
          </div>
          <label className="relative inline-flex cursor-pointer items-center">
            <input
              type="checkbox"
              name="requireVoicePaymentUpfront"
              defaultChecked={current}
              className="peer sr-only"
              disabled={!paymentEnvConfigured}
            />
            <span className="h-6 w-11 rounded-full bg-slate-200 transition peer-checked:bg-emerald-500 peer-disabled:opacity-50" />
            <span className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition peer-checked:translate-x-5" />
          </label>
        </div>

        {!paymentEnvConfigured ? (
          <div
            className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900"
            role="alert"
          >
            <p className="font-semibold">Payment integration is not fully configured.</p>
            <p className="mt-1">
              Set the following environment variables before enabling this feature:{' '}
              <code className="font-mono">{missingEnv.join(', ')}</code>. Until then, the toggle is
              locked off and voice orders will go directly to the kitchen.
            </p>
          </div>
        ) : null}

        {state.error ? (
          <p className="mt-3 text-sm text-rose-600" role="alert">
            {state.error}
          </p>
        ) : null}
      </div>

      <div className="flex justify-end">
        <SubmitButton />
      </div>
    </form>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex items-center rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:opacity-60"
    >
      {pending ? 'Saving…' : 'Save settings'}
    </button>
  );
}
