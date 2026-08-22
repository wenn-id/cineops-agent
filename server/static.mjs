import { extname, resolve, sep } from 'node:path';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// Resolves a URL path inside dist/ only. Returns null for anything that
// escapes the root, so the server can never expose repo, .git/, or .agents/.
export function resolveStatic(distRoot, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  if (relative.includes('\0') || relative.includes('..')) return null;
  const resolved = resolve(distRoot, relative);
  if (resolved !== distRoot && !resolved.startsWith(distRoot + sep)) return null;
  const type = CONTENT_TYPES[extname(resolved).toLowerCase()];
  if (!type) return null;
  return { path: resolved, type };
}
