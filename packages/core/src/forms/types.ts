import type { z } from "zod";
import type { FormBible, WorkForm } from "../types/bible.js";

/**
 * A work form is the pluggable unit of this system.
 *
 * Fiction and memoir look superficially similar — both are long-form prose built
 * from fragments — but they differ in the one place that matters most: what the
 * Bible has to hold, and therefore what the outliner is planning *towards*.
 *
 * Fiction is organised around causality. Scenes exist because the previous scene
 * made them inevitable, and the Bible must carry want, need and conflict so the
 * outliner can build a chain of consequence.
 *
 * Memoir is organised around a question. The events already happened and cannot
 * be reordered for dramatic convenience; what creates structure is the
 * retrospective narrator's inquiry into them. Its Bible must carry a governing
 * question and a stance, and its outliner assembles evidence rather than
 * escalating stakes.
 *
 * Hard-coding either would mean rewriting the pipeline to add the other. So the
 * stages are form-agnostic and every form supplies its own schema, prompt
 * contributions and structural template through this interface.
 */

export interface StructuralPart {
  /** Label shown to the user and used in the outline, e.g. "Act II" or "Part One: Before". */
  readonly name: string;
  /** Fraction of total words. Must sum to 1 across a form's parts. */
  readonly proportion: number;
  /** What this part has to accomplish. Goes verbatim into the outliner prompt. */
  readonly purpose: string;
}

export interface FormDefinition<T extends FormBible = FormBible> {
  readonly form: WorkForm;
  readonly label: string;
  /** One line, shown in the project-creation picker. */
  readonly description: string;

  /** Validates the form-specific half of a Bible. */
  readonly bibleSchema: z.ZodType<T>;

  /** Appended to the Bible-building system prompt. This is where form expertise lives. */
  bibleGuidance(): string;

  /** Appended to the outliner's system prompt. */
  outlineGuidance(): string;

  /** Appended to every scene-drafting system prompt. */
  sceneGuidance(): string;

  /** The structural template the outliner fills. */
  parts(): readonly StructuralPart[];

  /** Renders the form-specific Bible into the cached prompt prefix. */
  renderBible(bible: T): string;

  /**
   * Continuity dimensions this form cares most about. Memoir barely cares about
   * `possession` but cares intensely about `time`; fiction is the reverse.
   */
  continuityEmphasis(): readonly string[];
}
