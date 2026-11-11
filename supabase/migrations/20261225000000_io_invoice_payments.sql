-- Cobros parciales por factura. Solo ADD: no se elimina ni redondea información.
-- Las facturas históricas paid se preservan como SALDO HISTÓRICO DECLARADO,
-- sin inventar fecha, referencia bancaria ni identidad de quien cobró.
create unique index io_invoices_store_id_id_payments_uidx on public.io_invoices(store_id, id);

create table public.io_invoice_payments (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null,
  invoice_id uuid not null references public.io_invoices(id) on delete restrict,
  amount_minor bigint not null check (amount_minor > 0),
  paid_on date,
  reference text,
  source text not null default 'payment' check (source in ('payment', 'legacy_balance')),
  created_at timestamptz not null default now(),
  created_by text,
  voided_at timestamptz,
  voided_by text,
  void_reason text,
  constraint io_invoice_payments_same_store_fk foreign key (store_id, invoice_id)
    references public.io_invoices(store_id, id),
  check ((source = 'payment' and paid_on is not null and reference is not null and length(btrim(reference)) > 0)
    or (source = 'legacy_balance' and paid_on is null)),
  check ((voided_at is null and void_reason is null and voided_by is null)
    or (voided_at is not null and void_reason is not null and length(btrim(void_reason)) > 0))
);
create index io_invoice_payments_invoice_idx on public.io_invoice_payments(store_id, invoice_id);
create unique index io_invoice_payments_legacy_idx on public.io_invoice_payments(invoice_id)
  where source = 'legacy_balance';

insert into public.io_invoice_payments(store_id, invoice_id, amount_minor, source, reference)
select store_id, id, amount_minor, 'legacy_balance', 'Saldo histórico: factura marcada pagada; fecha de cobro desconocida'
from public.io_invoices where status = 'paid' and amount_minor > 0;

alter table public.io_invoice_payments enable row level security;
create policy io_invoice_payments_read on public.io_invoice_payments for select to authenticated
  using (public.is_store_member(store_id));
revoke all on public.io_invoice_payments from anon, authenticated;
grant select on public.io_invoice_payments to authenticated;
grant all on public.io_invoice_payments to service_role;

-- Funciones solo service_role: la server action valida sesión/tenant/rol.
-- Se bloquea la factura para serializar abonos, anulaciones y reversiones.
create or replace function public.io_record_invoice_payment(
  p_store uuid, p_invoice uuid, p_payment uuid, p_amount bigint,
  p_paid_on date, p_reference text, p_actor text default null
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_invoice public.io_invoices%rowtype;
  v_existing public.io_invoice_payments%rowtype;
  v_paid bigint;
begin
  select * into v_invoice from io_invoices where store_id = p_store and id = p_invoice for update;
  if not found then raise exception 'Factura no encontrada'; end if;
  -- Reintento de la misma solicitud: no duplicar, tampoco aceptar otro payload.
  select * into v_existing from io_invoice_payments where id = p_payment;
  if found then
    if v_existing.store_id = p_store and v_existing.invoice_id = p_invoice
      and v_existing.amount_minor = p_amount and v_existing.paid_on = p_paid_on
      and v_existing.reference = btrim(p_reference) and v_existing.source = 'payment' then return; end if;
    raise exception 'La solicitud de cobro ya existe con otros datos';
  end if;
  if v_invoice.status not in ('issued', 'overdue') then raise exception 'La factura no admite nuevos cobros'; end if;
  if p_payment is null or p_amount is null or p_amount <= 0 or p_paid_on is null
    or p_paid_on > (now() at time zone 'America/Lima')::date
    or p_reference is null or length(btrim(p_reference)) not between 1 and 200 then
    raise exception 'Monto, fecha o referencia de cobro inválidos';
  end if;
  select coalesce(sum(amount_minor), 0) into v_paid from io_invoice_payments
    where store_id = p_store and invoice_id = p_invoice and voided_at is null;
  if v_paid + p_amount > v_invoice.amount_minor then raise exception 'El monto supera el saldo de la factura'; end if;
  insert into io_invoice_payments(id, store_id, invoice_id, amount_minor, paid_on, reference, created_by)
    values (p_payment, p_store, p_invoice, p_amount, p_paid_on, btrim(p_reference), p_actor);
  update io_invoices set status = case when v_paid + p_amount = amount_minor then 'paid' else 'issued' end
    where store_id = p_store and id = p_invoice;
  update io_orders set updated_at = now(), updated_by = p_actor
    where store_id = p_store and id = v_invoice.io_id;
end;
$$;

create or replace function public.io_void_invoice_payment(
  p_store uuid, p_invoice uuid, p_payment uuid, p_reason text, p_actor text default null
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_invoice public.io_invoices%rowtype;
  v_paid bigint;
begin
  select * into v_invoice from io_invoices where store_id = p_store and id = p_invoice for update;
  if not found then raise exception 'Factura no encontrada'; end if;
  if v_invoice.status not in ('issued', 'paid', 'overdue') then raise exception 'La factura no admite correcciones de cobro'; end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 500 then raise exception 'Indica el motivo de la reversión (máx 500)'; end if;
  if not exists (select 1 from io_invoice_payments where store_id = p_store and invoice_id = p_invoice and id = p_payment) then
    raise exception 'Cobro no encontrado';
  end if;
  update io_invoice_payments set voided_at = now(), voided_by = p_actor, void_reason = btrim(p_reason)
    where store_id = p_store and invoice_id = p_invoice and id = p_payment and voided_at is null;
  select coalesce(sum(amount_minor), 0) into v_paid from io_invoice_payments
    where store_id = p_store and invoice_id = p_invoice and voided_at is null;
  update io_invoices set status = case when v_paid >= amount_minor and amount_minor > 0 then 'paid' else 'issued' end
    where store_id = p_store and id = p_invoice;
  update io_orders set updated_at = now(), updated_by = p_actor where store_id = p_store and id = v_invoice.io_id;
end;
$$;

create or replace function public.io_cancel_invoice(p_store uuid, p_invoice uuid, p_actor text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_invoice public.io_invoices%rowtype;
begin
  select * into v_invoice from io_invoices where store_id = p_store and id = p_invoice for update;
  if not found then raise exception 'Factura no encontrada'; end if;
  if v_invoice.status not in ('issued', 'overdue') then raise exception 'Solo se puede anular una factura emitida sin cobros'; end if;
  if exists (select 1 from io_invoice_payments where store_id = p_store and invoice_id = p_invoice and voided_at is null) then
    raise exception 'La factura tiene cobros: revisa y revierte los registros erróneos antes de anular';
  end if;
  update io_invoices set status = 'cancelled' where store_id = p_store and id = p_invoice;
  update io_orders set updated_at = now(), updated_by = p_actor where store_id = p_store and id = v_invoice.io_id;
end;
$$;
revoke all on function public.io_record_invoice_payment(uuid,uuid,uuid,bigint,date,text,text) from public,anon,authenticated;
revoke all on function public.io_void_invoice_payment(uuid,uuid,uuid,text,text) from public,anon,authenticated;
revoke all on function public.io_cancel_invoice(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.io_record_invoice_payment(uuid,uuid,uuid,bigint,date,text,text) to service_role;
grant execute on function public.io_void_invoice_payment(uuid,uuid,uuid,text,text) to service_role;
grant execute on function public.io_cancel_invoice(uuid,uuid,text) to service_role;
notify pgrst, 'reload schema';
