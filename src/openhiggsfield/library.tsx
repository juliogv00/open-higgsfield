"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import {
  createCharacter,
  deleteObject,
  listCharacters,
  listObjects,
  saveObject,
  stageObject,
  uploadMedia,
} from "@/generation/actions";
import type { ModelEntry } from "@/generation/catalog";
import type { ObjectSet } from "@/generation/library";
import type { Character } from "@/generation/platform";
import { useCharacter } from "@/generation/stores/character";
import { useImageMedia, useVideoMedia } from "@/generation/stores/media";

import { CheckIcon, CloseIcon, ObjectIcon, PersonIcon, PlusIcon, TrashIcon } from "./icons";
import { Field, Slider } from "./ui";

/* Training takes minutes; the list is re-read on this clock while any
   character is still on its way. */
const CHARACTER_POLL_MS = 10_000;
/* Photos go up a few at a time: one at a time takes minutes for forty, all at
   once stalls the server action queue. */
const UPLOAD_CONCURRENCY = 4;

const STATUS_LABELS: Record<string, string> = {
  not_ready: "Waiting",
  queued: "Queued",
  in_progress: "Training",
  completed: "Ready",
  failed: "Failed",
};

function message(caught: unknown, fallback: string) {
  return caught instanceof Error && caught.message ? caught.message : fallback;
}

function training(character: Character) {
  return character.status !== "completed" && character.status !== "failed";
}

/** The characters the platform holds for this key, kept fresh while any of
    them is still training. */
function useCharacters(enabled = true) {
  const [characters, setCharacters] = useState<Character[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setCharacters(await listCharacters());
      setError(null);
    } catch (caught) {
      setError(message(caught, "Could not read your characters"));
    }
  }, []);

  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, refresh]);

  const pending = characters?.some(training) ?? false;
  useEffect(() => {
    if (!enabled || !pending) return;
    const timer = setInterval(() => void refresh(), CHARACTER_POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, pending, refresh]);

  return { characters, error, refresh, setCharacters };
}

async function uploadAll(files: File[], onProgress: (done: number) => void): Promise<string[]> {
  const urls: string[] = new Array(files.length);
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < files.length) {
      const index = next++;
      const form = new FormData();
      form.set("file", files[index]!);
      urls[index] = (await uploadMedia(form)).url;
      onProgress(++done);
    }
  }
  await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, files.length) }, worker));
  return urls;
}

/* ── Dialog shell ─────────────────────────────────────────────────────── */

function LibraryDialog({
  title,
  copy,
  onClose,
  children,
}: {
  title: string;
  copy: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    panelRef.current?.focus();
  }, []);
  const titleId = `ohf-lib-${title.toLowerCase()}`;
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      <div ref={panelRef} tabIndex={-1} className="ohf-dialog-panel ohf-lib-panel">
        <div className="ohf-keys-head">
          <div>
            <div id={titleId} className="ohf-keys-title">
              {title}
            </div>
            <p className="ohf-keys-copy">{copy}</p>
          </div>
          <button type="button" className="ohf-icon-btn" aria-label="Close" onClick={onClose}>
            <CloseIcon size={13} />
          </button>
        </div>
        <div className="ohf-lib-body ohf-scroll">{children}</div>
      </div>
    </dialog>
  );
}

/** Picked files with a preview where the browser can draw one. Chrome cannot
    decode HEIC, so those tiles carry the file name instead — the server
    converts them on upload. */
function FileTray({
  files,
  onRemove,
}: {
  files: File[];
  onRemove: (index: number) => void;
}) {
  const [previews, setPreviews] = useState<string[]>([]);
  useEffect(() => {
    const urls = files.map((file) => URL.createObjectURL(file));
    setPreviews(urls);
    return () => urls.forEach((url) => URL.revokeObjectURL(url));
  }, [files]);
  if (files.length === 0) return null;
  return (
    <ul className="ohf-lib-tray">
      {files.map((file, index) => (
        <li key={`${file.name}-${index}`} className="ohf-lib-tray-item" title={file.name}>
          <span className="ohf-lib-tray-name">{file.name.replace(/\.[^.]+$/, "")}</span>
          {previews[index] && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={previews[index]}
              alt=""
              onError={(event) => {
                event.currentTarget.style.display = "none";
              }}
            />
          )}
          <button
            type="button"
            className="ohf-lib-tray-x"
            aria-label={`Remove ${file.name}`}
            onClick={() => onRemove(index)}
          >
            <CloseIcon size={10} />
          </button>
        </li>
      ))}
    </ul>
  );
}

