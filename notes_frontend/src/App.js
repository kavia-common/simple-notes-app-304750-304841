import React, { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import { createNote, deleteNote, isBackendEnabled, listNotes, updateNote } from "./api/client";
import { readUiPrefs, writeUiPrefs } from "./api/storage";

/**
 * Notes app data model:
 * {
 *   id: string,
 *   title: string,
 *   content: string,
 *   createdAt: number,
 *   updatedAt: number
 * }
 */

const STORAGE_KEY = "ocean_notes_v1";

/** Milliseconds to debounce autosave while typing */
const AUTOSAVE_DEBOUNCE_MS = 450;

const UI_PREFS_KEY = "ocean_notes_ui_v1";

/** @typedef {"updated_desc" | "created_desc" | "title_asc"} SortOrder */

// PUBLIC_INTERFACE
function App() {
  /** Environment variables are optional; we remain local-only by default. */
  const env = useMemo(() => {
    return {
      apiBase: process.env.REACT_APP_API_BASE,
      backendUrl: process.env.REACT_APP_BACKEND_URL,
      wsUrl: process.env.REACT_APP_WS_URL,
      nodeEnv: process.env.REACT_APP_NODE_ENV,
      featureFlags: process.env.REACT_APP_FEATURE_FLAGS,
    };
  }, []);

  // Local-first initial state (fast paint), then hydrate via API client (backend or local fallback).
  const [notes, setNotes] = useState(() => loadNotesWithSeed());
  const [selectedId, setSelectedId] = useState(() => {
    const initial = loadNotesWithSeed();
    return initial.length ? initial[0].id : null;
  });
  const [query, setQuery] = useState("");
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);

  // UI preferences (persisted)
  const [sortOrder, setSortOrder] = useState(
    /** @type {SortOrder} */ (
      readUiPrefs(UI_PREFS_KEY)?.sortOrder || /** @type {SortOrder} */ ("updated_desc")
    )
  );
  const [onlyWithContent, setOnlyWithContent] = useState(
    Boolean(readUiPrefs(UI_PREFS_KEY)?.onlyWithContent)
  );

  // Minimal status: keep UI undisturbed while surfacing connectivity/loading issues.
  const [isLoading, setIsLoading] = useState(true);
  const [banner, setBanner] = useState({ tone: "muted", message: "" });

  // Save status pill + online/offline detection
  const [isOnline, setIsOnline] = useState(() => (typeof navigator !== "undefined" ? navigator.onLine : true));
  const [savePhase, setSavePhase] = useState(/** @type {"saved" | "saving"} */ ("saved"));

  // Track current async ops for optimistic reconciliation.
  const pendingOpsRef = useRef(
    /** @type {Map<string, { type: "create" | "update" | "delete", id: string, snapshot?: any, serverId?: string }>} */ (
      new Map()
    )
  );

  /** Editor local state so we can debounce writes to notes[] */
  const selectedNote = useMemo(
    () => notes.find((n) => n.id === selectedId) || null,
    [notes, selectedId]
  );
  const [draftTitle, setDraftTitle] = useState(selectedNote?.title || "");
  const [draftContent, setDraftContent] = useState(selectedNote?.content || "");
  const [isDirty, setIsDirty] = useState(false);

  const autosaveTimerRef = useRef(null);
  const lastSavedAtRef = useRef(0);

  const searchInputRef = useRef(null);
  const editorTextAreaRef = useRef(null);

  /** Keep draft in sync when switching notes */
  useEffect(() => {
    setDraftTitle(selectedNote?.title || "");
    setDraftContent(selectedNote?.content || "");
    setIsDirty(false);
    setSavePhase("saved");
  }, [selectedNote?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Online/offline events for status pill. */
  useEffect(() => {
    const on = () => setIsOnline(true);
    const off = () => setIsOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  /** Persist UI preferences */
  useEffect(() => {
    writeUiPrefs(UI_PREFS_KEY, { sortOrder, onlyWithContent });
  }, [sortOrder, onlyWithContent]);

  /**
   * Load notes using the API client:
   * - When backend env vars are set, client will attempt network.
   * - If unreachable/not set, client falls back to localStorage automatically.
   */
  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      setIsLoading(true);

      const backendConfigured = isBackendEnabled();
      if (backendConfigured) {
        setBanner({ tone: "muted", message: "Syncing with backend…" });
      } else {
        setBanner({ tone: "muted", message: "Local mode (offline-ready)" });
      }

      try {
        const loaded = await listNotes();
        if (cancelled) return;

        // If backend returned empty and local has no notes, seed for a friendly first-run.
        const next = loaded.length ? loaded : loadNotesWithSeed();

        setNotes(next);
        setSelectedId((prev) => {
          if (prev && next.some((n) => n.id === prev)) return prev;
          return next.length ? next[0].id : null;
        });

        // If we expected backend but got here, we may still have fallen back silently;
        // keep banner minimal and non-blocking.
        setBanner((b) => {
          if (!backendConfigured) return b;
          return { tone: "muted", message: "Ready" };
        });
      } catch (err) {
        if (cancelled) return;
        setBanner({
          tone: "danger",
          message: `Could not load notes from backend. Using local storage.`,
        });
        // Keep already-painted local notes.
      } finally {
        if (!cancelled) setIsLoading(false);
        // Auto-clear non-danger banners after a moment to reduce visual noise.
        window.setTimeout(() => {
          if (cancelled) return;
          setBanner((b) => (b.tone === "danger" ? b : { tone: "muted", message: "" }));
        }, 2200);
      }
    };

    run();

    return () => {
      cancelled = true;
    };
  }, []);

  /** Persist to localStorage anytime notes change (legacy key for backwards-compat). */
  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
    } catch (e) {
      // localStorage can fail in private mode or quota issues.
      // We keep the app functional without persistence.
      // eslint-disable-next-line no-console
      console.warn("Failed to persist notes to localStorage:", e);
    }
  }, [notes]);

  /** Derived list: search + sorting + quick filter */
  const filteredNotes = useMemo(() => {
    const q = query.trim().toLowerCase();

    // Optional quick filter: hide completely empty notes (no title and no content)
    // NOTE: we treat "Untitled note" (seed/default) as empty title for filter purposes.
    const baseFiltered = onlyWithContent
      ? notes.filter((n) => !isNoteFullyEmpty(n))
      : notes;

    const sorted = [...baseFiltered].sort((a, b) => sortNotes(a, b, sortOrder));

    if (!q) return sorted;

    return sorted.filter((n) => {
      const hay = `${n.title}\n${n.content}`.toLowerCase();
      return hay.includes(q);
    });
  }, [notes, query, sortOrder, onlyWithContent]);

  /** Ensure selectedId always points to an existing note if any exist */
  useEffect(() => {
    if (notes.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !notes.some((n) => n.id === selectedId)) {
      setSelectedId(notes[0].id);
    }
  }, [notes, selectedId]);

  const withTransientBanner = (tone, message) => {
    setBanner({ tone, message });
    if (tone !== "danger") {
      window.setTimeout(() => setBanner({ tone: "muted", message: "" }), 2200);
    }
  };

  // PUBLIC_INTERFACE
  const createNewNote = async () => {
    const now = Date.now();
    const tempId = makeId();
    const optimistic = {
      id: tempId,
      title: "",
      content: "",
      createdAt: now,
      updatedAt: now,
    };

    // Optimistic UI update.
    setNotes((prev) => [optimistic, ...prev]);
    setSelectedId(tempId);

    // Focus editor (content area) after render
    requestAnimationFrame(() => {
      const el = editorTextAreaRef.current || document.getElementById(`note-content-${tempId}`);
      if (el) el.focus();
    });

    // Reconcile with API client. It will fallback to localStorage if offline/unconfigured.
    const opId = `op_create_${tempId}_${now}`;
    pendingOpsRef.current.set(opId, { type: "create", id: tempId });

    try {
      const created = await createNote(optimistic);

      // If backend assigned a different id, reconcile state.
      if (created && created.id && created.id !== tempId) {
        setNotes((prev) => prev.map((n) => (n.id === tempId ? { ...created } : n)));
        setSelectedId((prev) => (prev === tempId ? created.id : prev));
      } else if (created) {
        setNotes((prev) => prev.map((n) => (n.id === tempId ? { ...created } : n)));
      }

      withTransientBanner("muted", "Note created");
    } catch (err) {
      // Most failures will have already fallen back to local create; this is a last resort.
      setNotes((prev) => prev.filter((n) => n.id !== tempId));
      setSelectedId((prev) => (prev === tempId ? null : prev));
      setBanner({ tone: "danger", message: "Could not create note." });
    } finally {
      pendingOpsRef.current.delete(opId);
    }
  };

  // PUBLIC_INTERFACE
  const requestDeleteSelected = () => {
    if (!selectedNote) return;
    setIsConfirmOpen(true);
  };

  const confirmDeleteSelected = async () => {
    if (!selectedNote) {
      setIsConfirmOpen(false);
      return;
    }

    const idToDelete = selectedNote.id;

    // Optimistic delete with rollback.
    const snapshot = selectedNote;
    const opId = `op_delete_${idToDelete}_${Date.now()}`;
    pendingOpsRef.current.set(opId, { type: "delete", id: idToDelete, snapshot });

    setNotes((prev) => prev.filter((n) => n.id !== idToDelete));
    setIsConfirmOpen(false);

    try {
      const ok = await deleteNote(idToDelete);
      if (!ok) {
        // If API says not deleted, restore.
        setNotes((prev) => [snapshot, ...prev]);
        setBanner({ tone: "danger", message: "Could not delete note." });
        return;
      }

      withTransientBanner("muted", "Note deleted");
    } catch (err) {
      // Rollback on unexpected error.
      setNotes((prev) => [snapshot, ...prev]);
      setBanner({ tone: "danger", message: "Could not delete note." });
    } finally {
      pendingOpsRef.current.delete(opId);
    }
  };

  const cancelDelete = () => setIsConfirmOpen(false);

  const updateDraftTitle = (value) => {
    setDraftTitle(value);
    setIsDirty(true);
    setSavePhase("saving");
    scheduleAutosave({ title: value, content: draftContent });
  };

  const updateDraftContent = (value) => {
    setDraftContent(value);
    setIsDirty(true);
    setSavePhase("saving");
    scheduleAutosave({ title: draftTitle, content: value });
  };

  const onTitleBlur = () => {
    // If title is empty, generate from first non-empty line of content.
    const t = (draftTitle ?? "").trim();
    if (t.length > 0) {
      // Ensure any trailing spaces etc. are normalized.
      if (t !== draftTitle) updateDraftTitle(t);
      return;
    }

    const generated = generateTitleFromContent(draftContent);
    if (generated) {
      setDraftTitle(generated);
      setIsDirty(true);
      setSavePhase("saving");
      scheduleAutosave({ title: generated, content: draftContent });
    }
  };

  const scheduleAutosave = ({ title, content }) => {
    if (!selectedId) return;

    if (autosaveTimerRef.current) {
      window.clearTimeout(autosaveTimerRef.current);
    }

    autosaveTimerRef.current = window.setTimeout(async () => {
      const normalizedTitle = normalizeTitle(title);
      const now = Date.now();

      // Optimistically update local state immediately.
      setNotes((prev) => {
        const idx = prev.findIndex((n) => n.id === selectedId);
        if (idx === -1) return prev;

        const current = prev[idx];
        const updated = {
          ...current,
          title: normalizedTitle,
          content: content ?? "",
          updatedAt: now,
        };

        // If nothing actually changed, avoid resort churn.
        if (updated.title === current.title && updated.content === current.content) {
          return prev;
        }

        const next = [...prev];
        next[idx] = updated;
        return next;
      });

      // Persist via client (backend if possible, local fallback if offline).
      const opId = `op_update_${selectedId}_${now}`;
      const snapshot = selectedNote;
      pendingOpsRef.current.set(opId, { type: "update", id: selectedId, snapshot });

      try {
        const updatedFromApi = await updateNote(selectedId, {
          title: normalizedTitle,
          content: content ?? "",
          updatedAt: now,
        });

        // If API returns canonical note, reconcile (e.g., server timestamps).
        if (updatedFromApi) {
          setNotes((prev) => prev.map((n) => (n.id === selectedId ? updatedFromApi : n)));
        }

        lastSavedAtRef.current = Date.now();
        setIsDirty(false);
        setSavePhase("saved");
      } catch (err) {
        // Revert on hard failure (client usually falls back, so this is uncommon).
        if (snapshot) {
          setNotes((prev) => prev.map((n) => (n.id === selectedId ? snapshot : n)));
        }
        setBanner({ tone: "danger", message: "Autosave failed. Changes were reverted." });
        setSavePhase("saved");
      } finally {
        pendingOpsRef.current.delete(opId);
      }
    }, AUTOSAVE_DEBOUNCE_MS);
  };

  // Cleanup autosave timers on unmount
  useEffect(() => {
    return () => {
      if (autosaveTimerRef.current) window.clearTimeout(autosaveTimerRef.current);
    };
  }, []);

  const flushPendingAutosave = async () => {
    if (!selectedId) return;

    const normalizedTitle = normalizeTitle(draftTitle);
    const now = Date.now();

    // Update local state immediately.
    setNotes((prev) => {
      const idx = prev.findIndex((n) => n.id === selectedId);
      if (idx === -1) return prev;
      const current = prev[idx];

      const updated = {
        ...current,
        title: normalizedTitle,
        content: draftContent,
        updatedAt: now,
      };

      // Avoid unnecessary state change.
      if (updated.title === current.title && updated.content === current.content) {
        return prev;
      }

      const next = [...prev];
      next[idx] = updated;
      return next;
    });

    try {
      setSavePhase("saving");
      await updateNote(selectedId, {
        title: normalizedTitle,
        content: draftContent,
        updatedAt: now,
      });
      lastSavedAtRef.current = Date.now();
      setIsDirty(false);
      setSavePhase("saved");
    } catch {
      // Keep silent to avoid disrupting navigation. Autosave debounce will retry later.
      setBanner({ tone: "danger", message: "Could not save changes (offline?)" });
      setSavePhase("saved");
    }
  };

  const onSelectNote = async (id) => {
    // If user switches quickly, flush pending autosave to reduce data loss.
    if (autosaveTimerRef.current) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
      await flushPendingAutosave();
    }

    setSelectedId(id);
  };

  const onNoteListKeyDown = (e) => {
    if (filteredNotes.length === 0) return;
    const currentIndex = filteredNotes.findIndex((n) => n.id === selectedId);

    if (e.key === "ArrowDown") {
      e.preventDefault();
      const nextIndex = Math.min(filteredNotes.length - 1, currentIndex + 1);
      const nextId = filteredNotes[nextIndex]?.id;
      if (nextId) onSelectNote(nextId);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const nextIndex = Math.max(0, currentIndex === -1 ? 0 : currentIndex - 1);
      const nextId = filteredNotes[nextIndex]?.id;
      if (nextId) onSelectNote(nextId);
    } else if (e.key === "Home") {
      e.preventDefault();
      onSelectNote(filteredNotes[0].id);
    } else if (e.key === "End") {
      e.preventDefault();
      onSelectNote(filteredNotes[filteredNotes.length - 1].id);
    } else if (e.key === "Enter" || e.key === " ") {
      // keep as no-op; selection already happens on focus/click
      // but prevent scroll on space.
      if (e.key === " ") e.preventDefault();
    }
  };

  /** Global keyboard shortcuts (no backend required) */
  useEffect(() => {
    const onKeyDown = (e) => {
      const isMod = e.metaKey || e.ctrlKey;
      if (!isMod) return;

      const key = e.key.toLowerCase();

      // Avoid capturing inside modal dialogs (but allow Esc handled in modal).
      if (isConfirmOpen) return;

      if (key === "n") {
        e.preventDefault();
        createNewNote();
        return;
      }

      if (key === "f") {
        e.preventDefault();
        searchInputRef.current?.focus();
        return;
      }

      // Cmd/Ctrl + Backspace: delete current note (keeps confirmation modal)
      if (e.key === "Backspace") {
        e.preventDefault();
        requestDeleteSelected();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isConfirmOpen, selectedNote?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveStatusLabel = useMemo(() => {
    // Requirements: “Saved”, “Saving…”, or “Offline (local only)”.
    // Use online/offline detection plus local-first assumption.
    if (!isOnline) return "Offline (local only)";
    return savePhase === "saving" ? "Saving…" : "Saved";
  }, [isOnline, savePhase]);

  const showMainEmpty = notes.length === 0;

  return (
    <div className="AppShell">
      <Header
        onNew={createNewNote}
        onDelete={requestDeleteSelected}
        canDelete={Boolean(selectedNote)}
        env={env}
        banner={banner}
        isLoading={isLoading}
        saveStatusLabel={saveStatusLabel}
      />

      <div className="Layout">
        <aside className="Sidebar" aria-label="Notes sidebar">
          <div className="SidebarTop">
            <div className="SidebarTitleRow">
              <h2 className="SidebarTitle">Notes</h2>
              <Button
                variant="primary"
                size="sm"
                onClick={createNewNote}
                ariaLabel="Create new note"
              >
                New
              </Button>
            </div>

            <div className="SidebarSearch">
              <Input
                id="search-notes"
                label="Search notes"
                hideLabel
                placeholder="Search by title or content…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                inputRef={searchInputRef}
                showShortcutHint
              />
              <div className="SidebarMeta" aria-live="polite">
                {filteredNotes.length} {filteredNotes.length === 1 ? "note" : "notes"}
                {query.trim() ? " (filtered)" : ""}
              </div>
            </div>

            <div className="SidebarControls" aria-label="Sorting and filters">
              <div className="SidebarControlsRow">
                <div className="Field">
                  <label className="FieldLabel" htmlFor="sort-order">
                    Sort
                  </label>
                  <select
                    id="sort-order"
                    className="FieldSelect"
                    value={sortOrder}
                    onChange={(e) => setSortOrder(/** @type {SortOrder} */ (e.target.value))}
                  >
                    <option value="updated_desc">Updated (newest)</option>
                    <option value="created_desc">Created (newest)</option>
                    <option value="title_asc">Title (A→Z)</option>
                  </select>
                </div>

                <label className="Check" htmlFor="filter-content">
                  <input
                    id="filter-content"
                    type="checkbox"
                    checked={onlyWithContent}
                    onChange={(e) => setOnlyWithContent(e.target.checked)}
                  />
                  <span>Only with content</span>
                </label>
              </div>
            </div>
          </div>

          <div
            className="NoteList"
            role="listbox"
            aria-label="Notes list"
            tabIndex={0}
            onKeyDown={onNoteListKeyDown}
          >
            {filteredNotes.length === 0 ? (
              notes.length === 0 ? (
                <div className="SidebarEmptyHint" aria-live="polite">
                  <span className="SidebarEmptyHintText">Create your first note to get started.</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={createNewNote}
                    ariaLabel="Create your first note"
                  >
                    New note
                  </Button>
                </div>
              ) : (
                <EmptyState
                  title="No matching notes"
                  description="Try a different search term, or turn off filters."
                  actionLabel="Clear search"
                  onAction={() => setQuery("")}
                />
              )
            ) : (
              filteredNotes.map((note) => (
                <NoteListItem
                  key={note.id}
                  note={note}
                  isSelected={note.id === selectedId}
                  onSelect={() => onSelectNote(note.id)}
                />
              ))
            )}
          </div>
        </aside>

        <main className="Main" aria-label="Note editor">
          {selectedNote ? (
            <NoteEditor
              noteId={selectedNote.id}
              createdAt={selectedNote.createdAt}
              updatedAt={selectedNote.updatedAt}
              title={draftTitle}
              content={draftContent}
              isDirty={isDirty}
              lastSavedAt={lastSavedAtRef.current}
              onTitleChange={updateDraftTitle}
              onTitleBlur={onTitleBlur}
              onContentChange={updateDraftContent}
              onDelete={requestDeleteSelected}
              contentRef={editorTextAreaRef}
            />
          ) : (
            <div className="MainSurface">
              {showMainEmpty ? (
                <EmptyState
                  title="Welcome to Ocean Notes"
                  description="Create your first note. Everything is saved locally, and works offline."
                  actionLabel="Create your first note"
                  onAction={createNewNote}
                />
              ) : (
                <EmptyState
                  title="Select a note"
                  description="Choose a note from the sidebar, or create a new one."
                  actionLabel="Create a note"
                  onAction={createNewNote}
                />
              )}
            </div>
          )}
        </main>
      </div>

      <ConfirmModal
        isOpen={isConfirmOpen}
        title="Delete note?"
        description="This action cannot be undone."
        confirmText="Delete"
        cancelText="Cancel"
        tone="danger"
        onConfirm={confirmDeleteSelected}
        onCancel={cancelDelete}
      />
    </div>
  );
}

/* ----------------------------- Components ----------------------------- */

function Header({ onNew, onDelete, canDelete, env, banner, isLoading, saveStatusLabel }) {
  const bannerToneClass =
    banner?.tone === "danger"
      ? "Pill"
      : banner?.tone === "primary"
        ? "Pill PillPrimary"
        : "Pill PillMuted";

  return (
    <header className="Header">
      <div className="HeaderLeft">
        <div className="BrandMark" aria-hidden="true" />
        <div>
          <div className="HeaderTitle">Ocean Notes</div>
          <div className="HeaderSubtitle">Local-first notes • Autosave • Search</div>
        </div>
      </div>

      <div className="HeaderRight" role="toolbar" aria-label="App actions">
        {/* Non-blocking save status */}
        <span className="Pill PillMuted" aria-live="polite" title="Save status">
          {saveStatusLabel}
        </span>

        {/* Minimal, non-disruptive status */}
        {isLoading ? (
          <span className="Pill PillMuted" aria-live="polite">
            Loading…
          </span>
        ) : null}
        {banner?.message ? (
          <span className={bannerToneClass} aria-live="polite" title={banner.message}>
            {banner.message}
          </span>
        ) : null}

        <Button variant="ghost" onClick={onNew} ariaLabel="Create new note">
          New
        </Button>
        <Button
          variant="danger"
          onClick={onDelete}
          disabled={!canDelete}
          ariaLabel="Delete selected note"
        >
          Delete
        </Button>

        {/* Optional environment awareness; non-blocking and safe */}
        {env?.backendUrl ? (
          <span className="Pill" title={`Backend configured: ${env.backendUrl}`}>
            Backend configured
          </span>
        ) : (
          <span className="Pill PillMuted" title="No backend configured; local-only mode">
            Local mode
          </span>
        )}
      </div>
    </header>
  );
}

function NoteListItem({ note, isSelected, onSelect }) {
  const title = (note.title || "Untitled note").trim() || "Untitled note";
  const preview = (note.content || "").trim().slice(0, 80);

  return (
    <button
      type="button"
      className={`NoteListItem ${isSelected ? "isSelected" : ""}`}
      onClick={onSelect}
      role="option"
      aria-selected={isSelected}
    >
      <div className="NoteListItemTitle">{title}</div>
      <div className="NoteListItemMeta">
        <span className="NoteListItemDate">{formatDate(note.updatedAt)}</span>
        {preview ? <span className="NoteListItemDot">•</span> : null}
        {preview ? <span className="NoteListItemPreview">{preview}</span> : null}
      </div>
    </button>
  );
}

function NoteEditor({
  noteId,
  createdAt,
  updatedAt,
  title,
  content,
  isDirty,
  onTitleChange,
  onTitleBlur,
  onContentChange,
  onDelete,
  contentRef,
}) {
  return (
    <section className="MainSurface">
      <div className="EditorHeader">
        <div className="EditorMeta" aria-live="polite">
          <span className="Pill PillPrimary">Editing</span>
          <span className="EditorMetaText">{isDirty ? "Unsaved changes…" : "All changes saved"}</span>
          <span className="EditorMetaDivider" aria-hidden="true">
            |
          </span>
          <span className="EditorMetaText">Updated {formatDateTime(updatedAt)}</span>
          <span className="EditorMetaDivider" aria-hidden="true">
            |
          </span>
          <span className="EditorMetaText">Created {formatDateTime(createdAt)}</span>
        </div>

        <div className="EditorActions" role="toolbar" aria-label="Editor actions">
          <Button variant="danger" onClick={onDelete} ariaLabel="Delete this note">
            Delete
          </Button>
        </div>
      </div>

      <div className="EditorBody">
        <Input
          id="note-title-input"
          label="Title"
          value={title}
          onChange={(e) => onTitleChange(e.target.value)}
          onBlur={onTitleBlur}
          placeholder="Untitled note"
          autoComplete="off"
        />
        <TextArea
          id={`note-content-${noteId}`}
          label="Content"
          value={content}
          onChange={(e) => onContentChange(e.target.value)}
          placeholder="Write your note…"
          rows={14}
          inputRef={contentRef}
        />
      </div>

      <div className="EditorFooter">
        <span className="Hint">
          Tip: Use <kbd>↑</kbd>/<kbd>↓</kbd> to navigate notes in the sidebar. Create note with{" "}
          <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>N</kbd>.
        </span>
      </div>
    </section>
  );
}

function EmptyState({ title, description, actionLabel, onAction }) {
  return (
    <div className="EmptyState" role="status" aria-live="polite">
      <div className="EmptyIcon" aria-hidden="true" />
      <div className="EmptyTitle">{title}</div>
      <div className="EmptyDescription">{description}</div>
      {actionLabel ? (
        <Button variant="primary" onClick={onAction} ariaLabel={actionLabel}>
          {actionLabel}
        </Button>
      ) : null}
    </div>
  );
}

/* ------------------------------- UI Kit ------------------------------ */

function Button({
  children,
  variant = "primary",
  size = "md",
  disabled = false,
  onClick,
  ariaLabel,
  type = "button",
}) {
  const className = `Btn Btn--${variant} Btn--${size}`;
  return (
    <button
      type={type}
      className={className}
      disabled={disabled}
      onClick={onClick}
      aria-label={ariaLabel}
    >
      {children}
    </button>
  );
}

function Input({
  id,
  label,
  hideLabel = false,
  value,
  onChange,
  onBlur,
  placeholder,
  autoComplete,
  inputRef,
  showShortcutHint = false,
}) {
  const [showHint, setShowHint] = useState(false);

  return (
    <div className="Field SidebarSearchField">
      <label className={`FieldLabel ${hideLabel ? "srOnly" : ""}`} htmlFor={id}>
        {label}
      </label>

      <div className="InputWrap">
        <input
          id={id}
          className="FieldInput"
          value={value}
          onChange={onChange}
          onBlur={(e) => {
            setShowHint(false);
            if (onBlur) onBlur(e);
          }}
          onFocus={() => {
            if (showShortcutHint) setShowHint(true);
          }}
          placeholder={placeholder}
          autoComplete={autoComplete}
          ref={inputRef}
        />

        {showShortcutHint && showHint ? (
          <div className="KeyHint" role="tooltip" aria-label="Keyboard shortcuts">
            <span className="Hint">
              <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>F</kbd> search • <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>N</kbd>{" "}
              new
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function TextArea({ id, label, value, onChange, placeholder, rows = 10, inputRef }) {
  return (
    <div className="Field">
      <label className="FieldLabel" htmlFor={id}>
        {label}
      </label>
      <textarea
        id={id}
        className="FieldTextArea"
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        rows={rows}
        ref={inputRef}
      />
    </div>
  );
}

function ConfirmModal({
  isOpen,
  title,
  description,
  confirmText,
  cancelText,
  tone = "danger",
  onConfirm,
  onCancel,
}) {
  const confirmRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return;
    // Focus primary action for keyboard users
    requestAnimationFrame(() => confirmRef.current?.focus());
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const onKeyDown = (e) => {
      if (e.key === "Escape") onCancel();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, onCancel]);

  if (!isOpen) return null;

  return (
    <div className="ModalOverlay" role="presentation" onMouseDown={onCancel}>
      <div
        className="Modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-desc"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="ModalHeader">
          <div className="ModalTitle" id="confirm-title">
            {title}
          </div>
          <button className="IconBtn" onClick={onCancel} aria-label="Close dialog">
            ×
          </button>
        </div>
        <div className="ModalBody">
          <div className="ModalDescription" id="confirm-desc">
            {description}
          </div>
        </div>
        <div className="ModalFooter">
          <Button variant="ghost" onClick={onCancel} ariaLabel={cancelText}>
            {cancelText}
          </Button>
          <button
            type="button"
            className={`Btn Btn--${tone === "danger" ? "danger" : "primary"} Btn--md`}
            onClick={onConfirm}
            aria-label={confirmText}
            ref={confirmRef}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------- Helpers ------------------------------ */

function normalizeTitle(title) {
  const t = (title ?? "").trim();
  return t.length ? t : "Untitled note";
}

function makeId() {
  // reasonably unique for local usage
  return `n_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
}

function loadNotesWithSeed() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return seedNotes();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return seedNotes();

    // Basic validation
    const cleaned = parsed
      .filter((n) => n && typeof n === "object" && typeof n.id === "string")
      .map((n) => ({
        id: String(n.id),
        title: typeof n.title === "string" ? n.title : "",
        content: typeof n.content === "string" ? n.content : "",
        createdAt: typeof n.createdAt === "number" ? n.createdAt : Date.now(),
        updatedAt: typeof n.updatedAt === "number" ? n.updatedAt : Date.now(),
      }));

    return cleaned.length ? cleaned : seedNotes();
  } catch (e) {
    return seedNotes();
  }
}

function seedNotes() {
  const now = Date.now();
  const oneHour = 60 * 60 * 1000;
  const mk = (title, content, offset) => ({
    id: makeId(),
    title,
    content,
    createdAt: now - offset,
    updatedAt: now - offset,
  });

  return [
    mk(
      "Welcome to Ocean Notes",
      "This is a simple, local-first notes app.\n\n• Create notes\n• Search by title or content\n• Autosave while typing\n• Delete with confirmation\n\nYour notes are stored in localStorage on this device.",
      oneHour * 2
    ),
    mk(
      "Keyboard tip",
      "Shortcuts:\n• Ctrl/Cmd+N to create a note\n• Ctrl/Cmd+F to focus search\n• Ctrl/Cmd+Backspace to delete the current note\n\nClick the notes list, then use ↑ / ↓ to move between notes.",
      oneHour
    ),
  ];
}

/**
 * @param {string} content
 * @returns {string}
 */
function generateTitleFromContent(content) {
  const raw = String(content ?? "");
  const lines = raw.split(/\r?\n/);
  const firstNonEmpty = lines.map((l) => l.trim()).find((l) => l.length > 0) || "";
  if (!firstNonEmpty) return "Untitled note";
  return firstNonEmpty.length > 60 ? `${firstNonEmpty.slice(0, 60).trim()}…` : firstNonEmpty;
}

/**
 * A note is considered "fully empty" when it has no meaningful title AND no content.
 * @param {{title?: string, content?: string}} note
 * @returns {boolean}
 */
function isNoteFullyEmpty(note) {
  const t = (note?.title ?? "").trim();
  const c = (note?.content ?? "").trim();
  const titleMeaningful = t.length > 0 && t.toLowerCase() !== "untitled note";
  return !titleMeaningful && c.length === 0;
}

/**
 * @param {any} a
 * @param {any} b
 * @param {SortOrder} order
 * @returns {number}
 */
function sortNotes(a, b, order) {
  if (order === "created_desc") return (b.createdAt || 0) - (a.createdAt || 0);
  if (order === "title_asc") {
    const at = ((a.title || "").trim() || "Untitled note").toLowerCase();
    const bt = ((b.title || "").trim() || "Untitled note").toLowerCase();
    return at.localeCompare(bt);
  }
  // default: updated desc
  return (b.updatedAt || 0) - (a.updatedAt || 0);
}

function formatDate(ms) {
  try {
    const d = new Date(ms);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

function formatDateTime(ms) {
  try {
    const d = new Date(ms);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

export default App;
