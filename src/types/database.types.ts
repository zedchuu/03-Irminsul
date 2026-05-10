// =============================================================================
// Irminsul — Database TypeScript Interfaces
// Generated to match: irminsul_migration.sql
// Usage: import these into Server Actions, API routes, and Supabase query calls.
// =============================================================================

// ---------------------------------------------------------------------------
// ENUMS
// ---------------------------------------------------------------------------

export type NodeStatus = 'not_started' | 'in_progress' | 'completed' | 'stalled';

export type NodeSource = 'llm_generated' | 'db_retrieved' | 'llm_refreshed';

// ---------------------------------------------------------------------------
// JSONB Shape Contracts
// These are NOT enforced by Postgres — they MUST be validated at the app layer
// (e.g., with Zod) before any INSERT to prevent Pedagogical Vacuums.
// ---------------------------------------------------------------------------

/** A single concrete, measurable task within a node. */
export interface ActionableTask {
  /** The specific action the learner must perform. */
  task: string;
  /** How the learner knows they succeeded. Prevents vague "Practice X" tasks. */
  success_criteria: string;
  /** Estimated time for this task in minutes. */
  estimated_minutes: number;
}

/**
 * Micro-tasks generated during a stall recalculation.
 * Stored in user_progress.recalculated_tasks — does NOT mutate the source node.
 */
export interface RecalculatedTask extends ActionableTask {
  /** Difficulty relative to the original task (0.0–1.0). Used for adaptive pacing. */
  relative_difficulty: number;
}

// ---------------------------------------------------------------------------
// TABLE: goals
// ---------------------------------------------------------------------------

export interface Goal {
  id: string;                       // UUID
  title: string;                    // e.g. "Learn Python"
  slug: string;                     // e.g. "learn-python" — used for Tier 1 exact match
  description: string | null;
  /** pgvector embedding — present in DB, typically excluded from client fetches. */
  embedding: number[] | null;
  last_verified_at: string | null;  // ISO 8601 timestamp
  access_count: number;
  created_at: string;
  updated_at: string;
}

/** Use this when fetching goals for UI rendering — strips the vector field. */
export type GoalSummary = Omit<Goal, 'embedding'>;

// ---------------------------------------------------------------------------
// TABLE: user_goals
// ---------------------------------------------------------------------------

export interface UserGoal {
  id: string;           // UUID
  user_id: string;      // UUID — references auth.users
  goal_id: string;      // UUID — references goals
  started_at: string;   // ISO 8601 timestamp
}

/** Joined shape used when fetching a user's enrolled goals with goal details. */
export interface UserGoalWithGoal extends UserGoal {
  goals: GoalSummary;
}

// ---------------------------------------------------------------------------
// TABLE: nodes
// ---------------------------------------------------------------------------

export interface Node {
  id: string;                         // UUID
  goal_id: string;                    // UUID — references goals
  title: string;                      // e.g. "Variables & Data Types"
  lesson_context: string;             // the HOW and WHY — never empty
  actionable_tasks: ActionableTask[]; // parsed from JSONB
  estimated_minutes: number;
  sequence_order: number;
  source: NodeSource;
  last_verified_at: string | null;    // ISO 8601 timestamp
  access_count: number;
  is_deprecated: boolean;
  created_at: string;
  updated_at: string;
}

/** Use for rendering the tech tree — strips internal metadata. */
export type NodeCard = Pick<
  Node,
  'id' | 'goal_id' | 'title' | 'lesson_context' | 'actionable_tasks' | 'estimated_minutes' | 'sequence_order'
>;

// ---------------------------------------------------------------------------
// TABLE: node_prerequisites
// ---------------------------------------------------------------------------

export interface NodePrerequisite {
  node_id: string;          // UUID — the node that has a dependency
  prerequisite_id: string;  // UUID — the node that must be completed first
}

/** Joined shape: a node with its prerequisite node IDs resolved. */
export interface NodeWithPrerequisites extends Node {
  prerequisites: string[]; // array of prerequisite node UUIDs
}

// ---------------------------------------------------------------------------
// TABLE: user_progress
// ---------------------------------------------------------------------------

export interface UserProgress {
  id: string;                               // UUID
  user_id: string;                          // UUID
  node_id: string;                          // UUID
  status: NodeStatus;
  last_interacted_at: string | null;        // ISO 8601 — NULL means never opened
  started_at: string | null;
  completed_at: string | null;
  recalculation_count: number;              // how many times this node was broken down
  recalculated_tasks: RecalculatedTask[] | null; // populated only when stalled
}

/** Joined shape for rendering a user's tech tree with live progress states. */
export interface NodeWithProgress extends NodeCard {
  user_progress: Pick<
    UserProgress,
    'status' | 'last_interacted_at' | 'recalculation_count' | 'recalculated_tasks'
  > | null;
}

// ---------------------------------------------------------------------------
// Supabase Database type map (for use with createClient<Database>())
// Extend this as tables are added.
// ---------------------------------------------------------------------------

export interface Database {
  public: {
    Tables: {
      goals: {
        Row: Goal;
        Insert: Omit<Goal, 'id' | 'created_at' | 'updated_at' | 'access_count'>;
        Update: Partial<Omit<Goal, 'id' | 'created_at'>>;
      };
      user_goals: {
        Row: UserGoal;
        Insert: Omit<UserGoal, 'id' | 'started_at'>;
        Update: never; // enrollments are not updated, only created or deleted
      };
      nodes: {
        Row: Node;
        Insert: Omit<Node, 'id' | 'created_at' | 'updated_at' | 'access_count' | 'is_deprecated'>;
        Update: Partial<Omit<Node, 'id' | 'created_at' | 'goal_id'>>;
      };
      node_prerequisites: {
        Row: NodePrerequisite;
        Insert: NodePrerequisite;
        Update: never; // prerequisites are replaced wholesale, never partially updated
      };
      user_progress: {
        Row: UserProgress;
        Insert: Omit<UserProgress, 'id'>;
        Update: Partial<Omit<UserProgress, 'id' | 'user_id' | 'node_id'>>;
      };
    };
    Enums: {
      node_status: NodeStatus;
      node_source: NodeSource;
    };
  };
}