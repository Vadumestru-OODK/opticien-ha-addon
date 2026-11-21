# Vaste basis met Node.js 24 (bevat SQLite). Bewust niet via BUILD_FROM, zodat
# Home Assistant niet terugvalt op zijn eigen basis zonder Node.js.
FROM node:24-alpine

# Tijdzone, zodat datums in mapnamen en tekstbestanden in Nederlandse tijd zijn
RUN apk add --no-cache tzdata
ENV TZ=Europe/Amsterdam

WORKDIR /app
COPY sync-server.js widget.html run.sh /app/
RUN chmod +x /app/run.sh && sed -i 's/\r$//' /app/run.sh && node --version

CMD [ "/app/run.sh" ]
