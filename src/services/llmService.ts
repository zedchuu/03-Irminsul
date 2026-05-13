// =============================================================================
// src/services/llmService.ts
// Irminsul — Tier 2: LLM Generation Service
//
// Schema architecture (two-schema pattern — preserved from Phase 2):
//
//   llmOutputSchema       — What we ASK the model to return.
//                           Phase 3.2: expanded to include nodes[] and milestones[].
//                           Still no DB fields, no slug regex — loose enough for
//                           the model to succeed, normalization handled post-call.
//
//   GoalGenerationPayload — What goalService.ts RECEIVES from this module.
//                           Phase 3.2: replaces GeneratedGoal. Full shape now
//                           includes nodes[] with temp_ids and milestones[].
//                           Slug derivation and DB-field injection happen in
//                           goalService.ts's generateAndPersist().
//
// Why two schemas instead of one (preserved from Phase 2):
//   The original single schema passed DB-awareness directly to generateObject,
//   which converts the Zod schema into a JSON Schema tool definition. The model
//   then had to satisfy all constraints in a single generation pass:
//     - Haiku occasionally omits fields it considers irrelevant (last_verified_at)
//       causing schema check failures even though the output is usable.
//     - The slug regex becomes a JSON Schema `pattern` constraint; minor slug
//       formatting variations cause hard failures instead of being fixable in
//       post-processing.
//   Decoupling lets the model do what it is good at (generating content) while
//   the application layer handles normalization and typing.
//
// Phase 3.2 changes vs Phase 2:
//   - `description` removed from the goal-level schema. Replaced by per-milestone
//     descriptions. goals.description is soft-deprecated; written as null.
//   - `slug` removed from the LLM contract — derived programmatically in
//     goalService.ts via toSlug(payload.title), same as before.
//   - `nodes[]` added with `temp_id` and `prerequisite_temp_ids`.
//   - `milestones[]` added — chapter-level groupings referencing node temp_ids.
//   - `normalizeLlmOutput` removed — no longer needed at this layer.
//     goalService.ts owns the full normalization + write-back pipeline.
//   - `GeneratedGoal` interface replaced by `GoalGenerationPayload`.
//   - `sanitizeSlug` moved to goalService.ts (same implementation, new home).
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
// Sub-schema: actionable task
// ---------------------------------------------------------------------------

const actionableTaskSchema = z.object({
  task: z.string().describe(
    'A concrete, measurable action. NOT "Practice X" — describe the exact activity.',
  ),
  success_criteria: z.string().describe(
    'How the learner knows they succeeded. Observable and specific, not subjective.',
  ),
  estimated_minutes: z.number().int().positive().describe(
    'Realistic time estimate in minutes for this specific task.',
  ),
});

// ---------------------------------------------------------------------------
// Sub-schema: generated node
//
// temp_id:
//   A stable human-readable key the LLM assigns (e.g., "temp-node-1").
//   Used ONLY within this payload to allow milestones to reference nodes
//   before real UUIDs exist. NEVER written to the database. goalService.ts
//   discards it after building the temp_id → real_uuid translation map.
//
// prerequisite_temp_ids:
//   LLM-declared prerequisite relationships expressed as temp_ids.
//   Resolved to real UUIDs and discarded by goalService.ts before the
//   node_prerequisites insert. Defaults to [] so root nodes can omit it.
// ---------------------------------------------------------------------------

const generatedNodeSchema = z.object({
  temp_id: z.string().describe(
    'Unique key for this node within this payload. E.g. "temp-node-1". ' +
    'Used by milestones to reference nodes before real UUIDs are assigned.',
  ),
  title: z.string().describe(
    'Short, specific title for this atomic learning concept. ' +
    'E.g. "Variables & Data Types".',
  ),
  lesson_context: z.string().describe(
    'The HOW and WHY of this concept — minimum 2 sentences. ' +
    'Explain what it is, why it matters, and the mental model a beginner needs. ' +
    'Never just restate the title.',
  ),
  actionable_tasks: z.array(actionableTaskSchema).min(1).describe(
    'Concrete, measurable tasks. Each task must have success_criteria. ' +
    '"Practice X" alone is not acceptable.',
  ),
  estimated_minutes: z.number().int().positive().describe(
    'Total estimated minutes to complete all tasks in this node.',
  ),
  prerequisite_temp_ids: z.array(z.string()).default([]).describe(
    'temp_ids of nodes that must be completed before this one. ' +
    'Must only reference temp_ids of other nodes in this same payload. ' +
    'Empty array for root nodes.',
  ),
});