function FilePickButton({
  label,
  onFiles,
}: {
  label: string;
  onFiles: (files: File[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        hidden
        multiple
        accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif"
        onChange={(event) => {
          const picked = Array.from(event.target.files ?? []);
          event.target.value = "";
          if (picked.length) onFiles(picked);
        }}
      />
      <button type="button" className="ohf-btn-quiet ohf-lib-add" onClick={() => inputRef.current?.click()}>
        <PlusIcon size={13} />
        {label}
      </button>
    </>
  );
}

/* ── Characters ───────────────────────────────────────────────────────── */

/* Mirrors the bounds createCharacter enforces on the server. */
const MIN_PHOTOS = 5;
const MAX_PHOTOS = 80;

export function CharactersDialog({ onClose }: { onClose: () => void }) {
  const { characters, error: listError, setCharacters } = useCharacters();
  const picked = useCharacter((state) => state.id);
  const pick = useCharacter((state) => state.pick);
  const [name, setName] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [phase, setPhase] = useState<"idle" | "uploading" | "training">("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const min = MIN_PHOTOS;
  const max = MAX_PHOTOS;
  const ready = phase === "idle" && name.trim().length > 0 && files.length >= min && files.length <= max;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!ready) return;
    setError(null);
    setPhase("uploading");
    setProgress(0);
    try {
      const urls = await uploadAll(files, setProgress);
      setPhase("training");
      const created = await createCharacter({ name: name.trim(), imageUrls: urls });
      setCharacters((prev) => [created, ...(prev ?? [])]);
      setName("");
      setFiles([]);
    } catch (caught) {
      setError(message(caught, "Training could not start"));
    } finally {
      setPhase("idle");
    }
  }

  return (
    <LibraryDialog
      title="Characters"
      copy="A character is a Soul ID trained on your photos. Train it once, then pick it on Soul 2 or Soul Cinema as often as you like."
      onClose={onClose}
    >
      <section className="ohf-lib-section" aria-label="Your characters">
        {listError && <p className="ohf-lib-error">{listError}</p>}
        {characters === null && !listError && <p className="ohf-lib-empty">Loading…</p>}
        {characters?.length === 0 && <p className="ohf-lib-empty">No characters yet. Train the first one below.</p>}
        {characters && characters.length > 0 && (
          <ul className="ohf-lib-grid">
            {characters.map((character) => {
              const selected = picked === character.id;
              const usable = character.status === "completed";
              return (
                <li key={character.id} className="ohf-lib-card" data-selected={selected}>
                  <span className="ohf-lib-thumb">
                    {character.thumbnailUrl ? (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img src={character.thumbnailUrl} alt="" />
                    ) : (
                      <PersonIcon size={22} />
                    )}
                  </span>
                  <span className="ohf-lib-card-text">
                    <span className="ohf-lib-card-name">{character.name}</span>
                    <span className="ohf-lib-status" data-status={character.status}>
                      {STATUS_LABELS[character.status] ?? character.status}
                      {character.failReason ? ` — ${character.failReason}` : ""}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="ohf-btn-quiet"
                    disabled={!usable}
                    aria-pressed={selected}
                    onClick={() => pick(selected ? null : { id: character.id, name: character.name })}
                  >
                    {selected ? (
                      <>
                        <CheckIcon size={12} /> In use
                      </>
                    ) : (
                      "Use"
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <form className="ohf-lib-section ohf-lib-form" onSubmit={(event) => void onSubmit(event)}>
        <div className="ohf-lib-section-title">Train a new character</div>
        <label className="ohf-field">
          <div className="ohf-field-label">Name</div>
          <input
            className="ohf-input"
            value={name}
            maxLength={60}
            placeholder="Julio"
            onChange={(event) => setName(event.target.value)}
          />
        </label>

        <Field label="Photos" value={`${files.length} of ${min}–${max}`}>
          <p className="ohf-lib-hint">
            One person only. 20 or more works best: face from different angles and expressions,
            good light, at least one full-body shot. No sunglasses, no other people, no cropped
            faces. HEIC from the iPhone is fine.
          </p>
          <FileTray files={files} onRemove={(index) => setFiles((prev) => prev.filter((_, i) => i !== index))} />
          <FilePickButton
            label={files.length ? "Add more photos" : "Choose photos"}
            onFiles={(picked) => setFiles((prev) => [...prev, ...picked].slice(0, max))}
          />
        </Field>

        <p className="ohf-lib-hint">
          Training draws on your Higgsfield balance and takes about ten minutes. The real cost shows on the
          Higgsfield dashboard.
        </p>
        {error && <p className="ohf-lib-error">{error}</p>}

        <div className="ohf-keys-actions">
          <button type="submit" className="ohf-keys-save" disabled={!ready}>
            {phase === "uploading"
              ? `Uploading ${progress}/${files.length}…`
              : phase === "training"
                ? "Starting training…"
                : "Train character"}
          </button>
        </div>
      </form>
    </LibraryDialog>
  );
}

/** The composer's character panel: pick who is in the picture and how hard
    the model holds to them. */
export function CharacterPopover({ onManage }: { onManage: () => void }) {
  const { characters, error } = useCharacters();
  const state = useCharacter();
  const ready = characters?.filter((character) => character.status === "completed") ?? [];
  const busy = characters?.filter(training) ?? [];
  return (
    <div className="ohf-popover ohf-popover--setting ohf-lib-pop" role="dialog" aria-label="Character">
      <Field label="Character">
        <div className="ohf-opts" role="group">
          <button type="button" className="ohf-opt" aria-pressed={state.id === null} onClick={() => state.pick(null)}>
            <span className="ohf-opt-label">None</span>
            {state.id === null && (
              <span className="ohf-opt-check" aria-hidden>
                <CheckIcon size={12} />
              </span>
            )}
          </button>
          {ready.map((character) => (
            <button
              key={character.id}
              type="button"
              className="ohf-opt"
              aria-pressed={state.id === character.id}
              onClick={() => state.pick({ id: character.id, name: character.name })}
            >
              <span className="ohf-opt-label">{character.name}</span>
              {state.id === character.id && (
                <span className="ohf-opt-check" aria-hidden>
                  <CheckIcon size={12} />
                </span>
              )}
            </button>
          ))}
        </div>
      </Field>
      {characters === null && !error && <p className="ohf-lib-hint">Loading…</p>}
      {busy.length > 0 && (
        <p className="ohf-lib-hint">
          {busy.map((character) => character.name).join(", ")} still training.
        </p>
      )}
      {error && <p className="ohf-lib-error">{error}</p>}
      {state.id && (
        <Field label="Likeness" value={state.strength.toFixed(2)}>
          <Slider min={0} max={1} step={0.05} value={state.strength} label="Likeness" onChange={state.setStrength} />
        </Field>
      )}
      <p className="ohf-lib-hint">
        Soul takes no reference images. To put an object in the shot, switch to Qwen Image 3 Edit, attach
        this result first and the object after it.
      </p>
      <button type="button" className="ohf-btn-quiet ohf-lib-manage" onClick={onManage}>
        Manage characters
      </button>
    </div>
  );
}

/* ── Objects ──────────────────────────────────────────────────────────── */

function useObjects() {
  const [objects, setObjects] = useState<ObjectSet[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setObjects(await listObjects());
      setError(null);
    } catch (caught) {
      setError(message(caught, "Could not read the object library"));
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { objects, error, refresh };
}

function objectThumb(set: ObjectSet, file = set.files[0]) {
  return file ? `/api/objects/${set.id}/${file}` : null;
}

export function ObjectsDialog({ onClose }: { onClose: () => void }) {
  const { objects, error: listError, refresh } = useObjects();
  const [name, setName] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.set("name", name.trim());
      for (const file of files) form.append("files", file);
      await saveObject(form);
      setName("");
      setFiles([]);
      await refresh();
    } catch (caught) {
      setError(message(caught, "Could not save the object"));
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(set: ObjectSet) {
    if (!window.confirm(`Delete "${set.name}" and its ${set.files.length} images from this Mac?`)) return;
    try {
      await deleteObject(set.id);
      await refresh();
    } catch (caught) {
      setError(message(caught, "Could not delete the object"));
    }
  }

  return (
    <LibraryDialog
      title="Objects"
      copy="Named sets of reference images — a product, a garment, a prop. They stay on this Mac and attach as references to any model that takes them — Qwen Image 3 Edit is the one that puts them into a Soul shot. Single-reference models only get the first image."
      onClose={onClose}
    >
      <section className="ohf-lib-section" aria-label="Your objects">
        {listError && <p className="ohf-lib-error">{listError}</p>}
        {objects === null && !listError && <p className="ohf-lib-empty">Loading…</p>}
        {objects?.length === 0 && <p className="ohf-lib-empty">No objects yet. Save the first one below.</p>}
        {objects && objects.length > 0 && (
          <ul className="ohf-lib-grid">
            {objects.map((set) => (
              <li key={set.id} className="ohf-lib-card">
                <span className="ohf-lib-thumb">
                  {objectThumb(set) ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img src={objectThumb(set)!} alt="" />
                  ) : (
                    <ObjectIcon size={22} />
                  )}
                </span>
                <span className="ohf-lib-card-text">
                  <span className="ohf-lib-card-name">{set.name}</span>
                  <span className="ohf-lib-status">
                    {set.files.length} image{set.files.length === 1 ? "" : "s"}
                  </span>
                </span>
                <button
                  type="button"
                  className="ohf-icon-btn"
                  aria-label={`Delete ${set.name}`}
                  title="Delete"
                  onClick={() => void onDelete(set)}
                >
                  <TrashIcon size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <form className="ohf-lib-section ohf-lib-form" onSubmit={(event) => void onSubmit(event)}>
        <div className="ohf-lib-section-title">Save a new object</div>
        <label className="ohf-field">
          <div className="ohf-field-label">Name</div>
          <input
            className="ohf-input"
            value={name}
            maxLength={60}
            placeholder="Running shoe, white"
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <Field label="Images" value={`${files.length} of 14`}>
          <p className="ohf-lib-hint">
            Clean shots of the same object from a few angles. Plain background helps. Put the clearest view
            first.
          </p>
          <FileTray files={files} onRemove={(index) => setFiles((prev) => prev.filter((_, i) => i !== index))} />
          <FilePickButton
            label={files.length ? "Add more images" : "Choose images"}
            onFiles={(picked) => setFiles((prev) => [...prev, ...picked].slice(0, 14))}
          />
        </Field>
        {error && <p className="ohf-lib-error">{error}</p>}
        <div className="ohf-keys-actions">
          <button type="submit" className="ohf-keys-save" disabled={busy || !name.trim() || files.length === 0}>
            {busy ? "Saving…" : "Save object"}
          </button>
        </div>
      </form>
    </LibraryDialog>
  );
}

/** The composer's object panel: one press re-uploads a saved set and lays it
    on the plane as references, up to what the model accepts. */
export function ObjectsPopover({
  model,
  onManage,
  onDone,
  onError,
}: {
  model: ModelEntry;
  onManage: () => void;
  onDone: () => void;
  onError: (message: string | null) => void;
}) {
  const { objects, error } = useObjects();
  const imageMedia = useImageMedia();
  const videoMedia = useVideoMedia();
  const media = model.surface === "image" ? imageMedia : videoMedia;
  const [loading, setLoading] = useState<string | null>(null);
  const cap = model.roles.reference ?? 0;
  const used = media.items.filter((item) => item.role === "reference").length;
  const room = Math.max(0, cap - used);

  async function attach(set: ObjectSet) {
    if (room === 0) return;
    setLoading(set.id);
    onError(null);
    try {
      const urls = await stageObject(set.id, room);
      for (const url of urls) media.add({ id: crypto.randomUUID(), url, role: "reference" });
      onDone();
    } catch (caught) {
      onError(`Could not attach ${set.name} — ${message(caught, "upload failed")}`);
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="ohf-popover ohf-popover--setting ohf-lib-pop" role="dialog" aria-label="Objects">
      <Field label="Objects" value={`${used}/${cap} refs`}>
        {room === 0 && <p className="ohf-lib-hint">This model&apos;s reference slots are full.</p>}
        {objects?.length === 0 && <p className="ohf-lib-hint">No objects saved yet.</p>}
        {error && <p className="ohf-lib-error">{error}</p>}
        {objects && objects.length > 0 && (
          <div className="ohf-opts" role="group">
            {objects.map((set) => (
              <button
                key={set.id}
                type="button"
                className="ohf-opt ohf-lib-opt"
                disabled={room === 0 || loading !== null}
                onClick={() => void attach(set)}
              >
                {objectThumb(set) && (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img className="ohf-lib-opt-thumb" src={objectThumb(set)!} alt="" />
                )}
                <span className="ohf-opt-label">{set.name}</span>
                <span className="ohf-lib-opt-meta">
                  {loading === set.id ? "…" : `+${Math.min(room, set.files.length)}`}
                </span>
              </button>
            ))}
          </div>
        )}
      </Field>
      <button type="button" className="ohf-btn-quiet ohf-lib-manage" onClick={onManage}>
        Manage objects
      </button>
    </div>
  );
}
