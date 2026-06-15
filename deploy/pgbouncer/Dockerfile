FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    pgbouncer \
    postgresql-client \
    bash \
    && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /entrypoint.sh
# Strip Windows CRLF line endings and make executable
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

EXPOSE 6432

USER nobody

ENTRYPOINT ["/entrypoint.sh"]
