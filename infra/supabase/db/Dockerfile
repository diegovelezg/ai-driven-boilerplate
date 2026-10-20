# db — Supabase Postgres + scripts de init propios (roles/jwt).
# Se hornean en la imagen: Coolify trata los bind mounts de archivos como
# directorios y los scripts nunca se ejecutaban (roles sin password).
FROM public.ecr.aws/supabase/postgres:17.11.0.004
COPY roles.sql /docker-entrypoint-initdb.d/init-scripts/99-roles.sql
COPY jwt.sql /docker-entrypoint-initdb.d/init-scripts/99-jwt.sql
