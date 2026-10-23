-- Anti-duplicados en Review: un cliente = un borrador vivo (issue: dos
-- pending_review del mismo cliente/señal por rescate concurrente con el
-- copywriter). El código re-chequea antes del insert, pero el constraint es
-- la garantía real bajo carreras.
--
-- Limpieza previa (idempotente): conserva UN vivo por cliente (approved
-- antes que pending, luego el más reciente). Sin esto el índice fallaría
-- donde ya haya duplicados.

delete from proposed_actions
where id in (
  select id from (
    select
      id,
      row_number() over (
        partition by store_id, customer_id
        order by
          case status when 'approved' then 0 else 1 end,
          created_at desc,
          id desc
      ) as rn
    from proposed_actions
    where status in ('pending_review', 'approved')
  ) t
  where rn > 1
);

create unique index if not exists proposed_actions_one_live_per_customer
  on proposed_actions (store_id, customer_id)
  where status in ('pending_review', 'approved');

create unique index if not exists proposed_actions_one_live_per_signal
  on proposed_actions (store_id, signal_id)
  where status in ('pending_review', 'approved');
