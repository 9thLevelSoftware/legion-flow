import type { ReducerSpec, State, StateSchema } from "./types.js";

const OVERWRITE_MARK = Symbol.for("legion-flow.engine.overwrite");

/** Wrap a value to replace an appendable or upsertable field outright instead of merging into it. */
export function overwrite<T>(value: T): { [OVERWRITE_MARK]: true; value: T } {
  return { [OVERWRITE_MARK]: true, value };
}

function isOverwriteMarker(value: unknown): value is { [OVERWRITE_MARK]: true; value: unknown } {
  return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[OVERWRITE_MARK] === true;
}

export function reduceField(spec: ReducerSpec, previous: unknown, next: unknown): unknown {
  if (isOverwriteMarker(next)) return next.value;
  switch (spec.kind) {
    case "overwrite":
      return next;
    case "append": {
      const base = Array.isArray(previous) ? previous : previous === undefined ? [] : [previous];
      const add = Array.isArray(next) ? next : [next];
      return [...base, ...add];
    }
    case "upsertById": {
      const base = Array.isArray(previous) ? (previous as Record<string, unknown>[]) : [];
      const add = (Array.isArray(next) ? next : [next]) as Record<string, unknown>[];
      const merged = [...base];
      for (const item of add) {
        const idx = merged.findIndex((m) => m[spec.key] === item[spec.key]);
        if (idx >= 0) merged[idx] = { ...merged[idx], ...item };
        else merged.push(item);
      }
      return merged;
    }
    case "custom":
      return spec.reduce(previous, next);
  }
}

/** Fold one node's writes into the state. Fields not declared in the schema overwrite. */
export function applyWrites(schema: StateSchema, state: State, writes: State): State {
  const next: State = { ...state };
  for (const [field, value] of Object.entries(writes)) {
    const spec = schema[field] ?? { kind: "overwrite" };
    next[field] = reduceField(spec, state[field], value);
  }
  return next;
}

/** The part of the schema that enters the graph fingerprint: kinds and keys, never functions. */
export function describeSchema(schema: StateSchema): Record<string, string> {
  return Object.fromEntries(
    Object.entries(schema)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([field, spec]) => [field, spec.kind === "upsertById" ? `upsertById:${spec.key}` : spec.kind === "custom" ? `custom:${spec.name}` : spec.kind])
  );
}
