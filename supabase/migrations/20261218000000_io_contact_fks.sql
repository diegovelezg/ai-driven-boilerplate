-- Contactos por rol en la orden (NP): POC del contratante, firmante, pago y
-- responsable como FK a crm_contacts. Los textos libres quedan como fallback
-- heredado (ya no se editan en GUI: todo sale de Empresas/Contactos).
-- Presencia de vínculo = dato; PDF imprime nombre + cargo + correo + teléfono.
alter table io_orders
  add column if not exists billing_contact_id uuid references crm_contacts (id) on delete set null,
  add column if not exists signer_contact_id uuid references crm_contacts (id) on delete set null,
  add column if not exists payment_contact_id uuid references crm_contacts (id) on delete set null,
  add column if not exists manager_contact_id uuid references crm_contacts (id) on delete set null;

create index if not exists io_orders_store_billing_contact_idx on io_orders (store_id, billing_contact_id);
create index if not exists io_orders_store_signer_contact_idx on io_orders (store_id, signer_contact_id);
create index if not exists io_orders_store_payment_contact_idx on io_orders (store_id, payment_contact_id);
create index if not exists io_orders_store_manager_contact_idx on io_orders (store_id, manager_contact_id);

-- Same-store compuestos (convención 20261213). Check-only; el borrado lo
-- gobierna SET NULL de la FK simple.
do $$ begin if not exists (select 1 from pg_constraint where conname = 'io_orders_billing_contact_same_store_fk') then alter table io_orders add constraint io_orders_billing_contact_same_store_fk foreign key (store_id, billing_contact_id) references crm_contacts (store_id, id) on update cascade on delete no action; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint where conname = 'io_orders_signer_contact_same_store_fk') then alter table io_orders add constraint io_orders_signer_contact_same_store_fk foreign key (store_id, signer_contact_id) references crm_contacts (store_id, id) on update cascade on delete no action; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint where conname = 'io_orders_payment_contact_same_store_fk') then alter table io_orders add constraint io_orders_payment_contact_same_store_fk foreign key (store_id, payment_contact_id) references crm_contacts (store_id, id) on update cascade on delete no action; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint where conname = 'io_orders_manager_contact_same_store_fk') then alter table io_orders add constraint io_orders_manager_contact_same_store_fk foreign key (store_id, manager_contact_id) references crm_contacts (store_id, id) on update cascade on delete no action; end if; end $$;
