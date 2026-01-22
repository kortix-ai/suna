# Simplicity First

## Core Philosophy

**Less is more. Always.**

- Write the minimum code necessary to solve the problem
- If you can remove it, remove it
- If you can simplify it, simplify it
- Every line of code is a liability

## Before Writing Code

Ask:
1. Do we actually need this?
2. Can we solve this with existing code?
3. What's the simplest possible solution?

## When Writing Code

- Prefer deletion over addition
- Prefer refactoring over extending
- Prefer built-in solutions over custom implementations
- Prefer 10 lines over 100 lines

## Code Review Checklist

- [ ] Can any code be removed?
- [ ] Can any logic be simplified?
- [ ] Are there unnecessary abstractions?
- [ ] Is there duplicated logic to consolidate?
- [ ] Are there over-engineered solutions?

## Red Flags

- "Just in case" code
- Premature abstractions
- Unnecessary wrapper functions
- Over-generalized solutions
- Code that anticipates requirements that don't exist

## Refactoring Mindset

When touching existing code:
1. First, understand what it does
2. Then, simplify and remove
3. Finally, make necessary changes

**The best code is no code. The second best is less code.**
