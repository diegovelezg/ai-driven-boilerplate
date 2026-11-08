<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Forms default (obligatorio en todo form del proyecto)

- Sin validación de navegador: `<form noValidate>`, nunca `required`/`pattern`/`minLength`.
- Error = borde del campo (`FIELD_ERR_CLS` de `components/ui/form-feedback.tsx`)
  + `toast.add({ title, description, type: "error" })` + foco al primer campo.
  Helpers: `useInvalidFields<T>()`, `toastFormError(title, description)`.
- Botón submit deshabilitado hasta completar los obligatorios (+ `title` explicando qué falta).
- Validadores por dominio viven junto al form (p. ej. `companies/company-validation.ts`)
  como espejo liviano del `normalize*` de `lib/`.
