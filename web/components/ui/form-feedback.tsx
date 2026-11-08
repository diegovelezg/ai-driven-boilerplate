"use client";

import { useCallback, useState } from "react";
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
