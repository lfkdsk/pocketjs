import type { NodeMirror } from "./native-tree.ts";

/** A mount-owned node slot. The callable shape is accepted by both view renderers. */
export interface NodeSlot {
  (node: NodeMirror | null): void;
  current: NodeMirror | null;
  readonly __pocketNodeRef: true;
}
const references = new WeakMap<NodeMirror, Set<NodeSlot>>();
export function createNodeRef(): NodeSlot {
  let value: NodeMirror | null = null;
  const slot = ((node: NodeMirror | null) => { slot.current = node; }) as NodeSlot;
  Object.defineProperties(slot, {
    __pocketNodeRef: { value: true },
    current: {
      get: () => value && (value as NodeMirror & { isConnected?: boolean }).isConnected !== false ? value : null,
      set: (node: NodeMirror | null) => {
        if (value) references.get(value)?.delete(slot);
        value = node;
        if (node) { let slots = references.get(node); if (!slots) references.set(node, slots = new Set()); slots.add(slot); }
      },
    },
  });
  return slot;
}
function clearNodeReferenceTree(value: unknown): void {
  if (Array.isArray(value)) {
    for (const child of value) clearNodeReferenceTree(child);
    return;
  }
  if (!value || typeof value !== "object") return;
  const candidate = value as { id?: unknown; children?: unknown; nodes?: unknown };
  clearNodeReferenceTree(candidate.children);
  clearNodeReferenceTree(candidate.nodes);
  if (typeof candidate.id !== "number") return;
  const node = value as NodeMirror;
  for (const slot of references.get(node) ?? []) slot.current = null;
  references.delete(node);
}
export function clearNodeReferences(node: NodeMirror): void {
  clearNodeReferenceTree(node);
}
