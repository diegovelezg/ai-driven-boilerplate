-- Retiro del feature sync ecommerce (pivote DOOH: ingesta Sheet/CSV).
-- La tabla solo guardaba decisiones de login→sync; ya sin escritores ni lectores.
drop table if exists login_sync_decisions;