// ---------------------------------------------------------------------------
// Sub-schema: milestone
//
// node_ids:
//   Contains temp_ids from generatedNodeSchema — NOT real UUIDs.
//   Referential integrity (every listed temp_id resolves to a real node) is
//   enforced downstream in goalService.ts. Orphaned IDs are filtered out with
//   a server warning rather than aborting the pipeline (graceful degradation).
//
// prerequisite_milestone_ids:
//   References the `id` of sibling milestones in this same payload.
//   These are stable string IDs written directly to milestone_graph after
//   node_ids are resolved. No translation required.
// ---------------------------------------------------------------------------

const milestoneSchema = z.object({
  id: z.string().describe(
    'Unique identifier for this milestone. E.g. "milestone-1", "milestone-2".',
  ),
  title: z.string().describe(
    'Chapter-level name for this group of nodes. ' +
    'E.g. "Foundations", "Intermediate Concepts", "Advanced Patterns".',
  ),
  description: z.string().describe(
    '1-2 sentences. What will the learner be able to DO after completing all ' +
    'nodes in this milestone? Plain text, no markdown.',
  ),
  prerequisite_milestone_ids: z.array(z.string()).default([]).describe(
    'IDs of milestones that must be completed before this one. ' +
    'Must only reference the `id` of other milestones in this payload.',
  ),
  node_ids: z.array(z.string()).default([]).describe(
    'The temp_ids of nodes that belong to this milestone. ' +
    'Every node should belong to exactly one milestone.',
  ),
});

// ---------------------------------------------------------------------------
// Root schema: llmOutputSchema — the model-facing contract
//
// Phase 3.2: title + nodes[] + milestones[].
// `description` and `slug` are no longer generated by the LLM:
//   - slug is derived programmatically from title in goalService.ts (toSlug).
//   - description is replaced by per-milestone descriptions.
// ---------------------------------------------------------------------------

const llmOutputSchema = z.object({
  title: z
    .string()
    .describe(
      'A concise, human-readable name for the learning goal. 3-7 words. Title Case. ' +
      'Generalize slight variations to a canonical form. ' +
      'Example: "i wanna learn python scripting" → "Learn Python Scripting". ' +
      'Do NOT include filler words like "How to", "A Guide to", or "Introduction to".',
    ),
  nodes: z.array(generatedNodeSchema).min(1).describe(
    'All atomic learning nodes for this curriculum. 6-12 nodes recommended. ' +
    'Every node must have a unique temp_id.',
  ),
  milestones: z.array(milestoneSchema).min(1).describe(
    '2-4 chapter-level groupings of nodes. Every node must belong to exactly one milestone. ' +
    'node_ids must reference temp_ids from the nodes array above.',
  ),
});

// ---------------------------------------------------------------------------
// Exported types — what goalService.ts receives
// ---------------------------------------------------------------------------

/**
 * The full validated output of `generateGoalFromLLM`.
 * Replaces `GeneratedGoal` from Phase 2.
 *
 * goalService.ts is responsible for all post-generation work:
 *   - Deriving slug via toSlug(payload.title)
 *   - Inserting the goal row (description: null — soft-deprecated)
 *   - Inserting nodes (stripping temp_id, assigning sequence_order by index)
 *   - Building the temp_id → real_uuid map via sequence_order bridge
 *   - Resolving milestone node_ids through that map (filtering orphans)
 *   - Writing milestone_graph back to the goal row
 */
