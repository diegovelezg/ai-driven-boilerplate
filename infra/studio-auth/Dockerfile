# studio-auth — nginx con Basic Auth delante de Studio.
# Studio self-hosted no tiene login propio; así queda protegido sin
# depender de dominios ni configuraciones de Coolify.
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY .htpasswd /etc/nginx/.htpasswd
