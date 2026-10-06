// The VAPID subject is the sender contact push services see on every message.
// Apple's push service rejects an unreachable-looking one (a `.local` mailto)
// with 403 BadJwtToken, so iPhones never received anything. Set VAPID_SUBJECT
// to your public URL or a mailto: address you own.
export const DEFAULT_VAPID_SUBJECT = 'https://github.com/siteboon/claudecodeui';

export function resolveVapidSubject(env: Record<string, string | undefined> = process.env): string {
  const subject = env.VAPID_SUBJECT?.trim();
  return subject && /^(mailto:|https:\/\/)/.test(subject) ? subject : DEFAULT_VAPID_SUBJECT;
}