export type GoalGenerationPayload = z.infer<typeof llmOutputSchema>;

/** A single validated node as the LLM emitted it — temp_id intact. */
export type GeneratedNode = z.infer<typeof generatedNodeSchema>;

/** A single validated milestone as the LLM emitted it — node_ids still temp. */
export type GeneratedMilestone = z.infer<typeof milestoneSchema>;

/**
 * A milestone with node_ids fully resolved from temp_ids to real Supabase UUIDs.
 * This is the shape written to goals.milestone_graph in Tier 3.
 * prerequisite_milestone_ids are stable string IDs — no translation needed.
 */
export interface ResolvedMilestone {
  id: string;
  title: string;
  description: string;
  prerequisite_milestone_ids: string[];
  node_ids: string[]; // real UUIDs — safe to store
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `\
You are a pedagogical expert and curriculum architect for Irminsul, a gamified learning platform that generates structured "Tech Trees" — adaptive, node-based learning paths.

Your task is to analyze a user's stated learning goal and return a single structured JSON object containing the full curriculum: a title, a flat list of atomic nodes, and chapter-level milestones grouping those nodes.

OUTPUT CONTRACT:
Return exactly three fields: title, nodes, milestones.
No preamble, no explanation, no markdown. A bare JSON object only.

FIELD RULES:

title
- A concise, human-readable name for the learning goal.
- 3 to 7 words. Title Case.
- Generalize slight variations to a canonical form.
  Example: "i wanna learn python scripting" → "Learn Python Scripting"
- Do NOT include filler words like "How to", "A Guide to", or "Introduction to".

nodes (array, 6-12 items)
- Each node is one atomic, learnable concept.
- Every node MUST have a unique temp_id (e.g., "temp-node-1", "temp-node-2").
- lesson_context MUST explain HOW and WHY, not just WHAT. Minimum 2 sentences.
- actionable_tasks MUST be concrete and measurable. "Practice X" alone is not acceptable. Each task needs success_criteria.
- prerequisite_temp_ids MUST only reference temp_ids of other nodes in this payload. Use [] for root nodes.
- The nodes must form a valid DAG — no circular prerequisites.

milestones (array, 2-4 items)
- Each milestone is a chapter-level grouping of nodes.
- Every milestone MUST have a unique id (e.g., "milestone-1", "milestone-2").
- node_ids MUST contain only temp_ids from the nodes array above.
- Every node MUST appear in exactly one milestone.
- prerequisite_milestone_ids MUST only reference the id of other milestones in this payload.
- description: 1-2 sentences on what the learner can DO after completing this milestone.`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Tier 2 LLM generation via Claude Haiku 4.5.
 *
 * Calls generateObject with the expanded llmOutputSchema (Phase 3.2).
 * Returns the raw validated payload — slug derivation, DB insertion, temp_id
 * translation, and milestone write-back all happen in goalService.ts.
 *
 * @param topic - The raw user input string (e.g., "learn python").
 * @returns GoalGenerationPayload — validated, temp_ids intact, ready for Tier 3.
 * @throws AISDKError on network failure, rate limit, or model-level refusal.
 *         ZodError if the model output fails schema validation.
 *         Both are caught by goalService.ts's top-level error boundary.
 */
export async function generateGoalFromLLM(topic: string): Promise<GoalGenerationPayload> {
  console.log(`[Irminsul/LLM] Tier 2 generation for topic: '${topic}'`);

  const { object } = await generateObject({
    model: anthropic(LLM_MODEL),
    schema: llmOutputSchema,
    system: SYSTEM_PROMPT,
    prompt: `Generate a complete structured curriculum for the following learning topic: "${topic}"`,
    // Temperature 0: deterministic output. The same topic must always produce
    // the same slug so Tier 1a cache hits work correctly on future requests.
    temperature: 0,
  });

  console.log(
    `[Irminsul/LLM] Tier 2 succeeded: '${object.title}' — ` +
    `${object.nodes.length} nodes, ${object.milestones.length} milestones`,
  );

  return object;
}