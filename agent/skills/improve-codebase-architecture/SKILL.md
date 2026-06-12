---
name: improve-codebase-architecture
description: Improve a codebase's architecture through targeted, incremental refactors grounded in the existing system. Use when asked to simplify structure, reduce coupling, clarify boundaries, untangle modules, or make the codebase easier to extend without a speculative rewrite.
---

# Improve Codebase Architecture

Improve architecture by making the codebase easier to understand, change, and test. Prioritize concrete structural improvements over abstract advice.

## When to Use

Use this skill when the user wants to:
- Improve maintainability or extensibility
- Reduce coupling between modules or layers
- Clarify ownership and boundaries in a messy area
- Break apart large files, services, or components
- Refactor toward a cleaner architecture without a rewrite

Do not treat architecture as a greenfield exercise. Start from the current system and move it to a better shape in small, defensible steps.

## Working Rules

- Optimize for changeability, not elegance in isolation.
- Prefer small boundary fixes over sweeping rewrites.
- Preserve observable behavior unless the user asked for behavior changes.
- Match the existing stack and conventions unless they are the problem.
- Explain tradeoffs in terms of coupling, cohesion, testability, and failure modes.

## Process

### 1. Map the current shape

Identify:
- The entry points, major modules, and data flow
- Where responsibilities are mixed
- Which dependencies point the wrong direction
- Which files or abstractions are hard to change safely

Use the real codebase. Do not infer architecture from filenames alone.

### 2. Find the highest-leverage problem

Choose one or two concrete architectural issues, such as:
- Domain logic embedded in UI or transport layers
- A god object / god module coordinating too much
- Circular or implicit dependencies
- Shared utilities that hide domain behavior
- Data models that leak across unrelated layers
- Repetition caused by missing boundaries

Avoid broad cleanup missions with unclear payoff.

### 3. Define the target boundary

State the intended shape in simple terms:
- What responsibility moves where
- Which module should depend on which
- What API or seam becomes the stable boundary
- What becomes easier after the change

If useful, describe the target with a short dependency rule such as:
`UI -> application -> domain -> infrastructure`

### 4. Implement incrementally

Prefer refactors that can land safely in slices:
- Extract pure domain logic from framework code
- Introduce a small interface around an unstable dependency
- Split read/write concerns when one module does both poorly
- Move validation, mapping, or orchestration to the layer that owns it
- Replace implicit conventions with explicit types or functions

When a larger migration is needed, create the new path first and then drain callers over to it.

### 5. Validate the architecture, not just the code

Check that:
- Dependencies now flow in the intended direction
- Responsibilities are clearer than before
- Tests can target the right layer with less setup
- The refactor removed special cases instead of relocating them
- The new structure is something the team can realistically keep using

## Output Expectations

When making architectural changes:
- Briefly identify the problem being fixed
- Name the boundary or dependency rule being enforced
- Implement the smallest useful structural change
- Verify behavior with tests or other concrete checks when available

When answering without editing code:
- Ground recommendations in specific files and flows
- Prefer a staged plan over a rewrite proposal
- Highlight risks, migration order, and validation strategy

## Avoid

- Recommending patterns by name without proving the need
- Inventing layers that add indirection but no leverage
- Moving code across files without changing responsibility boundaries
- Proposing a rewrite because the current code is messy
- Treating architecture as separate from delivery constraints
