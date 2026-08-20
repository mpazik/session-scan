export interface NativeTreeEntry {
  id: string;
  parentId: string | null;
}

/**
 * Select the source-ordered root-to-head path from a native session tree.
 * A parent absent from `entries` is treated as an external/root boundary.
 */
export function selectHeadPath<T extends NativeTreeEntry>(
  entries: T[],
  headId: string,
): T[] {
  if (!headId) throw new Error("head ID must not be empty");

  const byId = new Map<string, T>();
  for (const entry of entries) {
    if (byId.has(entry.id)) {
      throw new Error(`cannot select head "${headId}": duplicate entry ID "${entry.id}"`);
    }
    byId.set(entry.id, entry);
  }

  if (!byId.has(headId)) {
    throw new Error(`head "${headId}" was not found`);
  }

  const selected = new Set<string>();
  let id: string | null = headId;
  while (id !== null) {
    if (selected.has(id)) {
      throw new Error(`cannot select head "${headId}": parent cycle detected`);
    }
    const entry = byId.get(id);
    if (!entry) break;
    selected.add(id);
    id = entry.parentId;
  }

  return entries.filter((entry) => selected.has(entry.id));
}
