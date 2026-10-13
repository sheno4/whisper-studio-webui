export type StudioRoute = { kind: 'library' } | { kind: 'task' | 'history'; id: string };

/** Keep browser Back/Forward useful without changing any server routes. */
export function parseStudioRoute(hash: string): StudioRoute {
  const match = /^#\/(task|history)\/([^/?#]+)$/.exec(hash);
  if (!match) return { kind: 'library' };
  try {
    const id = decodeURIComponent(match[2]);
    return id ? { kind: match[1] as 'task' | 'history', id } : { kind: 'library' };
  } catch { return { kind: 'library' }; }
}

export function routeHash(route: StudioRoute): string {
  return route.kind === 'library' ? '#/library' : `#/${route.kind}/${encodeURIComponent(route.id)}`;
}
