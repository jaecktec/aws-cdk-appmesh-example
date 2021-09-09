FROM node:16 AS build
WORKDIR /srv
ADD client client
ADD gateway gateway
ADD package.json package.json
ADD yarn.lock yarn.lock
RUN yarn install
RUN yarn run bundle

FROM node:16-alpine
RUN apk update && apk update && apk add curl
COPY --from=build /srv/bundle /srv/
ENV PORT=4042
EXPOSE 4042

WORKDIR /srv
CMD ["node", "build/index.js"]
