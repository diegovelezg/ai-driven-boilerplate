-- Cantidad de slots que reserva cada línea (espacios en la pantalla para el periodo).
-- Default 1: al agregar una pantalla se reserva 1 slot; el total de slots por
-- pantalla (capacidad, `sys_stores.default_slots_per_screen`) no cambia.
-- Aditiva: sin DROP, el default cubre filas existentes.
alter table public.io_lines
  add column if not exists cant_slots int not null default 1
  check (cant_slots >= 1 and cant_slots <= 100);

-- Reemplazo atómico: acepta `slots` por línea (default 1) y lo persiste.
create or replace function public.io_replace_lines(
  p_store uuid,
  p_io uuid,
  p_lines jsonb,
  p_actor text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $func$
declare
  v_status text;
  v_starts date;
  v_ends date;
  l jsonb;
  v_screen uuid;
  v_start date;
  v_end date;
  v_total numeric;
  v_notes text;
  v_slots int;
begin
  select status into v_status from io_orders where store_id = p_store and id = p_io;
  if not found then
    raise exception 'orden no encontrada';
  end if;
  if v_status <> 'draft' then
    raise exception 'solo borradores (estado %)', v_status;
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'sin líneas';
  end if;

  delete from io_lines where store_id = p_store and io_id = p_io;

  v_starts := null;
  v_ends := null;
  for l in select * from jsonb_array_elements(p_lines) loop
    begin
      v_screen := (l ->> 'screen_id')::uuid;
      v_start := (l ->> 'starts')::date;
      v_end := (l ->> 'ends')::date;
      v_total := (l ->> 'total')::numeric;
      v_slots := coalesce(nullif(btrim(l ->> 'slots'), ''), '1')::int;
    exception when others then
      raise exception 'línea inválida';
    end;
    if v_end < v_start then
      raise exception 'fin anterior al inicio en línea';
    end if;
    if v_total is null or v_total <= 0 then
      raise exception 'total inválido en línea';
    end if;
    if v_slots is null or v_slots < 1 or v_slots > 100 then
      raise exception 'slots inválidos en línea (1–100)';
    end if;
    if not exists (select 1 from inv_screens where store_id = p_store and id = v_screen) then
      raise exception 'pantalla fuera del inventario';
    end if;
    v_notes := nullif(btrim(l ->> 'notes'), '');
    insert into io_lines (
      store_id, io_id, screen_id, slot_id, starts_at, ends_at,
      rate_minor, tarifa_regular_minor, cant_meses, cant_dias, cant_slots, notes
    ) values (
      p_store, p_io, v_screen, null,
      (v_start::timestamp at time zone 'America/Lima'),
      ((v_end + 1)::timestamp at time zone 'America/Lima'),
      round(v_total * 100)::int,
      null, null,
      (v_end - v_start + 1),
      v_slots,
      v_notes
    );
    if v_starts is null or v_start < v_starts then v_starts := v_start; end if;
    if v_ends is null or v_end > v_ends then v_ends := v_end; end if;
  end loop;

  update io_orders
  set starts_at = v_starts,
      ends_at = v_ends,
      updated_at = now(),
      updated_by = p_actor
  where store_id = p_store and id = p_io;
end;
$func$;

revoke all on function public.io_replace_lines(uuid, uuid, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.io_replace_lines(uuid, uuid, jsonb, text)
  to service_role;
