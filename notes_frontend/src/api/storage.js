/**
 * Minimal localStorage helpers for the notes app.
 *
 * Namespace: "notesApp"
 * Storage model:
 * - notes: Array<{ id: string, title: string, content: string, createdAt: number, updatedAt: number }>
 */

const NAMESPACE = "notesApp";
const NOTES_KEY = `${NAMESPACE}:notes`;

// PUBLIC_INTERFACE
export function readNotes() {
  /** Read the notes array from localStorage. Returns [] on any error. */
  try {
    const raw = window.localStorage.getItem(NOTES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((n) => n && typeof n === "object")
      .map(normalizeNote)
      .filter((n) => n && typeof n.id === "string");
  } catch {
    return [];
  }
}

// PUBLIC_INTERFACE
export function writeNotes(notes) {
  /** Persist the notes array to localStorage (best effort). */
  try {
    window.localStorage.setItem(NOTES_KEY, JSON.stringify(Array.isArray(notes) ? notes : []));
  } catch {
    // Best-effort only; caller keeps app functional without persistence.
  }
}

// PUBLIC_INTERFACE
export function normalizeNote(input) {
  /**
   * Normalize a note to the canonical shape used by the app/client.
   * Ensures `id` is a string.
   */
  if (!input || typeof input !== "object") return null;

  const now = Date.now();
  const id = input.id != null ? String(input.id) : "";

  return {
    id,
    title: typeof input.title === "string" ? input.title : "Untitled note",
    content: typeof input.content === "string" ? input.content : "",
    createdAt: typeof input.createdAt === "number" ? input.createdAt : now,
    updatedAt: typeof input.updatedAt === "number" ? input.updatedAt : now,
  };
}

// PUBLIC_INTERFACE
export function makeUuid() {
  /**
   * Create a UUID string for local note IDs.
   * Prefers crypto.randomUUID(); falls back to a lightweight pseudo-UUID.
   */
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // ignore and fallback
  }

  // Fallback: not cryptographically secure, but good enough for local IDs.
  const rand = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).slice(1);
  return `${rand()}${rand()}-${rand()}-${rand()}-${rand()}-${rand()}${rand()}${rand()}`;
}
