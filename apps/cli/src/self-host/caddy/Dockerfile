# kortix/caddy: the stock Caddy 2.10.2 image plus one module, caddy-dns/acmedns.
#
# A self-host that turns on wildcard certificates (`kortix self-host tls
# wildcard`) runs this image instead of caddy:2.10.2-alpine. The module lets
# Caddy answer ACME DNS-01 challenges through the bundled acme-dns server, so
# *.apps.<domain> and *.p.<domain> get one wildcard certificate each instead of
# one public certificate per App or preview host. Every other self-host keeps
# the stock image. Published by .github/workflows/selfhost-caddy-image.yml.
ARG CADDY_VERSION=2.10.2

FROM caddy:${CADDY_VERSION}-builder AS build
RUN xcaddy build \
	--with github.com/caddy-dns/acmedns@v0.7.0

FROM caddy:${CADDY_VERSION}-alpine
COPY --from=build /usr/bin/caddy /usr/bin/caddy
