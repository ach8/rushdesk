'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  tokensMatch,
  createAdminSessionValue,
  adminSessionCookieOptions,
  ADMIN_SESSION_COOKIE,
} from '@/lib/adminSession';

export async function signInAdmin(_prevState, formData) {
  const token = formData.get('token');
  if (typeof token !== 'string' || token.trim().length === 0) {
    return { error: 'Please enter the admin token.' };
  }

  const expected = process.env.ADMIN_API_TOKEN;
  if (!expected) {
    return { error: 'Admin authentication is not configured on the server.' };
  }

  if (!tokensMatch(token.trim(), expected)) {
    return { error: 'Invalid admin token.' };
  }

  const value = createAdminSessionValue();
  cookies().set(ADMIN_SESSION_COOKIE, value, adminSessionCookieOptions());
  redirect('/admin/orders');
}

export async function signOutAdmin() {
  cookies().delete(ADMIN_SESSION_COOKIE);
  redirect('/admin/login');
}
