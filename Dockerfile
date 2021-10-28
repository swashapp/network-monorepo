FROM node:17-buster as build
WORKDIR /usr/src/monorepo
COPY . .
RUN npm set unsafe-perm true && \
	# explicitly use npm v6
	npm install -g npm@6 && \
	npm ci && \
	npm run bootstrap-pkg streamr-broker && \
	# image contains all packages, remove devDeps to keep image size down
	npx lerna exec -- npm prune --production && \
	# restore inter-package symlinks removed by npm prune
	npx lerna link

FROM node:17-buster
RUN apt-get update && apt-get install --assume-yes --no-install-recommends curl \
	&& apt-get clean \
	&& rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/src/monorepo /usr/src/monorepo
WORKDIR /usr/src/monorepo

ENV LOG_LEVEL=info

RUN ln -s packages/broker/tracker.js tracker.js

EXPOSE 1883/tcp
EXPOSE 7170/tcp
EXPOSE 7171/tcp

WORKDIR /usr/src/monorepo/packages/broker
CMD ./bin/broker.js # start broker from default config
