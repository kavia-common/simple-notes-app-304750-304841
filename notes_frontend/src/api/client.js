/**
 * Notes API client with localStorage fallback.
 *
 * Base URL is constructed from environment variables:
 *   `${REACT_APP_BACKEND_URL}${REACT_APP_API_BASE || '/api'}`
 *
 * Behavior:
 * - If backend URL is not configured, operations run locally (localStorage).
 * - If a network call fails (timeout/fetch error) or returns non-2xx, fallback to localStorage.
 */

import { makeUuid, normalizeNote, readNotes, writeNotes } from "./storage";

/**
 * Create a consistent error object across network/local operations.
 * @param {unknown} err
 * @param {string} fallbackCode
 * @param {string} fallbackMessage
 * @returns {{code: string, message: string}}
 */
function normalizeError(err, fallbackCode = "UNKNOWN", fallbackMessage = "Unexpected error") {
  if (!err) return { code: fallbackCode, message: fallbackMessage };

  if (typeof err === "string") return { code: fallbackCode, message: err };

  if (typeof err === "object") {
    const anyErr = /** @type {any} */ (err);
    const code = typeof anyErr.code === "string" ? anyErr.code : fallbackCode;
    const message =
      typeof anyErr.message === "string"
        ? anyErr.message
        : typeof anyErr.error === "string"
          ? anyErr.error
          : fallbackMessage;
    return { code, message };
  }

  return { code: fallbackCode, message: fallbackMessage };
}

/**
 * @returns {string|null} computed base URL, or null if backend not configured
 */
function computeBaseUrl() {
  const backend = (process.env.REACT_APP_BACKEND_URL || "").trim();
  if (!backend) return null;

  const base = (process.env.REACT_APP_API_BASE || "/api").trim() || "/api";

  // Avoid accidental double slashes when concatenating.
  const backendNoTrailing = backend.replace(/\/+$/, "");
  const baseWithLeading = base.startsWith("/") ? base : `/${base}`;

  return `${backendNoTrailing}${baseWithLeading}`;
}

// PUBLIC_INTERFACE
export function isBackendEnabled() {
  /** True if REACT_APP_BACKEND_URL is configured (non-empty). */
  return Boolean(computeBaseUrl());
}

/**
 * Perform fetch with an AbortController timeout and normalized error handling.
 *
 * @param {string} url
 * @param {RequestInit & { timeoutMs?: number }} [options]
 * @returns {Promise<Response>}
 */
