// One-line JSON logs: grep-able in Cloud Run's log explorer and trivially
// parseable anywhere else. Every request-scoped event carries its requestId.

export function logEvent(level, event, fields = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  if (level === 'error') console.error(line);
  else console.log(line);
}
