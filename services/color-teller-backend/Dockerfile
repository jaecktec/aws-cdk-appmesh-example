FROM node:16 AS build
WORKDIR /srv
ADD . .
RUN yarn install

FROM node:16-alpine
RUN apk update && apk update && apk add curl
COPY --from=build /srv/ /srv/
ENV PORT=3000
EXPOSE 3000

WORKDIR /srv
CMD ["node", "index.js"]
