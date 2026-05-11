// =============================================================================
// src/services/llmService.ts
// Irminsul — Tier 2: LLM Generation Service
//
// Schema architecture (two-schema pattern):
//
//   llmOutputSchema   — What we ASK the model to return.
//                       Minimal: only title, slug, description. No DB fields.
//                       No regex constraints on slug — loose enough for the
//                       model to succeed, tight enough to be useful.
//
//   GeneratedGoal     — What goalService.ts RECEIVES from this module.
//                       Full shape: includes last_verified_at: null.
//                       Produced by mapping llmOutputSchema output after the
//                       call, with programmatic slug sanitization applied.
//
// Why two schemas instead of one:
//   The original single schema passed DB-awareness (last_verified_at: z.null(),
//   slug regex) directly to generateObject, which converts the Zod schema into
//   a JSON Schema tool definition and sends it to the Anthropic API. The model
//   then has to satisfy all constraints in a single generation pass:
//     - Haiku occasionally omits fields it considers irrelevant (last_verified_at)
//       causing schema check failures even though the output is usable.
//     - The slug regex becomes a JSON Schema `pattern` constraint in the tool
//       definition; minor slug formatting variations cause hard failures instead
//       of being fixable in post-processing.
//   Decoupling lets the model do what it is good at (generating content) while
//   the application layer handles normalization and typing.
//
// Model: claude-haiku-4-5-20251001
//   Do NOT revert to claude-3-haiku-20240307. Retired April 19, 2026.
//   All requests to that model ID return errors. No automatic fallback exists.
// =============================================================================

import { generateObject } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// MODEL_SELECTION
// Pinned constant — grep target for deprecation audits. One place to update.
// ---------------------------------------------------------------------------
const LLM_MODEL = 'claude-haiku-4-5-20251001';

// ---------------------------------------------------------------------------
// Schema 1: llmOutputSchema — the model-facing contract
//
// Deliberately minimal. Three fields only. No DB metadata. No regex pattern
// on slug so the JSON Schema tool definition stays simple and the model has
// headroom to produce a reasonable slug without hitting pattern failures.
//
// Slug sanitization happens in normalizeLlmOutput() after the call, not here.
// ---------------------------------------------------------------------------
const llmOutputSchema = z.object({
  title: z
    .string()
    .describe(
      'A concise, human-readable title for the learning goal. 3-7 words. Title Case. Example: "Learn Python Scripting"',
    ),

  slug: z
    .string()
    .describe(
      'URL-safe identifier. Entirely lowercase. Words separated by single hyphens. No spaces, underscores, or special characters. Example: "learn-python-scripting"',
    ),

  description: z
    .string()
    .describe(
      '1-2 sentences describing what the learner will achieve. Plain text, no markdown.',
    ),
});

/** Raw output from the LLM before mapping — not yet the GoalService contract. */
type LlmOutput = z.infer<typeof llmOutputSchema>;

// ---------------------------------------------------------------------------
// Exported type: GeneratedGoal — what goalService.ts receives
//
// Extends the LLM output with DB-metadata fields that are always set
// programmatically, never by the model. goalService.ts spreads this into
// a GoalSummary for the Tier 3 Supabase INSERT.
// ---------------------------------------------------------------------------

/**
 * The fully-mapped, normalized output of `generateGoalFromLLM`.
 *
 * Fields:
 *   title            — LLM-generated, whitespace-trimmed
 *   slug             — LLM-generated, sanitized to a valid URL slug
 *   description      — LLM-generated, whitespace-trimmed
 *   last_verified_at — always null (DB manages this field post-INSERT)
 *
 * DB-owned fields (id, access_count, created_at, updated_at) are absent
 * and are added by goalService.ts after the Supabase INSERT returns the row.
 */
export interface GeneratedGoal {
  title: string;
  slug: string;
  description: string;
  last_verified_at: null;
}

// ---------------------------------------------------------------------------
// Slug sanitization
//
// Applies the same normalization as toSlug() in goalService.ts so slugs
// written to the DB by Tier 3 are always retrievable by Tier 1a.
//
// Applied AFTER the API call — not as a schema constraint — so formatting
// edge cases (trailing hyphens, mixed case, stray punctuation in the model
// response) are corrected programmatically rather than causing a hard failure.
//
// Phase 3 gate: extract this and goalService's toSlug to @/utils/slug.ts.
// ---------------------------------------------------------------------------

function sanitizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '') // strip anything not alphanumeric, space, or hyphen
    .replace(/\s+/g, '-')          // collapse whitespace runs to a single hyphen
    .replace(/-+/g, '-')           // collapse consecutive hyphens
    .replace(/^-+|-+$/g, '');      // strip leading and trailing hyphens
}

// ---------------------------------------------------------------------------
// Post-call mapping
// ---------------------------------------------------------------------------

/**
 * Maps raw LLM output into the GeneratedGoal contract.
 *
 * 1. Trims whitespace from title and description.
 * 2. Sanitizes the slug via sanitizeSlug().
 * 3. Injects last_verified_at: null (DB-managed, never from the LLM).
 *
 * This is the explicit boundary between "what the model returned" and
 * "what the application uses." Keeping it as a named function makes the
 * transformation easy to test and audit in isolation.
 */
function normalizeLlmOutput(raw: LlmOutput): GeneratedGoal {
  return {
    title: raw.title.trim(),
    slug: sanitizeSlug(raw.slug),
    description: raw.description.trim(),
    last_verified_at: null,
  };
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `\
You are a pedagogical expert and curriculum architect for Irminsul, a gamified learning platform that generates structured "Tech Trees" — adaptive, node-based learning paths.

Your task is to analyze a user's stated learning goal and return a structured JSON object that seeds a new Tech Tree in the platform's database.

OUTPUT CONTRACT:
You must return exactly three fields: title, slug, and description.
No preamble, no explanation, no markdown. A bare JSON object only.

FIELD RULES:

title
- A concise, human-readable name for the learning goal.
- 3 to 7 words. Title Case.
- Generalize slight variations to a canonical form.
  Example: "i wanna learn python scripting" → "Learn Python Scripting"
- Do NOT include filler words like "How to", "A Guide to", or "Introduction to".

slug
- A URL-safe identifier derived from the title.
- The slug MUST be entirely lowercase and use hyphens for spaces.
- Lowercase letters and digits only. Words separated by single hyphens.
- No spaces, underscores, dots, slashes, capital letters, or special characters.
- No leading or trailing hyphens.
  Example: "Learn Python Scripting" → "learn-python-scripting"
  Example: "Master SQL Fundamentals" → "master-sql-fundamentals"

description
- 1 to 2 sentences. Plain text only — no markdown, no bullet points.
- State what domain or skill this goal covers and what concrete outcome the learner achieves.
- Do NOT describe the learning method, the platform, or the node structure.
- Do NOT start with "This goal..." or "This curriculum...".
  Good: "Python is a general-purpose language used in web development, data science, and automation. Mastering it unlocks access to the most in-demand engineering roles and research tools."
  Bad: "This curriculum will guide you step-by-step through Python concepts."`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Tier 2 LLM generation via Claude Haiku 4.5.
 *
 * Calls generateObject with llmOutputSchema — a minimal, model-friendly
 * schema with no DB fields and no slug regex pattern constraint. After a
 * successful call, normalizeLlmOutput maps the raw output into the full
 * GeneratedGoal contract expected by goalService.ts, including slug
 * sanitization and injection of last_verified_at: null.
 *
 * @param topic - The raw user input string (e.g., "learn python").
 * @returns GeneratedGoal — normalized and ready for Tier 3 write-back.
 * @throws AISDKError on network failure, rate limit, or model-level refusal.
 *         goalService.ts catches this in its top-level error boundary.
 */
export async function generateGoalFromLLM(topic: string): Promise<GeneratedGoal> {
  console.log(`[Irminsul/LLM] Tier 2 generation for topic: '${topic}'`);

  const { object } = await generateObject({
    model: anthropic(LLM_MODEL),
    schema: llmOutputSchema,
    system: SYSTEM_PROMPT,
    prompt: `Generate a Tech Tree goal for the following learning topic: "${topic}"`,
    // Temperature 0: deterministic output. The same topic must always produce
    // the same slug so Tier 1a cache hits work correctly on future requests.
    temperature: 0,
  });

  const normalized = normalizeLlmOutput(object);

  console.log(
    `[Irminsul/LLM] Tier 2 succeeded: '${normalized.title}' → slug: '${normalized.slug}'`,
  );

  return normalized;
}