"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { CompanyPicker, type CompanyPickerOption } from "@/components/company-picker";
import { CancelButton, SubmitButton } from "@/components/buttons";
import { toast } from "@/components/ui/toast";
import { toastFormError, useInvalidFields } from "@/components/ui/form-feedback";
import { createCompanyLinkAction } from "@/lib/crm-actions";
import { toTitleCase } from "@/lib/format";

/**
 * Alta de vínculo agencia ↔ anunciante (drawer Vínculos).
 * Un solo FK a empresa existente (regla drawer: inline solo picks de un
 * campo; lo multi-campo vive en /new). Modo servidor del CompanyPicker:
 * fuzzy en Postgres, excluye la propia + ya vinculadas.
 */
export function VinculoForm({
  companyId,
  kind,
  linkedIds,
  onSaved,
  onCancel,
}: {
  companyId: string;
  kind: "agencia" | "anunciante";
  linkedIds: string[];
  onSaved?: () => void;
  onCancel?: () => void;
}) {
  const opposite = kind === "anunciante" ? "agencia" : "anunciante";
  const [picked, setPicked] = useState("");
  const [options, setOptions] = useState<CompanyPickerOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [pending, startTransition] = useTransition();
  const { invalid, mark, clear, focusFirst } = useInvalidFields<"empresa">();
  const formRef = useRef<HTMLDivElement>(null);
  const reqRef = useRef(0);
  const excludeKey = [companyId, ...linkedIds].join(",");

  const fetchOptions = useCallback(
    async (qq: string, signal?: AbortSignal) => {
      const req = ++reqRef.current;
      setLoading(true);
      try {
        const params = new URLSearchParams({ kind: opposite, limit: "20", exclude: excludeKey });
        if (qq.trim()) params.set("q", qq.trim());
        const res = await fetch(`/api/companies/search?${params}`, { cache: "no-store", signal });
        if (!res.ok) throw new Error("No se pudieron buscar empresas.");
        const json = (await res.json()) as { companies?: CompanyPickerOption[] };
        if (reqRef.current === req) setOptions(json.companies ?? []);
      } catch (e) {
        if (signal?.aborted || reqRef.current !== req) return;
        toastFormError("No se pudieron buscar empresas", e instanceof Error ? e.message : "Error.");
      } finally {
        if (reqRef.current === req) setLoading(false);
      }
    },
    [opposite, excludeKey],
  );

  useEffect(() => {
    const ac = new AbortController();
    void fetchOptions("", ac.signal);
    return () => ac.abort();
  }, [fetchOptions]);

  const pickedLabel = picked ? options.find((o) => o.id === picked)?.name : undefined;

  function save() {
    if (!picked) {
      mark(["empresa"]);
      toastFormError("Revisa el campo marcado", `Elige ${opposite === "agencia" ? "la agencia" : "el anunciante"} a vincular.`);
      focusFirst(formRef, ["vinculo-empresa"]);
      return;
    }
    startTransition(async () => {
      const res = await createCompanyLinkAction(
        kind === "anunciante"
          ? { agencyCompanyId: picked, advertiserCompanyId: companyId }
          : { agencyCompanyId: companyId, advertiserCompanyId: picked },
      );
      if (!res.ok) {
        mark(["empresa"]);
        toastFormError("No se pudo crear el vínculo", res.message);
        focusFirst(formRef, ["vinculo-empresa"]);
        return;
      }
      toast.add({ title: "Vínculo creado", description: res.message, type: "success" });
      onSaved?.();
    });
  }

  return (
    <div ref={formRef} className="flex flex-col gap-3 rounded-lg bg-muted/40 px-3 py-3">
      <div className="form-field">
        {opposite === "agencia" ? "Agencia a vincular" : "Anunciante a vincular"}
        <CompanyPicker
          value={picked}
          onChange={(id) => {
            setPicked(id);
            if (id) clear("empresa");
          }}
          options={options}
          loading={loading}
          onQueryChange={(qq) => void fetchOptions(qq)}
          selectedLabel={pickedLabel ? toTitleCase(pickedLabel) : undefined}
          placeholder={opposite === "agencia" ? "Buscar agencia…" : "Buscar anunciante…"}
          ariaLabel={opposite === "agencia" ? "Agencia a vincular" : "Anunciante a vincular"}
          dataField="vinculo-empresa"
          invalid={invalid.has("empresa")}
          allowClear={false}
          disabled={pending}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <SubmitButton
          onClick={save}
          pending={pending}
          disabled={!picked}
          title={!picked ? "Elige una empresa para continuar" : undefined}
        >
          Vincular
        </SubmitButton>
        <CancelButton onCancel={onCancel} disabled={pending} />
      </div>
    </div>
  );
}
