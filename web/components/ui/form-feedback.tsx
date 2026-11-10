"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { toast } from "@/components/ui/toast";

/**
 * Comportamiento DEFAULT de cualquier form del proyecto:
 * - Sin validaciones de navegador (los <form> llevan `noValidate`, sin
 *   `required`/`pattern`/`minLength`: nada de burbujas nativas).
 * - Error = borde del campo (`FIELD_ERR_CLS`, token destructivo del proyecto)
 *   + toast `type: "error"`, con foco al primer campo.
 * - Botón submit deshabilitado hasta completar los obligatorios.
 */

export const FIELD_ERR_CLS = "border-destructive ring-2 ring-destructive/30";

export function toastFormError(title: string, description: string) {
  toast.add({ title, description, type: "error" });
}

/** Submit con errores de validación cliente: preventDefault + marca + toast.
 *  El caller valida antes con su `validate*Fields` y pasa su `fail` local
 *  (que además lleva el foco al primer campo). Textos SSOT. */
export function failSubmit<T extends string>(
  e: FormEvent<HTMLFormElement>,
  errs: Array<{ key: T; message: string }>,
  fail: (keys: T[], title: string, description: string) => void,
): void {
  if (errs.length === 0) return;
  e.preventDefault();
  fail(
    errs.map((r) => r.key),
    errs.length === 1 ? "Revisa el campo marcado" : "Revisa los campos marcados",
    errs.map((r) => r.message).join(" "),
  );
}

/** Errores del server action: borde + toast (nunca texto inline). */
export function useServerFieldErrors<S extends { ok: boolean; message: string }, K extends string>(
  state: S,
  fieldsFromMessage: (msg: string) => K[],
  setInvalid: (keys: Set<K>) => void,
  title: string,
): void {
  useEffect(() => {
    if (!state.message || state.ok) return;
    setInvalid(new Set(fieldsFromMessage(state.message)));
    toast.add({ title, description: state.message, type: "error" });
  }, [state, fieldsFromMessage, setInvalid, title]);
}

/** Set de campos inválidos con helpers (marca / limpia / clase / foco). */
export function useInvalidFields<T extends string>() {
  const [invalid, setInvalid] = useState<Set<T>>(new Set());

  const mark = useCallback((keys: T[]) => setInvalid(new Set(keys)), []);

  const clear = useCallback(
    (k: T) =>
      setInvalid((prev) => {
        if (!prev.has(k)) return prev;
        const next = new Set(prev);
        next.delete(k);
        return next;
      }),
    [],
  );

  const bad = useCallback((k: T) => (invalid.has(k) ? ` ${FIELD_ERR_CLS}` : ""), [invalid]);

  const focusFirst = useCallback((root: { current: HTMLElement | null }, names: string[]) => {
    for (const n of names) {
      // `data-field` primero (triggers visibles de Select), luego `name`.
      // Se salta `input[type=hidden]`: `focus()` ahí es no-op y el campo
      // visible nunca recibiría el foco (nueva-form/nuevo-form `company_id`).
      const els = root.current?.querySelectorAll<HTMLElement>(`[data-field="${n}"],[name="${n}"]`);
      for (const el of els ?? []) {
        if (el instanceof HTMLInputElement && el.type === "hidden") continue;
        if (el instanceof HTMLElement && el.offsetParent === null && el.tagName !== "BODY") continue;
        el.focus();
        return;
      }
    }
  }, []);

  return { invalid, mark, clear, bad, focusFirst, setInvalid };
}
