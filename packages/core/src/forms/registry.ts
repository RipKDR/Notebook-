import type { FormBible, WorkForm } from "../types/bible.js";
import { fictionForm } from "./fiction.js";
import { memoirForm } from "./memoir.js";
import type { FormDefinition } from "./types.js";

/**
 * The form registry.
 *
 * Adding a form — essay collection, travel narrative, family history — means
 * adding one file and one line here, and touching nothing in the pipeline. That
 * is the whole point of the indirection: the stages ask the registry what this
 * work is supposed to be, and the registry answers.
 *
 * The casts are load-bearing and honest. `FormDefinition<T>` is contravariant in
 * T (its `renderBible` consumes a T), so `FormDefinition<FictionBible>` is not
 * assignable to `FormDefinition<FormBible>`. Soundness is preserved at runtime by
 * the invariant that a Bible tagged `form: "fiction"` is only ever handed to the
 * definition registered under that key — which `bibleFor` below enforces.
 */
const REGISTRY: Record<WorkForm, FormDefinition<FormBible>> = {
  fiction: fictionForm as unknown as FormDefinition<FormBible>,
  memoir: memoirForm as unknown as FormDefinition<FormBible>,
};

export function getForm(form: WorkForm): FormDefinition<FormBible> {
  const def = REGISTRY[form];
  if (def === undefined) {
    throw new RangeError(
      `Unknown work form "${form}". Registered: ${Object.keys(REGISTRY).join(", ")}`,
    );
  }
  return def;
}

export function listForms(): FormDefinition<FormBible>[] {
  return Object.values(REGISTRY);
}

/**
 * Renders a form-specific Bible through its own definition, guaranteeing the
 * definition and the payload agree on which form this is.
 */
export function renderFormBible(formBible: FormBible): string {
  return getForm(formBible.form).renderBible(formBible);
}

export { fictionForm, memoirForm };
export type { FormDefinition, StructuralPart } from "./types.js";
