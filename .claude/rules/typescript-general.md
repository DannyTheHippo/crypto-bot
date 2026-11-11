---
paths:
  - "**/*.ts"
  - "**/*.tsx"
---

# TypeScript Conventions

- TypeScript strict mode. **FORBIDDEN** to use `any` — use `unknown` or generics with documented justification.
- **FORBIDDEN** to use `// eslint-disable` without a specific rule name and inline justification.
- Conventional Commits convention: `feat(scope):`, `fix(scope):`, `docs:`, `refactor:`, `chore:`.
- Never commit secrets. Use environment variables + `.env`.
- **MUST** read tsconfig.json to understand strictness settings before coding.
- **MUST** match the project's quote style, semicolons, and trailing commas — check .prettierrc or .editorconfig.
- **MUST** follow existing import ordering patterns (framework imports, third-party, local).
- **MUST** use existing utility types and functions before creating new ones.
- **MUST** check for path aliases in tsconfig (e.g., `@shared/*`, `@app/*`) before using deep relative imports.
- **MUST** respect the project's enum style (string enums, const enums, or union types).
