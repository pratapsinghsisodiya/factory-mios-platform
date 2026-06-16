FROM eclipse-mosquitto:2.0.20

COPY mosquitto.conf /mosquitto/config/mosquitto.conf
COPY entrypoint.sh /entrypoint.sh

RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh \
  && mkdir -p /mosquitto/data /mosquitto/log /mosquitto/config

EXPOSE 1883

ENTRYPOINT ["/entrypoint.sh"]