async function safeFetchInternal(url, options = {}) {
  const { timeoutMs = 8000, ...fetchOptions } = options;

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(fetchOptions.headers || {}),
      },
    });
    return res;
  } catch (err) {
    const n = normalizeError(err, "FETCH_FAILED", "Network request failed");
    // Preserve AbortError signal as timeout.
    if (err && typeof err === "object" && /** @type {any} */ (err).name === "AbortError") {
      throw { code: "TIMEOUT", message: "Request timed out" };
    }
    throw n;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

// PUBLIC_INTERFACE
export async function safeFetch(url, options = {}) {
  /**
   * Safe fetch wrapper with default 8s timeout.
   * Throws normalized `{code, message}` on failure (fetch error/timeout).
   */
  return safeFetchInternal(url, { timeoutMs: 8000, ...options });
}

/**
 * Parse a JSON response safely; throws normalized error if invalid JSON.
 * @param {Response} res
 * @returns {Promise<any>}
 */
async function parseJson(res) {
  try {
    // Some backends respond with empty body (e.g., 204). Handle gracefully.
    const text = await res.text();
    if (!text) return null;
    return JSON.parse(text);
  } catch {
    throw { code: "BAD_JSON", message: "Invalid JSON response" };
  }
}

/**
 * Throws a normalized error for non-2xx responses.
 * @param {Response} res
 */
async function throwIfNotOk(res) {
  if (res.ok) return;

  let payload = null;
  try {
    payload = await parseJson(res);
  } catch {
    // ignore JSON parse error; fallback to status text
  }

  const message =
    (payload && (payload.message || payload.error)) ||
    res.statusText ||
    `Request failed with status ${res.status}`;

  throw { code: `HTTP_${res.status}`, message: String(message) };
}

/* --------------------------- Local fallback CRUD --------------------------- */

function localListNotes() {
  const notes = readNotes();
  // Keep behavior similar to UI: newest updated first.
  return [...notes].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function localGetNote(id) {
  const sid = String(id);
  const notes = readNotes();
  return notes.find((n) => n.id === sid) || null;
}

function localCreateNote(note) {
  const now = Date.now();
  const normalized = normalizeNote({
    ...note,
    id: makeUuid(),
    createdAt: typeof note?.createdAt === "number" ? note.createdAt : now,
    updatedAt: typeof note?.updatedAt === "number" ? note.updatedAt : now,
  });

  const existing = readNotes();
  const next = [normalized, ...existing];
  writeNotes(next);
  return normalized;
}

function localUpdateNote(id, partial) {
  const sid = String(id);
  const now = Date.now();
  const notes = readNotes();
  const idx = notes.findIndex((n) => n.id === sid);
  if (idx === -1) return null;

  const current = notes[idx];
  const updated = normalizeNote({
    ...current,
    ...partial,
    id: sid,
    updatedAt: now,
  });

  const next = [...notes];
  next[idx] = updated;
  writeNotes(next);
  return updated;
}

function localDeleteNote(id) {
  const sid = String(id);
  const notes = readNotes();
  const exists = notes.some((n) => n.id === sid);
  if (!exists) return false;

  writeNotes(notes.filter((n) => n.id !== sid));
  return true;
}

/* ------------------------------ Network CRUD ------------------------------ */

/**
 * Helper to call backend endpoints. Falls back to local on any failure.
 * Endpoints are assumed to be REST-ish:
 * - GET    /notes
 * - GET    /notes/:id
 * - POST   /notes
 * - PATCH  /notes/:id
 * - DELETE /notes/:id
 *
 * If backend differs, it will fail and fallback to localStorage.
 */

async function backendListNotes(baseUrl) {
  const res = await safeFetch(`${baseUrl}/notes`, { method: "GET" });
  await throwIfNotOk(res);
  const data = await parseJson(res);
  const arr = Array.isArray(data) ? data : data?.notes;
  if (!Array.isArray(arr)) return [];
  return arr.map(normalizeNote).filter(Boolean);
}

async function backendGetNote(baseUrl, id) {
  const sid = String(id);
  const res = await safeFetch(`${baseUrl}/notes/${encodeURIComponent(sid)}`, { method: "GET" });
  await throwIfNotOk(res);
  const data = await parseJson(res);
  const note = normalizeNote(data);
  return note && note.id ? note : null;
}

async function backendCreateNote(baseUrl, note) {
  const res = await safeFetch(`${baseUrl}/notes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(note || {}),
  });
  await throwIfNotOk(res);
  const data = await parseJson(res);
  const created = normalizeNote(data);
  return created && created.id ? created : normalizeNote({ ...note, id: makeUuid() });
}

async function backendUpdateNote(baseUrl, id, partial) {
  const sid = String(id);
  const res = await safeFetch(`${baseUrl}/notes/${encodeURIComponent(sid)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(partial || {}),
  });
  await throwIfNotOk(res);
  const data = await parseJson(res);
  const updated = normalizeNote(data);
  return updated && updated.id ? updated : null;
}

async function backendDeleteNote(baseUrl, id) {
  const sid = String(id);
  const res = await safeFetch(`${baseUrl}/notes/${encodeURIComponent(sid)}`, {
    method: "DELETE",
  });
  await throwIfNotOk(res);
  return true;
}

/* ------------------------------- Public API ------------------------------ */

// PUBLIC_INTERFACE
export async function listNotes() {
  /** List notes from backend if available; otherwise from localStorage. */
  const baseUrl = computeBaseUrl();
  if (!baseUrl) return localListNotes();

  try {
    const remote = await backendListNotes(baseUrl);
    // Ensure IDs are strings even when coming from backend.
    return remote.map((n) => ({ ...n, id: String(n.id) }));
  } catch {
    return localListNotes();
  }
}

// PUBLIC_INTERFACE
export async function getNote(id) {
  /** Get a single note by id from backend if available; otherwise from localStorage. */
  const baseUrl = computeBaseUrl();
  if (!baseUrl) return localGetNote(id);

  try {
    const remote = await backendGetNote(baseUrl, id);
    return remote ? { ...remote, id: String(remote.id) } : null;
  } catch {
    return localGetNote(id);
  }
}

// PUBLIC_INTERFACE
export async function createNote(note) {
  /**
   * Create a note. If created locally, generates a UUID and stores in localStorage.
   * Returns the created note.
   */
  const baseUrl = computeBaseUrl();
  if (!baseUrl) return localCreateNote(note);

  try {
    const created = await backendCreateNote(baseUrl, note);
    return { ...created, id: String(created.id) };
  } catch {
    return localCreateNote(note);
  }
}

// PUBLIC_INTERFACE
export async function updateNote(id, partial) {
  /**
   * Update a note by id. Returns updated note or null if not found.
   */
  const baseUrl = computeBaseUrl();
  if (!baseUrl) return localUpdateNote(id, partial);

  try {
    const updated = await backendUpdateNote(baseUrl, id, partial);
    return updated ? { ...updated, id: String(updated.id) } : null;
  } catch {
    return localUpdateNote(id, partial);
  }
}

// PUBLIC_INTERFACE
export async function deleteNote(id) {
  /**
   * Delete a note by id. Returns boolean indicating whether a note was deleted.
   */
  const baseUrl = computeBaseUrl();
  if (!baseUrl) return localDeleteNote(id);

  try {
    return await backendDeleteNote(baseUrl, id);
  } catch {
    return localDeleteNote(id);
  }
}
