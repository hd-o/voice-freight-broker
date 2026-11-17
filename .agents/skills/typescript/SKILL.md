---
name: typescript-conventions
description: "Use when writing to TypeScript `.ts(x)` files"
paths: ["**/*.ts", "**/*.tsx"]
---

# TypeScript Conventions

## General

- Prefer straightforward, readable code over unnecessary abstraction
- Avoid excessive nesting, defensive checks, wrappers, and fallbacks
- Prefer immutable state, `const`, and `readonly` where appropriate
- Avoid `any`, unnecessary assertions, and compiler suppressions
- Never weaken production types to satisfy tests

## Naming

- Name domain purpose and outcomes, not implementation mechanics
- Prefer precise domain terminology over generic names
- Qualify ambiguous names with their resource or context
- Use one term per concept consistently in its context

## Single Source of Truth

- Fix shared behavior at the nearest common seam
- Parameterize repeated logic instead of duplicating it
- Derive related types and values from a single definition when practical
- Avoid redundant state and independently maintained representations

## Readability

- Prefer early returns when they reduce nesting
- Keep functions at a coherent level of abstraction
- Use intermediate variables when they clarify results

## Multiline Readability

Separate an intermediate multiline statement from adjacent statements with a blank line. A statement is intermediate
when another statement comes before or after it in the same block.

Do not add blank lines between a statement and the opening or closing boundary of its enclosing block. A block
containing only one statement needs no padding.

Avoid:

```typescript
function doSomething(): string | null {
  span.setAttribute(ATTRIBUTE, getDefaultValue());
  const running = update.context;
  // Some comment explaining why
  if (!running) {
    return null;
  }
  if (!checkValidity(running)) {
    logger.error("Not valid");
    persistValidity(running);
    return null;
  }
  return running;
}
```

Prefer:

```typescript
function doSomething(): string | null {
  span.setAttribute(ATTRIBUTE, getDefaultValue());

  const running = update.context;

  // Some comment explaining why
  if (!running) {
    return null;
  }

  if (!checkValidity(running)) {
    logger.error("Not valid");
    persistValidity(running);
    return null;
  }

  return running;
}
```
