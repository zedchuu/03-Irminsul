// =============================================================================
// src/lib/errors.ts
// Irminsul — Shared error types
//
// Kept separate from progressActions.ts because 'use server' files may only
// export async functions — classes and other exports are forbidden by Next.js.
// Both Server Actions (progressActions.ts) and Client Components
// (TechTreeCanvas.tsx) import ActionError from here.
// =============================================================================

/**
 * Typed error thrown by Server Actions on failure.
 * The `code` field allows Client Components to discriminate error types
 * without string-matching on the message.
 */
export class ActionError extends Error {
  constructor(
    message: string,
    public readonly code: 'UNAUTHORIZED' | 'DB_ERROR' | 'INVALID_INPUT',
  ) {
    super(message);
    this.name = 'ActionError';
  }
}