-- Ejecutar contra una BD de desarrollo con la migración aplicada.
-- Todo cambio se revierte; requiere al menos una factura vinculada a una orden.
begin;
do $$
declare
  v_template public.io_invoices%rowtype;
  v_invoice uuid := gen_random_uuid();
  v_second uuid := gen_random_uuid();
  v_first_payment uuid := gen_random_uuid();
  v_second_payment uuid := gen_random_uuid();
  v_paid bigint;
  v_status text;
  v_rejected boolean;
begin
  select * into v_template from io_invoices where io_id is not null limit 1;
  if not found then raise exception 'Prueba requiere una factura/orden de desarrollo'; end if;
  insert into io_invoices(id,store_id,io_id,number,amount_minor,currency,issue_date,due_date,status)
    values(v_invoice,v_template.store_id,v_template.io_id,'TEST-'||v_invoice,1000000,v_template.currency,current_date-10,current_date+10,'issued');
  perform io_record_invoice_payment(v_template.store_id,v_invoice,v_first_payment,300000,current_date-1,'TEST-ABONO-1','test@example.com');
  -- Reenvío idéntico no duplica el abono.
  perform io_record_invoice_payment(v_template.store_id,v_invoice,v_first_payment,300000,current_date-1,'TEST-ABONO-1','test@example.com');
  select sum(amount_minor) into v_paid from io_invoice_payments where invoice_id=v_invoice and voided_at is null;
  if v_paid <> 300000 then raise exception 'Fallo: abono/idempotencia %',v_paid; end if;
  select status into v_status from io_invoices where id=v_invoice;
  if v_status <> 'issued' then raise exception 'Fallo: pago parcial no debe saldar factura'; end if;

  v_rejected := false;
  begin
    perform io_record_invoice_payment(v_template.store_id,v_invoice,v_first_payment,400000,current_date-1,'OTRO','test');
  exception when raise_exception then
    if sqlerrm not like '%otros datos%' then raise; end if;
    v_rejected := true;
  end;
  if not v_rejected then raise exception 'Fallo: reenvío con otros datos aceptado'; end if;

  v_rejected := false;
  begin
    perform io_record_invoice_payment(v_template.store_id,v_invoice,gen_random_uuid(),800000,current_date-1,'EXCESO','test');
  exception when raise_exception then
    if sqlerrm not like '%supera el saldo%' then raise; end if;
    v_rejected := true;
  end;
  if not v_rejected then raise exception 'Fallo: sobrepago aceptado'; end if;

  v_rejected := false;
  begin
    perform io_record_invoice_payment(v_template.store_id,v_invoice,gen_random_uuid(),100,current_date+1,'FUTURO','test');
  exception when raise_exception then
    if sqlerrm not like '%inválidos%' then raise; end if;
    v_rejected := true;
  end;
  if not v_rejected then raise exception 'Fallo: cobro futuro aceptado'; end if;

  v_rejected := false;
  begin
    perform io_record_invoice_payment(gen_random_uuid(),v_invoice,gen_random_uuid(),100,current_date-1,'TENANT','test');
  exception when raise_exception then
    if sqlerrm <> 'Factura no encontrada' then raise; end if;
    v_rejected := true;
  end;
  if not v_rejected then raise exception 'Fallo: cobro entre tenants aceptado'; end if;

  v_rejected := false;
  begin
    insert into io_invoice_payments(store_id,invoice_id,amount_minor,paid_on,reference)
      values(gen_random_uuid(),v_invoice,100,current_date-1,'TENANT');
  exception when foreign_key_violation then v_rejected := true;
  end;
  if not v_rejected then raise exception 'Fallo: FK permitió mezclar tenants'; end if;

  v_rejected := false;
  begin perform io_cancel_invoice(v_template.store_id,v_invoice,'test');
  exception when raise_exception then
    if sqlerrm not like '%tiene cobros%' then raise; end if;
    v_rejected := true;
  end;
  if not v_rejected then raise exception 'Fallo: anulación ocultó cobros'; end if;

  -- Cancelar la campaña no impide recaudar una deuda ya facturada.
  update io_orders set status='cancelled' where id=v_template.io_id;
  perform io_record_invoice_payment(v_template.store_id,v_invoice,v_second_payment,700000,current_date-1,'TEST-SALDO','test');
  select status into v_status from io_invoices where id=v_invoice;
  if v_status <> 'paid' then raise exception 'Fallo: saldo completo no cierra factura'; end if;
  perform io_void_invoice_payment(v_template.store_id,v_invoice,v_first_payment,'Error de registro','test');
  select status into v_status from io_invoices where id=v_invoice;
  if v_status <> 'issued' then raise exception 'Fallo: reversión no reabre saldo'; end if;
  if not exists(select 1 from io_invoice_payments where id=v_first_payment and void_reason='Error de registro' and voided_at is not null and voided_by='test') then
    raise exception 'Fallo: reversión no conserva auditoría';
  end if;
  perform io_void_invoice_payment(v_template.store_id,v_invoice,v_second_payment,'Corrección de registro','test');
  perform io_cancel_invoice(v_template.store_id,v_invoice,'test');

  -- Un cobro anterior a la emisión puede documentar un anticipo real.
  insert into io_invoices(id,store_id,io_id,number,amount_minor,currency,issue_date,status)
    values(v_second,v_template.store_id,v_template.io_id,'TEST-'||v_second,100,v_template.currency,current_date,'issued');
  perform io_record_invoice_payment(v_template.store_id,v_second,gen_random_uuid(),100,current_date-1,'ANTICIPO','test');

  if exists(select 1 from io_invoice_payments where source='legacy_balance' and (paid_on is not null or created_by is not null)) then
    raise exception 'Fallo: saldo histórico inventa fecha o actor';
  end if;
  if has_function_privilege('authenticated','public.io_record_invoice_payment(uuid,uuid,uuid,bigint,date,text,text)','execute')
    or has_function_privilege('anon','public.io_void_invoice_payment(uuid,uuid,uuid,text,text)','execute') then
    raise exception 'Fallo: RPC accesible sin server action';
  end if;
  raise notice 'OK: abonos, idempotencia, sobrepago, fechas, tenants, cancelación, reversión e histórico';
end;
$$;
rollback;
